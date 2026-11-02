// Floating usage pill: one chip per provider that reports usage to bb
// (Devin, Antigravity and everything else), refreshed on a configurable
// interval. Click opens a popup with every limit window and a refresh
// button. Position, orientation, size and cadence are plugin settings,
// editable in a dedicated settings section.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon,
  experimental_usePluginId,
  useRealtimeConnectionState,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalAppOverlayProps,
  PluginSettingsSectionProps,
} from "@get-bb/plugin-sdk/app";

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
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

function ago(fetchedAt: number): string {
  const ms = Date.now() - fetchedAt;
  if (ms < 5_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
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
              hostName: typeof host.name === "string" ? host.name : null,
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
          error ??= `${typeof host.name === "string" ? host.name : host.id}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        }
      }),
  );
  providers.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { providers, fetchedAt: Date.now(), error };
}

// ---------- configuration ----------

const POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
type Position = (typeof POSITIONS)[number];
const ORIENTATIONS = ["horizontal", "vertical"] as const;
type Orientation = (typeof ORIENTATIONS)[number];
const SIZES = ["compact", "comfortable", "large"] as const;
type Size = (typeof SIZES)[number];

interface OverlayConfig {
  enabled: boolean;
  minutes: number;
  position: Position;
  orientation: Orientation;
  size: Size;
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function useOverlayConfig(): OverlayConfig {
  const { values } = useSettings();
  return {
    enabled: values?.overlayEnabled !== false,
    minutes: Math.max(0, Number(values?.overlayRefreshMinutes ?? 2) || 0),
    position: pick(values?.overlayPosition, POSITIONS, "bottom-right"),
    orientation: pick(values?.overlayOrientation, ORIENTATIONS, "horizontal"),
    size: pick(values?.overlaySize, SIZES, "comfortable"),
  };
}

const SCALE: Record<
  Size,
  { font: number; gap: number; pad: string; icon: string; showName: boolean }
> = {
  compact: { font: 10, gap: 5, pad: "3px 8px", icon: "size-2.5", showName: false },
  comfortable: { font: 11, gap: 8, pad: "5px 12px", icon: "size-3", showName: false },
  large: { font: 13, gap: 10, pad: "7px 16px", icon: "size-3.5", showName: true },
};

function positionStyle(position: Position): React.CSSProperties {
  const base: React.CSSProperties = { position: "fixed", zIndex: 1000 };
  switch (position) {
    case "top-left":
      return { ...base, top: 12, left: 12 };
    case "top-center":
      return { ...base, top: 12, left: "50%", transform: "translateX(-50%)" };
    case "top-right":
      return { ...base, top: 12, right: 12 };
    case "bottom-left":
      return { ...base, bottom: 12, left: 12 };
    case "bottom-center":
      return { ...base, bottom: 12, left: "50%", transform: "translateX(-50%)" };
    default:
      return { ...base, bottom: 12, right: 12 };
  }
}

function popupStyle(position: Position): React.CSSProperties {
  const style: React.CSSProperties = {
    position: "absolute",
    width: 300,
    maxHeight: "60vh",
    overflowY: "auto",
    background: "var(--popover, var(--card, #18181b))",
    border: "1px solid var(--border, #3f3f46)",
    borderRadius: 10,
    padding: "10px 12px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    zIndex: 1001,
  };
  if (position.startsWith("top")) style.top = "calc(100% + 8px)";
  else style.bottom = "calc(100% + 8px)";
  if (position.endsWith("left")) style.left = 0;
  else if (position.endsWith("center")) {
    style.left = "50%";
    style.transform = "translateX(-50%)";
  } else style.right = 0;
  return style;
}

// ---------- memoized pieces ----------

const Chip = memo(function Chip({
  provider,
  scale,
}: {
  provider: ProviderEntry;
  scale: (typeof SCALE)[Size];
}) {
  const window = headline(provider);
  if (window === null) return null;
  const left = remaining(window);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        color: tone(left),
        whiteSpace: "nowrap",
      }}
      title={`${provider.displayName} · ${window.label}: ${left}% left${
        window.resetsAt ? ` · resets in ${countdown(window.resetsAt)}` : ""
      }`}
    >
      <ProviderIcon
        providerKind="agent"
        provider={provider.provider}
        className={scale.icon}
      />
      {scale.showName && <span>{provider.displayName}</span>}
      {left}%
    </span>
  );
});

const ProviderRows = memo(function ProviderRows({
  provider,
}: {
  provider: ProviderEntry;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}
      >
        <ProviderIcon providerKind="agent" provider={provider.provider} />
        <span>{provider.displayName}</span>
        {provider.planLabel && (
          <span
            style={{
              color: "var(--muted-foreground, #a1a1aa)",
              fontWeight: 400,
            }}
          >
            {provider.planLabel}
          </span>
        )}
        {provider.hostName && (
          <span
            style={{
              marginLeft: "auto",
              color: "var(--muted-foreground, #a1a1aa)",
              fontWeight: 400,
            }}
          >
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
  );
});

// ---------- the overlay ----------

function UsagePill(_props: ExperimentalAppOverlayProps) {
  const sdk = useSdk();
  const config = useOverlayConfig();
  const connection = useRealtimeConnectionState();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inFlight = useRef(false);
  const lastFetch = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await loadSnapshot(sdk);
      lastFetch.current = next.fetchedAt;
      setSnapshot(next);
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

  const intervalMs = config.minutes * 60_000;
  const stale = useCallback(
    () => Date.now() - lastFetch.current >= intervalMs,
    [intervalMs],
  );

  // Poll only while the window is visible; re-fetch on focus when stale.
  useEffect(() => {
    if (!config.enabled) return;
    if (!document.hidden) void refresh();
    const onVisible = () => {
      if (!document.hidden && stale()) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (intervalMs <= 0) {
      return () => document.removeEventListener("visibilitychange", onVisible);
    }
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [config.enabled, intervalMs, refresh, stale]);

  // Recover after a dropped realtime connection.
  useEffect(() => {
    if (config.enabled && connection === "connected" && stale())
      void refresh();
  }, [config.enabled, connection, refresh, stale]);

  if (!config.enabled) return null;
  if (snapshot === null && !loading) return null;

  const scale = SCALE[config.size];
  const chips = snapshot?.providers.filter(
    (provider) => provider.status === "ok" && headline(provider) !== null,
  );

  return (
    <div
      style={{
        ...positionStyle(config.position),
        fontFamily: "inherit",
        fontSize: scale.font,
        lineHeight: 1.4,
        color: "var(--foreground, #e4e4e7)",
      }}
    >
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1000 }}
        />
      )}
      {open && (
        <div style={popupStyle(config.position)} role="dialog">
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
              onClick={() => void refresh()}
              style={{
                fontSize: scale.font,
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
            <ProviderRows key={provider.key} provider={provider} />
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
              fontSize: scale.font - 1,
            }}
          >
            {snapshot ? `Updated ${ago(snapshot.fetchedAt)}` : "Loading…"}
            {config.minutes <= 0
              ? " · manual mode"
              : ` · every ${config.minutes}m`}
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((value) => !value)}
        title="Provider usage"
        style={{
          display: "flex",
          flexDirection: config.orientation === "vertical" ? "column" : "row",
          alignItems: "center",
          gap: scale.gap,
          padding: scale.pad,
          borderRadius: 999,
          border: "1px solid var(--border, #3f3f46)",
          background:
            "color-mix(in srgb, var(--popover, #18181b) 88%, transparent)",
          backdropFilter: "blur(8px)",
          boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
          color: "inherit",
          cursor: "pointer",
          fontSize: scale.font,
        }}
      >
        {chips?.length ? (
          chips.map((provider) => (
            <Chip key={provider.key} provider={provider} scale={scale} />
          ))
        ) : (
          <span>{loading ? "Usage …" : "Usage"}</span>
        )}
      </button>
    </div>
  );
}

// ---------- settings section ----------

const SETTING_LABEL = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--foreground, #e4e4e7)",
} satisfies React.CSSProperties;

const SETTING_HINT = {
  fontSize: 11,
  color: "var(--muted-foreground, #a1a1aa)",
} satisfies React.CSSProperties;

function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 2,
        borderRadius: 8,
        border: "1px solid var(--border, #3f3f46)",
        background: "var(--muted, rgba(255,255,255,0.04))",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 6,
              border: "none",
              cursor: disabled ? "default" : "pointer",
              background: active ? "var(--primary, #3b82f6)" : "transparent",
              color: active ? "var(--primary-foreground, #fff)" : "inherit",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "8px 0",
      }}
    >
      <div>
        <div style={SETTING_LABEL}>{label}</div>
        {hint && <div style={SETTING_HINT}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function UsagePillSettings(_props: PluginSettingsSectionProps) {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const config = useOverlayConfig();
  const [saving, setSaving] = useState(false);

  const set = useCallback(
    async (key: string, value: string | number | boolean) => {
      setSaving(true);
      try {
        await sdk.plugins.updateSettings({
          pluginId,
          values: { [key]: value },
        });
      } finally {
        setSaving(false);
      }
    },
    [sdk, pluginId],
  );

  return (
    <div>
      <SettingRow label="Show usage pill" hint="Floating quota chips over the bb window.">
        <Segmented
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          value={config.enabled ? "on" : "off"}
          onChange={(value) => void set("overlayEnabled", value === "on")}
        />
      </SettingRow>
      <SettingRow
        label="Refresh interval"
        hint="Background polling is skipped while bb is minimized. 0 = manual only."
      >
        <Segmented
          disabled={!config.enabled}
          options={[
            { value: "0", label: "Manual" },
            { value: "2", label: "2m" },
            { value: "5", label: "5m" },
            { value: "15", label: "15m" },
            { value: "30", label: "30m" },
          ]}
          value={String(config.minutes)}
          onChange={(value) => void set("overlayRefreshMinutes", Number(value))}
        />
      </SettingRow>
      <SettingRow label="Position" hint="Corner or edge center of the bb window.">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 34px)",
            gap: 4,
            opacity: config.enabled ? 1 : 0.5,
          }}
        >
          {POSITIONS.map((position) => {
            const active = position === config.position;
            return (
              <button
                key={position}
                disabled={!config.enabled}
                title={position}
                onClick={() => void set("overlayPosition", position)}
                style={{
                  height: 24,
                  borderRadius: 5,
                  border: `1px solid ${
                    active
                      ? "var(--primary, #3b82f6)"
                      : "var(--border, #3f3f46)"
                  }`,
                  background: active
                    ? "var(--primary, #3b82f6)"
                    : "transparent",
                  cursor: config.enabled ? "pointer" : "default",
                }}
              />
            );
          })}
        </div>
      </SettingRow>
      <SettingRow label="Orientation" hint="Lay chips side by side or stacked.">
        <Segmented
          disabled={!config.enabled}
          options={ORIENTATIONS.map((orientation) => ({
            value: orientation,
            label: orientation === "horizontal" ? "Horizontal" : "Vertical",
          }))}
          value={config.orientation}
          onChange={(value) => void set("overlayOrientation", value)}
        />
      </SettingRow>
      <SettingRow label="Size" hint="Compact, comfortable or large chips.">
        <Segmented
          disabled={!config.enabled}
          options={SIZES.map((size) => ({
            value: size,
            label: size[0].toUpperCase() + size.slice(1),
          }))}
          value={config.size}
          onChange={(value) => void set("overlaySize", value)}
        />
      </SettingRow>
      {saving && <div style={SETTING_HINT}>Saving…</div>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "usage-pill", component: UsagePill });
  app.slots.settingsSection({
    id: "usage-pill",
    title: "Usage pill overlay",
    description: "Position, size, orientation and refresh cadence of the floating quota pill.",
    component: UsagePillSettings,
  });
});
