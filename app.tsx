// Floating usage pill: one chip per provider that reports usage to bb
// (Devin, Antigravity and everything else), refreshed on a configurable
// interval. Click opens a popup with every limit window and a refresh
// button. Position, orientation, size and cadence are plugin settings,
// edited in a settings section with a live, interactive preview.
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
  cost?: { usedUsdCents: number; limitUsdCents: number } | null;
}

interface ProviderEntry {
  key: string;
  providerId: string;
  displayName: string;
  hostName: string | null;
  status: string;
  message: string | null;
  planLabel: string | null;
  accountEmail: string | null;
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

const HEADLINES = ["weekly", "tightest", "first"] as const;
type Headline = (typeof HEADLINES)[number];

function headline(
  provider: ProviderEntry,
  mode: Headline = "weekly",
): UsageWindow | null {
  if (mode === "first") return provider.windows[0] ?? null;
  if (mode === "tightest") {
    let best: UsageWindow | null = null;
    for (const window of provider.windows) {
      if (best === null || remaining(window) < remaining(best)) best = window;
    }
    return best;
  }
  return (
    provider.windows.find((window) => WEEKLY.test(window.label)) ??
    provider.windows[0] ??
    null
  );
}

const COLOR_MODES = ["adaptive", "monochrome", "severity"] as const;
type ColorMode = (typeof COLOR_MODES)[number];

function tone(
  left: number,
  cfg: {
    colorMode: ColorMode;
    warnBelow: number;
    critBelow: number;
  },
): string {
  if (cfg.colorMode === "monochrome")
    return "var(--foreground, #e4e4e7)";
  if (left <= cfg.critBelow) return "var(--destructive, #ef4444)";
  if (left <= cfg.warnBelow) return "#f59e0b";
  return cfg.colorMode === "adaptive"
    ? "#34d399"
    : "var(--foreground, #e4e4e7)";
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

/** Compact reset text like the built-in panel: "4h 39m", "6d 11h", "—". */
function resetShort(resetsAt: string | null): string {
  if (resetsAt === null) return "—";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** Long reset text for the expanded row, like the built-in panel. */
function resetLong(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "Resetting now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `Resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0
      ? `Resets in ${hours} hr`
      : `Resets in ${hours} hr ${rest} min`;
  }
  const withinWeek = ms < 10080 * 6e4;
  return `Resets ${date.toLocaleString(undefined, {
    weekday: withinWeek ? "short" : undefined,
    month: withinWeek ? undefined : "short",
    day: withinWeek ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/** Shorten window labels like the built-in panel ("Weekly · X" → "7d · X"). */
function shortLabel(label: string): string {
  const parts = label.split("·").map((part) => part.trim()).filter(Boolean);
  const abbrev = (part: string): string | null => {
    if (/^(five[- ]?hour|5[- ]?h(ours?)?)\b/i.test(part)) return "5h";
    if (/^(week|7[- ]?d(ays?)?)\b/i.test(part)) return "7d";
    if (/^(dail|1[- ]?d(ay)?)\b/i.test(part)) return "1d";
    if (/^month/i.test(part)) return "Monthly";
    return null;
  };
  const normalized = parts.map((part) => abbrev(part) ?? part);
  // Put the duration first ("Gemini Models · Weekly" → "7d · Gemini Models")
  const durationIndex = normalized.findIndex((part, index) =>
    abbrev(parts[index]) !== null,
  );
  if (durationIndex > 0) {
    const [duration] = normalized.splice(durationIndex, 1);
    normalized.unshift(duration);
  }
  return normalized.join(" · ");
}

/** Bar fill / percent colour, mirroring the built-in panel thresholds. */
function usedTone(
  usedPercent: number,
  cfg: OverlayConfig,
): string {
  const left = 100 - usedPercent;
  if (left <= cfg.critBelow) return "var(--destructive, #ef4444)";
  if (left <= cfg.warnBelow) return "var(--warning, #f59e0b)";
  if (cfg.colorMode === "adaptive")
    return "var(--primary, #fafafa)";
  return "var(--foreground, #fafafa)";
}

function severity(
  provider: ProviderEntry,
): "critical" | "warning" | null {
  if (provider.status !== "ok") return null;
  const worst = Math.max(0, ...provider.windows.map((w) => w.usedPercent));
  if (worst >= 95) return "critical";
  if (worst >= 80) return "warning";
  return null;
}

function usd(cents: number, whole: boolean): string {
  const amount = cents / 100;
  return `$${whole ? amount.toFixed(0) : amount.toFixed(2)}`;
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
              accountEmail:
                entry && typeof entry.accountEmail === "string"
                  ? entry.accountEmail
                  : null,
              windows:
                entry?.status === "ok"
                  ? entry.windows.map((window) => ({
                      ...window,
                      cost:
                        window.cost &&
                        typeof window.cost.usedUsdCents === "number"
                          ? {
                              usedUsdCents: window.cost.usedUsdCents,
                              limitUsdCents:
                                typeof window.cost.limitUsdCents === "number"
                                  ? window.cost.limitUsdCents
                                  : 0,
                            }
                          : null,
                    }))
                  : [],
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

const ICON_MODES = ["icon", "dot", "none"] as const;
type IconMode = (typeof ICON_MODES)[number];

interface OverlayConfig {
  enabled: boolean;
  minutes: number;
  position: Position;
  orientation: Orientation;
  size: Size;
  colorMode: ColorMode;
  iconMode: IconMode;
  showPercent: boolean;
  headlineMode: Headline;
  warnBelow: number;
  critBelow: number;
  opacity: number;
  providers: ReadonlySet<string> | null;
  pulseCritical: boolean;
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function useOverlayConfig(): OverlayConfig {
  const { values } = useSettings();
  const csv =
    typeof values?.overlayProviders === "string"
      ? values.overlayProviders.trim()
      : "";
  return {
    enabled: values?.overlayEnabled !== false,
    minutes: Math.max(0, Number(values?.overlayRefreshMinutes ?? 2) || 0),
    position: pick(values?.overlayPosition, POSITIONS, "bottom-right"),
    orientation: pick(values?.overlayOrientation, ORIENTATIONS, "horizontal"),
    size: pick(values?.overlaySize, SIZES, "comfortable"),
    colorMode: pick(values?.overlayColorMode, COLOR_MODES, "adaptive"),
    iconMode: pick(values?.overlayIconMode, ICON_MODES, "icon"),
    showPercent: values?.overlayShowPercent === true,
    headlineMode: pick(values?.overlayHeadline, HEADLINES, "weekly"),
    warnBelow: Number(values?.overlayWarnBelow ?? 20) || 20,
    critBelow: Number(values?.overlayCritBelow ?? 5) || 5,
    opacity: Math.min(100, Math.max(20, Number(values?.overlayOpacity ?? 100) || 100)),
    providers: csv === "" ? null : new Set(csv.split(",").map((id) => id.trim()).filter(Boolean)),
    pulseCritical: values?.overlayPulseCritical === true,
  };
}

const SCALE: Record<
  Size,
  {
    font: number;
    gap: number;
    pad: string;
    ring: number;
    stroke: number;
    icon: string;
    showName: boolean;
  }
> = {
  compact: { font: 10, gap: 4, pad: "4px 7px", ring: 16, stroke: 1.7, icon: "size-2", showName: false },
  comfortable: { font: 11, gap: 6, pad: "5px 10px", ring: 18, stroke: 1.8, icon: "size-2.5", showName: false },
  large: { font: 12, gap: 7, pad: "6px 12px", ring: 22, stroke: 2, icon: "size-3", showName: true },
};

const RING_CIRC = 2 * Math.PI * 10;

function UsageRing({
  left,
  color,
  size,
  stroke,
  children,
}: {
  left: number;
  color: string;
  size: number;
  stroke: number;
  children?: React.ReactNode;
}) {
  return (
    <span
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        className="absolute inset-0 -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.15"
          strokeWidth={stroke}
        />
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={RING_CIRC}
          strokeDashoffset={RING_CIRC * (1 - left / 100)}
        />
      </svg>
      {children}
    </span>
  );
}

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
  cfg,
}: {
  provider: ProviderEntry;
  scale: (typeof SCALE)[Size];
  cfg: OverlayConfig;
}) {
  const window = headline(provider, cfg.headlineMode);
  if (window === null) return null;
  const left = remaining(window);
  const color = tone(left, cfg);
  const critical = cfg.pulseCritical && left <= cfg.critBelow;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full p-0.5 transition-colors hover:bg-muted/60 ${
        critical ? "animate-pulse" : ""
      }`}
      title={`${provider.displayName} · ${window.label}: ${left}% left${
        window.resetsAt ? ` · resets in ${countdown(window.resetsAt)}` : ""
      }`}
    >
      <UsageRing left={left} color={color} size={scale.ring} stroke={scale.stroke}>
        {cfg.iconMode === "icon" && (
          <ProviderIcon
            providerKind="agent"
            provider={provider.provider}
            className={scale.icon}
          />
        )}
        {cfg.iconMode === "dot" && (
          <span
            className="size-1 rounded-full"
            style={{ background: color }}
          />
        )}
      </UsageRing>
      {scale.showName && (
        <span className="text-muted-foreground">{provider.displayName}</span>
      )}
      {(scale.showName || cfg.showPercent) && (
        <span style={{ color }}>{left}%</span>
      )}
    </span>
  );
});

/** One limit window, styled after the built-in panel: label | bar | % | reset.
 * Rows span the shared outer grid so columns align across providers. */
const WindowRow = memo(function WindowRow({
  window,
  cfg,
}: {
  window: UsageWindow;
  cfg: OverlayConfig;
}) {
  const [expanded, setExpanded] = useState(false);
  const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  const color = usedTone(used, cfg);
  const long = expanded ? resetLong(window.resetsAt) : null;
  const cost =
    window.cost != null
      ? `${usd(window.cost.usedUsdCents, true)} / ${usd(window.cost.limitUsdCents, false)}`
      : `${used}% used`;
  return (
    <button
      type="button"
      className="col-span-full grid grid-cols-subgrid rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      title={`${window.label} · ${resetLong(window.resetsAt) ?? "Reset time not reported"}`}
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <span className="col-span-full grid h-5 grid-cols-subgrid items-center text-2xs">
        <span className="max-w-20 truncate text-muted-foreground">
          {shortLabel(window.label)}
        </span>
        <span className="h-1 min-w-0 overflow-hidden rounded-full bg-border/70">
          <span
            className="block h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${Math.max(2, Math.min(100, used))}%`,
              background: color,
            }}
          />
        </span>
        <span className="text-right tabular-nums" style={{ color }}>
          {used}%
        </span>
        <span
          aria-hidden="true"
          className="min-w-9 text-right tabular-nums text-muted-foreground"
        >
          {resetShort(window.resetsAt)}
        </span>
      </span>
      {expanded && (
        <span className="col-span-full pb-1 text-2xs text-muted-foreground">
          {window.label} · {long ?? "Reset time not reported."} · {cost}
        </span>
      )}
    </button>
  );
});

function statusText(provider: ProviderEntry): string {
  switch (provider.status) {
    case "not_installed":
      return "Not installed on this machine.";
    case "unauthenticated":
      return "Not signed in.";
    case "expired":
      return "Session expired — sign in again.";
    case "error":
      return provider.message ?? "Usage could not be read.";
    default:
      return "Usage not reported.";
  }
}

/** Provider section styled after the built-in panel: icon + account + plan
 * badge on one h-5 row, then a shared grid of window rows. */
const ProviderRows = memo(function ProviderRows({
  provider,
  cfg,
  showProvider,
  showHost,
}: {
  provider: ProviderEntry;
  cfg: OverlayConfig;
  showProvider: boolean;
  showHost: boolean;
}) {
  const label = provider.accountEmail ?? provider.displayName;
  return (
    <section
      aria-label={showProvider ? `${provider.displayName} ${label}` : label}
      className="col-span-full grid grid-cols-subgrid py-1 first:pt-0 last:pb-0"
    >
      <div className="col-span-full flex h-5 min-w-0 items-center gap-1.5">
        {showProvider && (
          <ProviderIcon
            providerKind="agent"
            provider={provider.provider}
            className="size-3 shrink-0"
          />
        )}
        <h3
          title={label}
          className="min-w-0 flex-1 truncate text-2xs font-medium text-foreground"
        >
          {label}
        </h3>
        {showHost && provider.hostName && (
          <span className="shrink-0 truncate text-2xs text-muted-foreground">
            {provider.hostName}
          </span>
        )}
        {provider.planLabel && (
          <span className="shrink-0 rounded-sm bg-border/60 px-1 py-0.5 text-2xs leading-none text-muted-foreground">
            {provider.planLabel}
          </span>
        )}
      </div>
      {provider.status === "ok" ? (
        provider.windows.length > 0 ? (
          provider.windows.map((window) => (
            <WindowRow key={window.label} window={window} cfg={cfg} />
          ))
        ) : (
          <p className="col-span-full text-2xs text-muted-foreground">
            No usage limits reported for this plan.
          </p>
        )
      ) : (
        <p className="col-span-full text-2xs text-muted-foreground">
          {statusText(provider)}
        </p>
      )}
    </section>
  );
});

function RotateCcw({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`size-3.5 ${spinning ? "animate-spin" : ""}`}
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// ---------- the overlay ----------

function UsagePill(_props: ExperimentalAppOverlayProps) {
  const sdk = useSdk();
  const config = useOverlayConfig();
  const connection = useRealtimeConnectionState();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
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
  const allProviders = snapshot?.providers ?? [];
  const chips = allProviders.filter(
    (provider) =>
      provider.status === "ok" &&
      headline(provider, config.headlineMode) !== null &&
      (config.providers === null || config.providers.has(provider.providerId)),
  );

  // Popup tab model: one tab per unique providerId (like the built-in panel).
  const seen = new Map<
    string,
    {
      providerId: string;
      displayName: string;
      provider: ProviderEntry["provider"];
      severity: "critical" | "warning" | null;
    }
  >();
  for (const provider of allProviders) {
    const found = seen.get(provider.providerId);
    const sev = severity(provider);
    const rank = sev === "critical" ? 2 : sev === "warning" ? 1 : 0;
    if (!found) {
      seen.set(provider.providerId, {
        providerId: provider.providerId,
        displayName: provider.displayName,
        provider: provider.provider,
        severity: sev,
      });
    } else {
      const old = found.severity === "critical" ? 2 : found.severity === "warning" ? 1 : 0;
      if (rank > old) found.severity = sev;
    }
  }
  const uniqueProviders = [...seen.values()];
  const multiHost =
    new Set(
      allProviders.map((provider) => provider.hostName ?? provider.key),
    ).size > 1;
  const hostLabel =
    [...new Set(allProviders.map((provider) => provider.hostName))]
      .filter(Boolean)
      .join(" · ") || null;
  const visibleProviders =
    tab === null
      ? allProviders
      : allProviders.filter((provider) => provider.providerId === tab);

  return (
    <div
      className="text-foreground"
      style={{ ...positionStyle(config.position), fontSize: scale.font }}
    >
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1000 }}
        />
      )}
      {open && (
        <div
          role="dialog"
          className="overflow-hidden rounded-[10px] border border-border bg-popover shadow-xl"
          style={popupStyle(config.position)}
        >
          {/* toolbar — provider tabs like the built-in panel */}
          <div className="flex h-9 min-w-0 items-center gap-1 border-b border-border/60 px-1.5">
            {uniqueProviders.length < 2 ? (
              <span className="px-1.5 text-2xs font-medium">Usage</span>
            ) : (
              <div
                role="tablist"
                aria-label="Usage provider"
                className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto"
              >
                <button
                  type="button"
                  role="tab"
                  title="All accounts"
                  aria-selected={tab === null}
                  onClick={() => setTab(null)}
                  className={`relative flex h-6 shrink-0 items-center justify-center rounded-md px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    tab === null
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="text-2xs font-medium">All</span>
                </button>
                {uniqueProviders.map((provider) => {
                  const selected = provider.providerId === tab;
                  const sev = provider.severity;
                  return (
                    <button
                      key={provider.providerId}
                      type="button"
                      role="tab"
                      title={
                        sev === null
                          ? provider.displayName
                          : `${provider.displayName}: an account usage window is at least ${
                              sev === "critical" ? "95" : "80"
                            }% used.`
                      }
                      aria-label={provider.displayName}
                      aria-selected={selected}
                      onClick={() =>
                        setTab(selected ? null : provider.providerId)
                      }
                      className={`group/tab relative flex h-6 w-7 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        selected
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <ProviderIcon
                        providerKind="agent"
                        provider={provider.provider}
                        className={`size-3.5 ${
                          selected
                            ? ""
                            : "opacity-60 group-hover/tab:opacity-100"
                        }`}
                      />
                      {sev !== null && !selected && tab !== null && (
                        <span
                          aria-hidden="true"
                          className="absolute right-0.5 top-0.5 size-1.5 rounded-full ring-2 ring-popover"
                          style={{
                            background:
                              sev === "critical"
                                ? "var(--destructive, #ef4444)"
                                : "var(--warning, #f59e0b)",
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <span className="min-w-0 flex-1" />
            {multiHost && (
              <span className="min-w-0 shrink truncate text-2xs text-muted-foreground">
                {tab === null ? "All hosts" : hostLabel}
              </span>
            )}
            <button
              type="button"
              aria-label="Reload provider usage"
              title="Refresh now"
              disabled={loading}
              onClick={() => void refresh()}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <RotateCcw spinning={loading} />
            </button>
            <button
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => setOpen(false)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown />
            </button>
          </div>
          {/* body — one shared grid so columns align across providers */}
          <div className="grid max-h-[55vh] grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-2 overflow-y-auto px-2 py-1.5">
            {visibleProviders.map((provider) => (
              <ProviderRows
                key={provider.key}
                provider={provider}
                cfg={config}
                showProvider={tab === null}
                showHost={multiHost}
              />
            ))}
            {visibleProviders.length === 0 && (
              <p className="col-span-full py-2 text-2xs text-muted-foreground">
                {loading ? "Loading usage…" : "No providers report usage."}
              </p>
            )}
            {snapshot?.error && (
              <p className="col-span-full py-1 text-2xs text-destructive">
                {snapshot.error}
              </p>
            )}
          </div>
          {/* footer */}
          <div className="border-t border-border/60 px-2.5 py-1.5 text-2xs text-muted-foreground">
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
        className={`flex items-center border border-border/70 shadow-md backdrop-blur-xl ${
          config.orientation === "vertical" ? "rounded-2xl" : "rounded-full"
        }`}
        style={{
          flexDirection: config.orientation === "vertical" ? "column" : "row",
          gap: scale.gap,
          padding: scale.pad,
          background:
            "color-mix(in srgb, var(--popover, #18181b) 88%, transparent)",
          color: "inherit",
          cursor: "pointer",
          fontSize: scale.font,
          opacity: config.opacity / 100,
        }}
      >
        {chips?.length ? (
          chips.map((provider) => (
            <Chip
              key={provider.key}
              provider={provider}
              scale={scale}
              cfg={config}
            />
          ))
        ) : (
          <span>{loading ? "Usage …" : "Usage"}</span>
        )}
      </button>
    </div>
  );
}

// ---------- settings section ----------

function useWriteSetting() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const [saving, setSaving] = useState(false);
  const set = useCallback(
    async (key: string, value: string | number | boolean) => {
      setSaving(true);
      try {
        await sdk.plugins.updateSettings({ pluginId, values: { [key]: value } });
      } finally {
        setSaving(false);
      }
    },
    [sdk, pluginId],
  );
  return { set, saving };
}

/** WYSIWYG preview: a miniature bb window; the mock pill sits at the
 * configured anchor and glides when it changes. Clicking a zone moves it. */
function PositionPreview({
  config,
  onPick,
}: {
  config: OverlayConfig;
  onPick: (position: Position) => void;
}) {
  const scale = SCALE[config.size];
  const anchor: Record<Position, React.CSSProperties> = {
    "top-left": { top: "10%", left: "6%" },
    "top-center": { top: "10%", left: "50%", transform: "translateX(-50%)" },
    "top-right": { top: "10%", left: "94%", transform: "translateX(-100%)" },
    "bottom-left": { top: "90%", left: "6%", transform: "translateY(-100%)" },
    "bottom-center": {
      top: "90%",
      left: "50%",
      transform: "translate(-50%,-100%)",
    },
    "bottom-right": {
      top: "90%",
      left: "94%",
      transform: "translate(-100%,-100%)",
    },
  };
  const hotspot: Record<Position, React.CSSProperties> = {
    "top-left": { top: 0, left: 0, width: "34%", height: "50%" },
    "top-center": { top: 0, left: "33%", width: "34%", height: "50%" },
    "top-right": { top: 0, right: 0, width: "34%", height: "50%" },
    "bottom-left": { bottom: 0, left: 0, width: "34%", height: "50%" },
    "bottom-center": { bottom: 0, left: "33%", width: "34%", height: "50%" },
    "bottom-right": { bottom: 0, right: 0, width: "34%", height: "50%" },
  };
  const mockLefts = [85, 15, 3];
  const mockTints = ["#D97757", "#10a37f", "#8b5cf6"];
  return (
    <div className="relative h-44 overflow-hidden rounded-b-xl bg-muted/20">
      {/* fake window chrome */}
      <div className="absolute left-0 top-0 h-full w-9 border-r border-border/60 bg-muted/30" />
      <div className="absolute left-12 right-3 top-3 space-y-1.5">
        <div className="h-1.5 w-3/4 rounded-full bg-muted-foreground/20" />
        <div className="h-1.5 w-1/2 rounded-full bg-muted-foreground/15" />
        <div className="h-1.5 w-2/3 rounded-full bg-muted-foreground/10" />
      </div>
      {/* hotspots */}
      {POSITIONS.map((position) => (
        <button
          key={position}
          title={position}
          onClick={() => onPick(position)}
          className="absolute z-10 rounded-md transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          style={hotspot[position]}
        />
      ))}
      {/* the mock pill */}
      <div
        className="absolute z-20 transition-all duration-300 ease-out"
        style={anchor[config.position]}
      >
        <div
          className="flex items-center rounded-full border border-border bg-popover/90 shadow-md backdrop-blur-sm"
          style={{
            flexDirection:
              config.orientation === "vertical" ? "column" : "row",
            gap: scale.gap,
            padding: scale.pad,
            fontSize: scale.font,
          }}
        >
          {mockLefts.map((left, index) => {
            const color = tone(left, config);
            return (
              <span key={index} className="inline-flex items-center gap-1">
                <UsageRing
                  left={left}
                  color={color}
                  size={scale.ring}
                  stroke={scale.stroke}
                >
                  {config.iconMode !== "none" && (
                    <span
                      className="size-1 rounded-full"
                      style={{
                        background:
                          config.iconMode === "dot"
                            ? color
                            : mockTints[index],
                      }}
                    />
                  )}
                </UsageRing>
                {config.showPercent && (
                  <span style={{ color }}>{left}%</span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Toggle chips for every provider that reports usage — all on = empty list. */
function ProviderFilter({
  config,
  onChange,
}: {
  config: OverlayConfig;
  onChange: (csv: string) => void;
}) {
  const sdk = useSdk();
  const [providers, setProviders] = useState<
    | {
        id: string;
        displayName: string;
        provider: ProviderEntry["provider"];
      }[]
    | null
  >(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const found = new Map<
        string,
        { id: string; displayName: string; provider: ProviderEntry["provider"] }
      >();
      try {
        const hosts = await sdk.hosts.list();
        await Promise.all(
          hosts
            .filter((host) => host.status !== "disconnected")
            .map(async (host) => {
              try {
                const list = await sdk.providers.list({
                  hostId: host.id,
                  capability: "usage",
                });
                for (const provider of list) {
                  if (!found.has(provider.id)) {
                    found.set(provider.id, {
                      id: provider.id,
                      displayName: provider.displayName,
                      provider: {
                        id: provider.id,
                        logoUrl: provider.logoUrl,
                        icon: provider.icon ?? null,
                        strings: provider.strings ?? null,
                      },
                    });
                  }
                }
              } catch {
                // A host that cannot list providers contributes nothing.
              }
            }),
        );
      } catch {
        // hosts.list failed; no filter UI.
      }
      if (live) {
        setProviders(
          [...found.values()].sort((a, b) =>
            a.displayName.localeCompare(b.displayName),
          ),
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [sdk]);

  if (!providers?.length) return null;

  const allIds = providers.map((provider) => provider.id);
  const active = config.providers ?? new Set(allIds);

  const toggle = (id: string) => {
    const next = new Set(active);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next.size === allIds.length ? "" : [...next].join(","));
  };

  return (
    <div>
      <p className="mb-1.5 px-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        Visible providers
      </p>
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-card/40 p-3">
        {providers.map((provider) => {
          const on = active.has(provider.id);
          return (
            <button
              key={provider.id}
              onClick={() => toggle(provider.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors ${
                on
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground opacity-60 hover:opacity-100"
              }`}
            >
              <ProviderIcon
                providerKind="agent"
                provider={provider.provider}
                className="size-3"
              />
              {provider.displayName}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UsagePillSettings(_props: PluginSettingsSectionProps) {
  const config = useOverlayConfig();
  const { set, saving } = useWriteSetting();
  const disabled = !config.enabled;
  const summary = `${config.position} · ${config.orientation} · ${config.size} · ${
    config.minutes <= 0 ? "manual refresh" : `every ${config.minutes}m`
  }`;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-2xs text-muted-foreground">
          Click a zone to move the pill. Interval, orientation and size are
          configured above.
        </p>
        {saving && (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card/40">
        <div className={disabled ? "pointer-events-none opacity-40" : ""}>
          <PositionPreview
            config={config}
            onPick={(position) => void set("overlayPosition", position)}
          />
        </div>
        <div className="border-t border-border/60 px-4 py-2 text-2xs text-muted-foreground">
          {summary}
          {disabled ? " · pill disabled" : ""}
        </div>
      </div>
      <div className={disabled ? "pointer-events-none opacity-40" : ""}>
        <ProviderFilter
          config={config}
          onChange={(csv) => void set("overlayProviders", csv)}
        />
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "usage-pill", component: UsagePill });
  app.slots.settingsSection({
    id: "usage-pill",
    title: "Usage pill preview",
    description:
      "Live preview of the floating quota pill — click a zone to move it.",
    component: UsagePillSettings,
  });
});
