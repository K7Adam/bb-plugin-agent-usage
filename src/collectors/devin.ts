// Devin plan usage from the API the Devin CLI itself calls:
// POST {api_server_url}/exa.seat_management_pb.SeatManagementService/GetUserStatus
// (Connect protocol, JSON), authenticated with the CLI's stored API key.
// The API is undocumented; parse defensively.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { clampPercent, usageError, type ProviderUsageResult, type UsageWindow } from "../usage-types.ts";

const DEFAULT_API_SERVER = "https://server.codeium.com";
const GET_USER_STATUS = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_NAME = "bb-plugin-agent-usage";
const CLIENT_VERSION = "0.1.0";

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
}

/** Where the Devin CLI keeps `credentials.toml` on each platform. */
export function devinCredentialPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const paths: string[] = [];
  if (process.platform === "win32" && env.APPDATA) paths.push(path.join(env.APPDATA, "devin", "credentials.toml"));
  if (env.XDG_DATA_HOME) paths.push(path.join(env.XDG_DATA_HOME, "devin", "credentials.toml"));
  paths.push(path.join(home, ".local", "share", "devin", "credentials.toml"));
  return [...new Set(paths)];
}

/** Reads the two top-level string keys this collector needs from the TOML file. */
export function parseDevinCredentials(toml: string): DevinCredentials | null {
  const value = (key: string): string | undefined => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m").exec(toml);
    return match?.[1]?.trim() || undefined;
  };
  const apiKey = value("windsurf_api_key");
  if (apiKey === undefined) return null;
  const server = value("api_server_url") ?? DEFAULT_API_SERVER;
  // Only send the key to an https Devin/Codeium server named in the file.
  if (!/^https:\/\//u.test(server)) return null;
  return { apiKey, apiServerUrl: server.replace(/\/+$/u, "") };
}

export async function readDevinCredentials(): Promise<DevinCredentials | null> {
  for (const file of devinCredentialPaths()) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const credentials = parseDevinCredentials(text);
    if (credentials !== null) return credentials;
  }
  return null;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

// proto3 JSON: 64-bit integers arrive as strings, and default values are omitted.
function numberOf(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** Maps a GetUserStatus response onto bb's usage windows. */
export function mapDevinUserStatus(body: unknown): ProviderUsageResult {
  const userStatus = record(record(body).userStatus);
  const planStatus = record(userStatus.planStatus);
  const planInfo = record(planStatus.planInfo);
  const planName = typeof planInfo.planName === "string" && planInfo.planName !== "" ? planInfo.planName : null;
  const email = typeof userStatus.email === "string" && userStatus.email !== "" ? userStatus.email : null;

  const windows: UsageWindow[] = [];
  const addWindow = (id: "daily" | "weekly", hidden: unknown): void => {
    // A quota only exists when it has a reset time; on credit-billed plans the
    // percent fields stay at their default and would otherwise read as 0% left.
    const resetUnix = numberOf(planStatus[`${id}QuotaResetAtUnix`]);
    if (hidden === true || resetUnix === null || resetUnix <= 0) return;
    const remaining = numberOf(planStatus[`${id}QuotaRemainingPercent`]) ?? 0;
    windows.push({
      id,
      label: id === "daily" ? "Daily quota" : "Weekly quota",
      usedPercent: clampPercent(100 - remaining),
      resetsAt: new Date(resetUnix * 1000).toISOString(),
      kind: id,
      model: null,
    });
  };
  addWindow("daily", planInfo.hideDailyQuota);
  addWindow("weekly", planInfo.hideWeeklyQuota);

  if (Object.keys(planStatus).length === 0) {
    return usageError("Devin returned no plan status.");
  }
  return { supported: true, usage: { status: "ok", accountEmail: email, planLabel: planName, windows } };
}

export async function readDevinUsage(fetchImpl: typeof fetch = fetch): Promise<ProviderUsageResult> {
  const credentials = await readDevinCredentials();
  if (credentials === null) return { supported: true, usage: { status: "unauthenticated" } };

  let response: Response;
  try {
    response = await fetchImpl(`${credentials.apiServerUrl}${GET_USER_STATUS}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "User-Agent": `${CLIENT_NAME}/${CLIENT_VERSION}`,
      },
      body: JSON.stringify({
        metadata: {
          apiKey: credentials.apiKey,
          ideName: CLIENT_NAME,
          ideVersion: CLIENT_VERSION,
          extensionName: CLIENT_NAME,
          extensionVersion: CLIENT_VERSION,
          locale: "en",
        },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return usageError(`Devin usage request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 401 || response.status === 403) {
    return { supported: true, usage: { status: "expired" } };
  }
  if (!response.ok) return usageError(`Devin usage request failed (HTTP ${response.status}).`);

  try {
    return mapDevinUserStatus(await response.json());
  } catch {
    return usageError("Devin returned invalid usage information.");
  }
}

export async function readDevinAccount(): Promise<{ email: string | null } | null> {
  return (await readDevinCredentials()) === null ? null : { email: null };
}
