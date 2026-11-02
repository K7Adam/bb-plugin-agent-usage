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
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
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
      className="inline-flex items-center whitespace-nowrap"
      style={{ gap: 4, color: tone(left) }}
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
    <div className="mb-2 last:mb-0">
      <div className="flex items-center gap-1.5 font-semibold">
        <ProviderIcon providerKind="agent" provider={provider.provider} />
        <span>{provider.displayName}</span>
        {provider.planLabel && (
          <span className="font-normal text-muted-foreground">
            {provider.planLabel}
          </span>
        )}
        {provider.hostName && (
          <span className="ml-auto font-normal text-muted-foreground">
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
              className="flex justify-between pl-[18px]"
              style={{ color: tone(left) }}
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
        <div className="pl-[18px] text-muted-foreground">
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
          className="rounded-[10px] border border-border bg-popover p-3 shadow-xl"
          style={popupStyle(config.position)}
        >
          <div className="mb-2 flex items-center justify-between">
            <strong>Usage</strong>
            <button
              onClick={() => void refresh()}
              className="rounded-md border border-border px-2 py-0.5 transition-colors hover:bg-muted"
              style={{ fontSize: scale.font }}
            >
              {loading ? "…" : "Refresh"}
            </button>
          </div>
          {(snapshot?.providers ?? []).map((provider) => (
            <ProviderRows key={provider.key} provider={provider} />
          ))}
          {snapshot?.error && (
            <div className="text-destructive">{snapshot.error}</div>
          )}
          <div
            className="mt-1.5 text-muted-foreground"
            style={{ fontSize: scale.font - 1 }}
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
        className="flex items-center rounded-full border border-border shadow-lg backdrop-blur-md"
        style={{
          flexDirection: config.orientation === "vertical" ? "column" : "row",
          gap: scale.gap,
          padding: scale.pad,
          background:
            "color-mix(in srgb, var(--popover, #18181b) 88%, transparent)",
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

function Switch({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      } ${disabled ? "cursor-default opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

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
      className={`inline-flex gap-0.5 rounded-lg bg-muted p-0.5 ${
        disabled ? "pointer-events-none opacity-50" : ""
      }`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-1 text-2xs font-medium transition-colors ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-2xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 px-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="divide-y divide-border/60 rounded-xl border border-border bg-card/40">
        {children}
      </div>
    </div>
  );
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
  const mockChips = ["#D97757", "#10a37f", "#8b5cf6"];
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
          {mockChips.map((color, index) => (
            <span
              key={index}
              className="inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ background: color }}
              />
              {[87, 42, 99][index]}%
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function UsagePillSettings(_props: PluginSettingsSectionProps) {
  const config = useOverlayConfig();
  const { set, saving } = useWriteSetting();
  const disabled = !config.enabled;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-border bg-card/40 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Show usage pill</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Floating quota chips over the bb window.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          )}
          <Switch
            checked={config.enabled}
            onCheckedChange={(value) => void set("overlayEnabled", value)}
          />
        </div>
      </div>

      <Group title="Position">
        <div className="flex items-center justify-between gap-4 px-4 pt-3">
          <div className="text-xs font-medium">Placement</div>
          <div className="text-2xs text-muted-foreground">
            Click a zone in the preview — the pill glides there.
          </div>
        </div>
        <div className={disabled ? "pointer-events-none opacity-50" : ""}>
          <PositionPreview
            config={config}
            onPick={(position) => void set("overlayPosition", position)}
          />
        </div>
      </Group>

      <Group title="Appearance">
        <Field label="Orientation" hint="Chips side by side or stacked.">
          <Segmented
            disabled={disabled}
            options={ORIENTATIONS.map((orientation) => ({
              value: orientation,
              label:
                orientation === "horizontal" ? "Horizontal" : "Vertical",
            }))}
            value={config.orientation}
            onChange={(value) => void set("overlayOrientation", value)}
          />
        </Field>
        <Field label="Size" hint="Compact, comfortable or large chips.">
          <Segmented
            disabled={disabled}
            options={SIZES.map((size) => ({
              value: size,
              label: size[0].toUpperCase() + size.slice(1),
            }))}
            value={config.size}
            onChange={(value) => void set("overlaySize", value)}
          />
        </Field>
      </Group>

      <Group title="Refresh">
        <Field
          label="Interval"
          hint="Polling pauses while bb is minimized."
        >
          <Segmented
            disabled={disabled}
            options={[
              { value: "0", label: "Manual" },
              { value: "2", label: "2m" },
              { value: "5", label: "5m" },
              { value: "15", label: "15m" },
              { value: "30", label: "30m" },
            ]}
            value={String(config.minutes)}
            onChange={(value) =>
              void set("overlayRefreshMinutes", Number(value))
            }
          />
        </Field>
      </Group>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "usage-pill", component: UsagePill });
  app.slots.settingsSection({
    id: "usage-pill",
    title: "Usage pill overlay",
    description:
      "Position, size, orientation and refresh cadence of the floating quota pill.",
    component: UsagePillSettings,
  });
});
