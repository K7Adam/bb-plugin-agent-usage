// Publishes Devin and Antigravity usage to bb's usage panel. The panel only
// reads plugins that serve the discoverable `provider-usage.v1` RPC methods; the
// numbers themselves come from `bb.sdk.system.usageLimits`, which asks each
// provider's bridge (`provider/usage` → the dialect's readUsage in host.ts).
// Adapted from MacHatter1/bb-plugin-grok-build-usage (MIT).

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { isUsageProviderId, PROVIDER_LABELS, USAGE_PROVIDER_IDS, type UsageProviderId } from "./agents.ts";

export const LIST_RESOURCES = "provider-usage.v1.listResources";
export const GET_RESOURCE = "provider-usage.v1.getResource";

/** Background reads reuse a good result this long; agy takes seconds per read. */
export const CACHE_MS = 5 * 60_000;
/** A manual refresh inside this window returns the result it would repeat. */
export const MIN_REFRESH_MS = 30_000;

const accountKey = z.string().min(1).nullable().default(null);
const plan = z.object({ id: z.string().min(1), multiplier: z.number().int().positive().nullable() });
// `usageLimits` returns a bare `{ status }` for not_installed, unauthenticated
// and expired; the panel requires the account fields on every state.
const account = {
  plan: plan.nullable().default(null),
  accountEmail: z.string().nullable().default(null),
  planLabel: z.string().nullable().default(null),
};
const windowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]).default("custom"),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).nullable(),
});
const usageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), ...account, windows: z.array(windowSchema) }),
  z.object({ status: z.literal("not_installed"), ...account }),
  z.object({ status: z.literal("unauthenticated"), ...account }),
  z.object({ status: z.literal("expired"), ...account }),
  z.object({ status: z.literal("error"), ...account, message: z.string() }),
]);
const resourceSchema = z.object({
  accountKey,
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
  ]),
});
const observationSchema = z.object({
  accountKey,
  observedAt: z.number().int().nonnegative().nullable(),
  usage: usageSchema,
});

export const usageSourceContract = defineRpcContract({
  [LIST_RESOURCES]: {
    input: z.object({}),
    output: z.object({ label: z.string().min(1).optional(), resources: z.array(resourceSchema) }),
  },
  [GET_RESOURCE]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: observationSchema,
  },
});

type Observation = z.infer<typeof observationSchema>;

// Resource ids are `[hostId, providerId]`, matching bb's built-in ACP source.
export function resourceIdFor(hostId: string, providerId: UsageProviderId): string {
  return JSON.stringify([hostId, providerId]);
}

function parseResourceId(resourceId: string): { hostId: string; providerId: UsageProviderId } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resourceId);
  } catch {
    parsed = null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !isUsageProviderId(parsed[1])
  ) {
    throw new Error("Usage resource no longer exists.");
  }
  return { hostId: parsed[0], providerId: parsed[1] };
}

export function registerUsageSource(bb: BbPluginApi, now: () => number = Date.now): void {
  const cache = new Map<string, Observation>();
  const inFlight = new Map<string, Promise<Observation>>();

  async function usageProviders(hostId: string): Promise<Set<string>> {
    const providers = await bb.sdk.providers.list({ hostId, capability: "usage" });
    return new Set(providers.map((provider) => provider.id));
  }

  async function collect(resourceId: string, refresh: boolean): Promise<Observation> {
    const { hostId, providerId } = parseResourceId(resourceId);
    const host = (await bb.sdk.hosts.list()).find((entry) => entry.id === hostId);
    if (host === undefined || !(await usageProviders(hostId)).has(providerId)) {
      throw new Error("Usage resource no longer exists.");
    }

    const previous = cache.get(resourceId);
    const unavailable = (message: string): Observation => ({
      accountKey: previous?.accountKey ?? null,
      observedAt: previous?.observedAt ?? null,
      usage: { status: "error", plan: null, accountEmail: null, planLabel: null, message },
    });
    if (host.status === "disconnected") return unavailable("Machine is disconnected.");

    const age = previous?.usage.status === "ok" && previous.observedAt !== null ? now() - previous.observedAt : Infinity;
    if (age < (refresh ? MIN_REFRESH_MS : CACHE_MS)) return previous as Observation;

    try {
      const limits = await bb.sdk.system.usageLimits({ hostId, providerId });
      const usage = limits[providerId];
      if (usage === undefined) throw new Error("Provider returned no usage information.");
      const observation = observationSchema.parse({
        accountKey: null,
        observedAt: usage.status === "ok" ? now() : (previous?.observedAt ?? null),
        usage: {
          ...usage,
          ...(usage.status === "ok"
            ? {
                windows: usage.windows.map((window, index) => {
                  const loose = window as { id?: unknown; kind?: unknown; model?: unknown };
                  return {
                    ...window,
                    id: typeof loose.id === "string" && loose.id !== "" ? loose.id : `${index}:${window.label}`,
                    kind: windowSchema.shape.kind.catch("custom").parse(loose.kind),
                    model: windowSchema.shape.model.catch(null).parse(loose.model ?? null),
                    cost: window.cost ?? null,
                  };
                }),
              }
            : {}),
        },
      });
      cache.set(resourceId, observation);
      return observation;
    } catch {
      return unavailable("Usage could not be collected from this machine.");
    }
  }

  bb.rpc.register(
    usageSourceContract,
    {
      async [LIST_RESOURCES]() {
        const hosts = await bb.sdk.hosts.list();
        const perHost = await Promise.all(
          hosts.map(async (host) => {
            const available = await usageProviders(host.id);
            return USAGE_PROVIDER_IDS.filter((providerId) => available.has(providerId)).map((providerId) => {
              const id = resourceIdFor(host.id, providerId);
              return {
                accountKey: cache.get(id)?.accountKey ?? null,
                id,
                providerId,
                label: PROVIDER_LABELS[providerId],
                scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
              };
            });
          }),
        );
        const resources = perHost.flat();
        const live = new Set(resources.map((resource) => resource.id));
        for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
        return { resources };
      },
      async [GET_RESOURCE]({ resourceId, refresh }) {
        // Coalesce concurrent reads; a forced refresh waits out a pending one.
        const pending = inFlight.get(resourceId);
        if (pending !== undefined) {
          const result = await pending.catch(() => undefined);
          if (result !== undefined && !refresh) return result;
        }
        const request = collect(resourceId, refresh).finally(() => {
          if (inFlight.get(resourceId) === request) inFlight.delete(resourceId);
        });
        inFlight.set(resourceId, request);
        return request;
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: "Host-local Devin and Google Antigravity usage from the agent-usage plugin.",
    },
  );
}
