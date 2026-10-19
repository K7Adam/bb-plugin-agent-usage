// Antigravity quota from the agy CLI's own `/usage` command, the read Orca uses:
// `agy -p /usage --output-format json`. agy keeps and refreshes its Google
// credential itself, and the command is answered without a model turn, so the
// read spends no quota. Requires agy 1.1.11 or newer.

import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { clampPercent, usageError, type ProviderUsageResult, type UsageWindow } from "../usage-types.ts";

const MIN_AGY_VERSION = [1, 1, 11] as const;
const VERSION_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

// Set when agy answered `/usage` with a model turn instead of the command, so
// later reads do not spend quota. Lasts for the life of the host process.
let usageCommandUnsupported = false;

interface ExecResult {
  stdout: string;
  stderr: string;
  failed: boolean;
}

function run(file: string, args: string[], timeout: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: error !== null }),
    );
  });
}

async function isFile(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Finds agy on PATH (honouring PATHEXT on Windows), then in its default install folders. */
export async function findAgy(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | null> {
  const windows = process.platform === "win32";
  const extensions = windows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  if (windows && env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "agy", "bin"));
  dirs.push(path.join(home, ".local", "bin"));
  for (const dir of dirs) {
    for (const extension of extensions) {
      // A bare `agy` file on Windows is not executable; only PATHEXT names are.
      const candidate = path.join(dir, `agy${extension.toLowerCase()}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function parseVersion(text: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text);
  return match === null ? null : match.slice(1, 4).map(Number);
}

export function isSupportedVersion(version: number[]): boolean {
  for (let index = 0; index < MIN_AGY_VERSION.length; index += 1) {
    const part = version[index] ?? 0;
    if (part !== MIN_AGY_VERSION[index]) return part > MIN_AGY_VERSION[index];
  }
  return true;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/** The JSON envelope agy prints in print mode; other stdout lines are ignored. */
export function findUsageEnvelope(stdout: string): Json | null {
  const candidates = [stdout, ...stdout.split(/\r?\n/u)];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = record(JSON.parse(trimmed));
      if (parsed !== null && ("command" in parsed || "status" in parsed || "num_turns" in parsed)) return parsed;
    } catch {
      // Not a JSON line.
    }
  }
  return null;
}

/** agy prints `AGY_ERROR:{status, error_code}` lines for API failures. */
export function classifyAgyError(output: string): ProviderUsageResult | null {
  const line = /AGY_ERROR:(\{.*\})/u.exec(output);
  if (line !== null) {
    let detail: Json | null = null;
    try {
      detail = record(JSON.parse(line[1]));
    } catch {
      detail = null;
    }
    const status = String(detail?.status ?? "");
    const code = Number(detail?.error_code ?? NaN);
    if (status === "UNAUTHENTICATED" || code === 401) return { supported: true, usage: { status: "unauthenticated" } };
    if (status === "PERMISSION_DENIED" || code === 403) {
      return usageError("Antigravity denied the usage request. Check that the account has an Antigravity plan.");
    }
    if (status === "RESOURCE_EXHAUSTED" || code === 429) return usageError("Antigravity rate-limited the usage request.");
    if (code >= 500) return usageError(`Antigravity usage service failed (HTTP ${code}).`);
    return usageError(`Antigravity usage request failed (${status || code || "unknown error"}).`);
  }
  if (/not (logged|signed) in|run `?agy login/iu.test(output)) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  return null;
}

const WINDOW_KIND: Record<string, UsageWindow["kind"]> = { "5h": "five-hour", weekly: "weekly", daily: "daily" };
const WINDOW_NAME: Record<string, string> = { "5h": "5 hours", weekly: "Weekly", daily: "Daily" };

/** Maps `command.data.groups[].buckets[]` onto bb's usage windows. */
export function mapAgyUsage(envelope: Json): ProviderUsageResult {
  const command = record(envelope.command);
  const data = record(command?.data);
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const windows: UsageWindow[] = [];
  for (const rawGroup of groups) {
    const group = record(rawGroup);
    if (group === null) continue;
    const groupName = typeof group.name === "string" && group.name !== "" ? group.name : "Antigravity";
    const buckets = (Array.isArray(group.buckets) ? group.buckets : [])
      .map(record)
      .filter((bucket): bucket is Json => bucket !== null && bucket.disabled !== true);
    for (const bucket of buckets) {
      const remaining = Number(bucket.remaining_fraction);
      if (!Number.isFinite(remaining)) continue;
      const window = typeof bucket.window === "string" ? bucket.window : "";
      const resetTime = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
      // agy names buckets by what is left ("Weekly Limit Remaining"); bb shows what is used.
      const windowName = WINDOW_NAME[window] ?? (typeof bucket.name === "string" && bucket.name !== "" ? bucket.name : window);
      windows.push({
        id: typeof bucket.id === "string" && bucket.id !== "" ? bucket.id : `${groupName}:${window}`,
        label: `${groupName} · ${windowName}`,
        usedPercent: clampPercent((1 - remaining) * 100),
        resetsAt: Number.isFinite(resetTime) ? new Date(resetTime).toISOString() : null,
        kind: WINDOW_KIND[window] ?? "custom",
        model: groupName,
      });
    }
  }
  return { supported: true, usage: { status: "ok", accountEmail: null, planLabel: null, windows } };
}

/** True when agy ran `/usage` as a prompt (older agy, or the slash command was not recognised). */
export function isModelTurn(envelope: Json): boolean {
  const turns = Number(envelope.num_turns ?? 0);
  const conversation = envelope.conversation_id;
  return (Number.isFinite(turns) && turns > 0) || (typeof conversation === "string" && conversation !== "");
}

async function runUsageCommand(): Promise<ProviderUsageResult> {
  if (usageCommandUnsupported) {
    return usageError("agy answered /usage with a model turn; usage reads are paused until bb restarts.");
  }
  const agy = await findAgy();
  if (agy === null) return usageError("The agy CLI was not found. Install Antigravity's agy CLI to read usage.");

  const versionRun = await run(agy, ["--version"], VERSION_TIMEOUT_MS);
  const version = parseVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
  if (version === null || !isSupportedVersion(version)) {
    return usageError(`agy ${MIN_AGY_VERSION.join(".")} or newer is required to read usage.`);
  }

  const result = await run(agy, ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], USAGE_TIMEOUT_MS);
  const envelope = findUsageEnvelope(result.stdout);
  const classified = classifyAgyError(`${result.stdout}\n${result.stderr}`);

  if (envelope !== null && isModelTurn(envelope)) {
    usageCommandUnsupported = true;
    return usageError("agy answered /usage with a model turn; usage reads are paused until bb restarts.");
  }
  if (envelope !== null && envelope.status === "SUCCESS" && record(envelope.command)?.name === "usage") {
    return mapAgyUsage(envelope);
  }
  if (classified !== null) return classified;
  if (result.failed && envelope === null) return usageError("agy did not answer the usage request in time.");
  return usageError("agy returned no usage information.");
}

// `agy /usage` takes 20–30 s, and bb gives a provider/usage request 30 s. So the
// last result is kept in a file (bridge processes exit when idle), a read
// returns it while fresh, and otherwise waits a bounded time for a new read
// that keeps running and fills the file for the next request.
const FRESH_OK_MS = 4 * 60_000;
const FRESH_OTHER_MS = 60_000;
const WAIT_FOR_READ_MS = 22_000;
const READ_CLAIM_MS = 60_000;

export interface CachedUsage {
  at: number;
  result: ProviderUsageResult;
}

export function usageCacheDir(): string {
  return path.join(tmpdir(), "bb-plugin-agent-usage");
}

const cacheFile = (): string => path.join(usageCacheDir(), "antigravity-usage.json");
const claimFile = (): string => path.join(usageCacheDir(), "antigravity-usage.claim");

async function readCache(): Promise<CachedUsage | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), "utf8")) as CachedUsage;
    return typeof parsed.at === "number" && typeof parsed.result === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(result: ProviderUsageResult, now: number): Promise<void> {
  await mkdir(usageCacheDir(), { recursive: true });
  const temporary = `${cacheFile()}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ at: now, result } satisfies CachedUsage));
  await rename(temporary, cacheFile());
}

/** One agy run at a time across bridge processes; a stale claim is taken over. */
async function claimRead(now: number): Promise<boolean> {
  await mkdir(usageCacheDir(), { recursive: true });
  try {
    const claimedAt = Number(await readFile(claimFile(), "utf8"));
    if (Number.isFinite(claimedAt) && now - claimedAt < READ_CLAIM_MS) return false;
  } catch {
    // No claim yet.
  }
  await writeFile(claimFile(), String(now));
  return true;
}

export function isFresh(cached: CachedUsage, now: number): boolean {
  const ok = cached.result.supported && cached.result.usage.status === "ok";
  return now - cached.at < (ok ? FRESH_OK_MS : FRESH_OTHER_MS);
}

let inFlight: Promise<ProviderUsageResult> | null = null;

function startRead(): Promise<ProviderUsageResult> {
  inFlight ??= runUsageCommand()
    .then(async (result) => {
      await writeCache(result, Date.now()).catch(() => undefined);
      return result;
    })
    .finally(async () => {
      inFlight = null;
      await rm(claimFile(), { force: true }).catch(() => undefined);
    });
  return inFlight;
}

export async function readAntigravityUsage(): Promise<ProviderUsageResult> {
  const now = Date.now();
  const cached = await readCache();
  if (cached !== null && isFresh(cached, now)) return cached.result;

  if (inFlight === null && !(await claimRead(now).catch(() => true))) {
    // Another bridge process is reading; serve what there is.
    return cached?.result ?? usageError("Antigravity usage is loading; it appears on the next refresh.");
  }
  const read = startRead();
  const timedOut = Symbol("timedOut");
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    read,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), WAIT_FOR_READ_MS);
    }),
  ]);
  clearTimeout(timer);
  if (outcome !== timedOut) return outcome;
  return cached?.result ?? usageError("Antigravity usage is loading (agy takes about 20–30 s); it appears on the next refresh.");
}

/** The ACP server's own sign-in (it opens a Google login on its first session). */
export async function readAntigravityAccount(env: NodeJS.ProcessEnv = process.env): Promise<{ email: string | null } | null> {
  const geminiHome = env.GEMINI_HOME ?? path.join(homedir(), ".gemini");
  return (await isFile(path.join(geminiHome, "antigravity-acp", "acp_token.json"))) ? { email: null } : null;
}
