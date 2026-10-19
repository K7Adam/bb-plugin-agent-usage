// The `provider/usage` result shape the ACP bridge returns from a dialect's
// `maintenance.readUsage` (providerUsageResultSchema in
// @get-bb/plugin-sdk/provider-bridge/acp-next). The SDK does not export the
// type, so it is restated here; windows are loose there, which is how `kind`
// and `model` reach bb's usage panel.

export type UsageWindowKind = "five-hour" | "daily" | "weekly" | "custom";

export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  kind: UsageWindowKind;
  model: string | null;
};

export type ProviderUsage =
  | { status: "ok"; accountEmail: string | null; planLabel: string | null; windows: UsageWindow[] }
  | { status: "not_installed" }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | { status: "error"; accountEmail: string | null; planLabel: string | null; message: string };

export type ProviderUsageResult = { supported: false } | { supported: true; usage: ProviderUsage };

export function usageError(message: string): ProviderUsageResult {
  return { supported: true, usage: { status: "error", accountEmail: null, planLabel: null, message } };
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
