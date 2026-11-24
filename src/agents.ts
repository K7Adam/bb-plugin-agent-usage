// Shared by the server entry (provider registration, usage source) and the
// host entry (ACP dialects). Keep it free of Node and SDK imports.

export const DEVIN_PROVIDER_ID = "devin-cli";
export const ANTIGRAVITY_PROVIDER_ID = "antigravity-cli";

// Dialect ids name the maintenance hooks registered in host.ts. They must not
// collide with the bridge's built-in dialects (acp, cursor, grok, omp, opencode).
export const DEVIN_DIALECT_ID = "devin-cli";
export const ANTIGRAVITY_DIALECT_ID = "antigravity-cli";

export const USAGE_PROVIDER_IDS = [DEVIN_PROVIDER_ID, ANTIGRAVITY_PROVIDER_ID] as const;
export type UsageProviderId = (typeof USAGE_PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<UsageProviderId, string> = {
  [DEVIN_PROVIDER_ID]: "Devin",
  [ANTIGRAVITY_PROVIDER_ID]: "Google Antigravity",
};

// agy 1.5.1 and newer serve ACP themselves (`agy acp`): it answers initialize
// in well under a second. The separate agy_acp_server from the ACP registry is a
// PyInstaller build that unpacks about 300 MB on every start and took 16 s, under
// load more than the bridge's 60-second initialize limit. A command named agy
// gets the `acp` subcommand, any other command is launched as is.
export const DEFAULT_ANTIGRAVITY_COMMAND = "agy";

export function isAgyCliCommand(command: string): boolean {
  const name = command.trim().split(/[\\/]/).pop() ?? "";
  return /^agy(\.exe)?$/i.test(name);
}

export function antigravityLaunchArgs(command: string, options: { sandbox?: boolean } = {}): string[] {
  if (!isAgyCliCommand(command)) return [];
  return options.sandbox ? ["acp", "--sandbox"] : ["acp"];
}

// `devin acp --process-model`: where local agents run. Any other value makes
// devin exit with a usage error, so only these two are ever passed.
export const DEVIN_PROCESS_MODELS = ["daemon", "in-process"] as const;
export type DevinProcessModel = (typeof DEVIN_PROCESS_MODELS)[number];

export interface DevinLaunchOptions {
  processModel?: unknown;
  /** Comma-separated models for `--refusal-fallback`, tried in order. */
  refusalFallback?: unknown;
}

function isDevinProcessModel(value: unknown): value is DevinProcessModel {
  return (DEVIN_PROCESS_MODELS as readonly unknown[]).includes(value);
}

export function parseModelList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}

export function devinLaunchArgs(options: DevinLaunchOptions = {}): string[] {
  const processModel = isDevinProcessModel(options.processModel) ? ["--process-model", options.processModel] : [];
  // The flag repeats once per model; a comma inside one value would be read as part of a model name.
  const refusalFallback = parseModelList(options.refusalFallback).flatMap((model) => ["--refusal-fallback", model]);
  return ["acp", ...processModel, ...refusalFallback];
}

export function isUsageProviderId(value: string): value is UsageProviderId {
  return (USAGE_PROVIDER_IDS as readonly string[]).includes(value);
}
