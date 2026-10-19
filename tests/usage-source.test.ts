import assert from "node:assert/strict";
import test from "node:test";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { CACHE_MS, GET_RESOURCE, LIST_RESOURCES, MIN_REFRESH_MS, registerUsageSource, resourceIdFor } from "../src/usage-source.ts";

type Handlers = Record<string, (input: never) => Promise<unknown>>;

function setup(usage: Record<string, unknown>, providerIds = ["devin-cli", "antigravity-cli", "codex"]) {
  let handlers: Handlers = {};
  let options: unknown;
  const calls: unknown[] = [];
  let clock = 1_000_000;
  const bb = {
    rpc: {
      register(_contract: unknown, registered: Handlers, opts: unknown) {
        handlers = registered;
        options = opts;
      },
    },
    sdk: {
      hosts: { list: async () => [{ id: "host_1", name: "OMEN", status: "connected" }] },
      providers: { list: async () => providerIds.map((id) => ({ id })) },
      system: {
        usageLimits: async (args: { providerId: string }) => {
          calls.push(args);
          return { [args.providerId]: usage[args.providerId] };
        },
      },
    },
  } as unknown as BbPluginApi;
  registerUsageSource(bb, () => clock);
  return { handlers, options, calls, advance: (ms: number) => (clock += ms) };
}

const devinOk = {
  status: "ok",
  accountEmail: null,
  planLabel: "Pro",
  windows: [{ id: "daily", label: "Daily quota", usedPercent: 66, resetsAt: null, kind: "daily", model: null }],
};

const get = (handlers: Handlers, providerId: "devin-cli" | "antigravity-cli", refresh: boolean) =>
  handlers[GET_RESOURCE]({ resourceId: resourceIdFor("host_1", providerId), refresh } as never) as Promise<{
    usage: { status: string; planLabel: string | null; windows?: { id: string; kind: string; usedPercent: number }[] };
  }>;

test("registers as a discoverable usage source", () => {
  const { options } = setup({});
  assert.equal((options as { experimental_discoverable: boolean }).experimental_discoverable, true);
});

test("lists one resource per provider of this plugin on each host", async () => {
  const { handlers } = setup({});
  const result = (await handlers[LIST_RESOURCES]({} as never)) as { resources: { providerId: string; label: string }[] };
  assert.deepEqual(
    result.resources.map((resource) => [resource.providerId, resource.label]),
    [
      ["devin-cli", "Devin"],
      ["antigravity-cli", "Google Antigravity"],
    ],
  );
});

test("lists nothing for providers without usage capability", async () => {
  const { handlers } = setup({}, ["codex"]);
  const result = (await handlers[LIST_RESOURCES]({} as never)) as { resources: unknown[] };
  assert.deepEqual(result.resources, []);
});

test("keeps window kind and id from the bridge", async () => {
  const { handlers } = setup({ "devin-cli": devinOk });
  const result = await get(handlers, "devin-cli", true);
  assert.equal(result.usage.status, "ok");
  assert.deepEqual(result.usage.windows?.map((window) => [window.id, window.kind, window.usedPercent]), [["daily", "daily", 66]]);
});

test("fills account fields for bare statuses", async () => {
  const { handlers } = setup({ "antigravity-cli": { status: "unauthenticated" } });
  const result = await get(handlers, "antigravity-cli", true);
  assert.equal(result.usage.status, "unauthenticated");
  assert.equal(result.usage.planLabel, null);
});

test("caches good results for five minutes and throttles manual refreshes", async () => {
  const { handlers, calls, advance } = setup({ "devin-cli": devinOk });
  await get(handlers, "devin-cli", false);
  advance(CACHE_MS - 1);
  await get(handlers, "devin-cli", false);
  assert.equal(calls.length, 1);
  advance(2);
  await get(handlers, "devin-cli", false);
  assert.equal(calls.length, 2);
  await get(handlers, "devin-cli", true);
  assert.equal(calls.length, 2);
  advance(MIN_REFRESH_MS);
  await get(handlers, "devin-cli", true);
  assert.equal(calls.length, 3);
});

test("rejects resources of other providers", async () => {
  const { handlers } = setup({});
  await assert.rejects(handlers[GET_RESOURCE]({ resourceId: JSON.stringify(["host_1", "codex"]), refresh: true } as never));
});
