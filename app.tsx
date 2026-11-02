// Floating usage pill: one chip per provider that reports usage to bb
// (Devin, Antigravity and everything else), refreshed on a configurable
// interval. Click opens a popup with every limit window and a refresh
// button. Rendered via the app-wide overlay slot.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalAppOverlayProps } from "@get-bb/plugin-sdk/app";

const ProviderIcon = experimental_ProviderIcon;

interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

interface ProviderEntry {
  key: string;
  providerId: string;
  displayName: string;
  hostName: string | null;
  status: string;
  message: string | null;
  planLabel: string | null;
  windows: UsageWindow[];
  provider: {
    id: string;
    logoUrl?: string | null;
    icon?: { glyph: string } | string | null;
    strings?: { iconTint?: { light: string; dark: string } | null } | null;
  };
}

interface Snapshot {
  providers: ProviderEntry[];
  fetchedAt: number;
  error: string | null;
}

const WEEKLY = /week|7\s*[-‑]?\s*day|7d\b/i;

function remaining(window: UsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

function headline(provider: ProviderEntry): UsageWindow | null {
  return (
    provider.windows.find((window) => WEEKLY.test(window.label)) ??
    provider.windows[0] ??
    null
  );
}

function tone(left: number): string {
  if (left <= 5) return "var(--destructive, #ef4444)";
  if (left <= 20) return "#f59e0b";
  return "var(--foreground, #e4e4e7)";
}

function countdown(resetsAt: string | null): string {
  if (resetsAt === null) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

async function loadSnapshot(sdk: ReturnType<typeof useSdk>): Promise<Snapshot> {
  const providers: ProviderEntry[] = [];
  let error: string | null = null;
  let hosts: Awaited<ReturnType<typeof sdk.hosts.list>> = [];
  try {
    hosts = await sdk.hosts.list();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  await Promise.all(
    hosts
      .filter((host) => host.status !== "disconnected")
      .map(async (host) => {
        try {
          const [list, usage] = await Promise.all([
            sdk.providers.list({ hostId: host.id, capability: "usage" }),
            sdk.system.usageLimits({ hostId: host.id }),
          ]);
          for (const provider of list) {
            const entry = usage[provider.id];
            providers.push({
              key: `${host.id}:${provider.id}`,
              providerId: provider.id,
              displayName: provider.displayName,
              hostName:
                typeof host.name === "string" ? host.name : null,
              status: entry?.status ?? "error",
              message:
                entry?.status === "error" ? (entry.message ?? null) : null,
              planLabel:
                entry && typeof entry.planLabel === "string"
                  ? entry.planLabel
                  : null,
              windows: entry?.status === "ok" ? entry.windows : [],
              provider: {
                id: provider.id,
                logoUrl: provider.logoUrl,
                icon: provider.icon ?? null,
                strings: provider.strings ?? null,
              },
            });
          }
        } catch (cause) {
          error ??= `${host.name ?? host.id}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        }
      }),
  );
  providers.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { providers, fetchedAt: Date.now(), error };
}

function UsagePill(_props: ExperimentalAppOverlayProps) {
  const sdk = useSdk();
  const { values } = useSettings();
  const enabled = values?.overlayEnabled !== false;
  const minutes = Math.max(
    0,
    Number(values?.overlayRefreshMinutes ?? 2) || 0,
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await loadSnapshot(sdk));
    } catch (cause) {
      setSnapshot({
        providers: [],
        fetchedAt: Date.now(),
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [sdk]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (minutes <= 0) return;
    const timer = setInterval(() => void refresh(), minutes * 60_000);
    return () => clearInterval(timer);
  }, [enabled, minutes, refresh]);

  if (!enabled || (snapshot === null && !loading)) return null;

  const chips = snapshot?.providers.filter(
    (provider) => provider.status === "ok" && headline(provider) !== null,
  );

  return (
    <div
      style={{
        position: "fixed",
        right: 14,
        bottom: 14,
        zIndex: 1000,
        fontFamily: "inherit",
        fontSize: 11,
        lineHeight: 1.4,
        color: "var(--foreground, #e4e4e7)",
      }}
    >
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: 32,
            right: 0,
            width: 300,
            maxHeight: "60vh",
            overflowY: "auto",
            background: "var(--popover, var(--card, #18181b))",
            border: "1px solid var(--border, #3f3f46)",
            borderRadius: 10,
            padding: "10px 12px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <strong>Usage</strong>
            <button
              onClick={(event) => {
                event.stopPropagation();
                void refresh();
              }}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 6,
                border: "1px solid var(--border, #3f3f46)",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              {loading ? "…" : "Refresh"}
            </button>
          </div>
          {(snapshot?.providers ?? []).map((provider) => (
            <div key={provider.key} style={{ marginBottom: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontWeight: 600,
                }}
              >
                <ProviderIcon
                  providerKind="agent"
                  provider={provider.provider}
                />
                <span>{provider.displayName}</span>
                {provider.planLabel && (
                  <span style={{ color: "var(--muted-foreground, #a1a1aa)", fontWeight: 400 }}>
                    {provider.planLabel}
                  </span>
                )}
                {provider.hostName && (
                  <span style={{ marginLeft: "auto", color: "var(--muted-foreground, #a1a1aa)", fontWeight: 400 }}>
                    {provider.hostName}
                  </span>
                )}
              </div>
              {provider.status === "ok" ? (
                provider.windows.map((window) => {
                  const left = remaining(window);
                  return (
                    <div
                      key={window.label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        paddingLeft: 18,
                        color: tone(left),
                      }}
                    >
                      <span>{window.label}</span>
                      <span>
                        {left}% left
                        {window.resetsAt ? ` · ${countdown(window.resetsAt)}` : ""}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div
                  style={{
                    paddingLeft: 18,
                    color: "var(--muted-foreground, #a1a1aa)",
                  }}
                >
                  {provider.message ?? provider.status}
                </div>
              )}
            </div>
          ))}
          {snapshot?.error && (
            <div style={{ color: "var(--destructive, #ef4444)" }}>
              {snapshot.error}
            </div>
          )}
          <div
            style={{
              marginTop: 6,
              color: "var(--muted-foreground, #a1a1aa)",
              fontSize: 10,
            }}
          >
            {snapshot
              ? `Updated ${countdown(
                  new Date(snapshot.fetchedAt).toISOString(),
                ) || "just now"} ago`
              : "Loading…"}
            {minutes <= 0 ? " · manual mode" : ` · every ${minutes}m`}
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((value) => !value)}
        title="Provider usage"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "5px 12px",
          borderRadius: 999,
          border: "1px solid var(--border, #3f3f46)",
          background: "color-mix(in srgb, var(--popover, #18181b) 88%, transparent)",
          backdropFilter: "blur(8px)",
          boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
          color: "inherit",
          cursor: "pointer",
        }}
      >
        {chips?.length ? (
          chips.map((provider) => {
            const left = remaining(headline(provider)!);
            return (
              <span
                key={provider.key}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color: tone(left),
                }}
              >
                <ProviderIcon
                  providerKind="agent"
                  provider={provider.provider}
                />
                {left}%
              </span>
            );
          })
        ) : (
          <span>{loading ? "Usage …" : "Usage"}</span>
        )}
      </button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "usage-pill", component: UsagePill });
});
