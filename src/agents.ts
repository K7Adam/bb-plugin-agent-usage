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

export function isUsageProviderId(value: string): value is UsageProviderId {
  return (USAGE_PROVIDER_IDS as readonly string[]).includes(value);
}
