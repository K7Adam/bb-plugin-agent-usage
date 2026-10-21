// Keeps the Antigravity ACP server's self-extraction out of the shared temp
// folder. agy_acp_server is a PyInstaller one-file build: every start unpacks
// about 300 MB into a fresh `_MEI…` folder under TEMP, and only a server that
// exits on its own removes it. bb stops the server after a model list and
// after the 5-second `--version` probe of its health check, so each of those
// left a folder behind (about 90 GB in a day on one machine).

import type { Dirent } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ANTIGRAVITY_DIALECT_ID } from "./agents.ts";

/** Folder under the bridge's data dir that the ACP server unpacks into. */
export const ANTIGRAVITY_TEMP_DIR_NAME = "agy-temp";

/** Unpacking took up to two minutes on a disk Defender scans; an older folder belongs to a start that ended. */
export const EXTRACTION_MIN_AGE_MS = 15 * 60_000;

const EXTRACTION_PREFIX = "_MEI";
const REMOVING_SUFFIX = ".removing";

// Only the Antigravity ACP server unpacks this path, so a sweep of the shared
// temp folder never touches another PyInstaller program's folder.
const FINGERPRINT = path.join("google3", "cloud", "developer_experience", "antigravity_extensions");

// Installs from the ACP registry archive live in a folder named after their version.
const VERSIONED_INSTALL = /[\\/]agy-acp-server[\\/](\d+\.\d+\.\d+)[\\/]/i;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function antigravityTempDir(dataDir: string): string {
  return path.join(dataDir, ANTIGRAVITY_TEMP_DIR_NAME);
}

// Maintenance requests and model/list carry the provider options at the top
// level of params; thread and turn requests carry them under `options`.
function providerOptionsOf(params: unknown): JsonObject | null {
  if (!isObject(params)) return null;
  if (isObject(params.providerOptions)) return params.providerOptions;
  if (isObject(params.options) && isObject(params.options.providerOptions)) return params.options.providerOptions;
  return null;
}

export function isAntigravityRequest(message: unknown): boolean {
  return isObject(message) && providerOptionsOf(message.params)?.acpDialect === ANTIGRAVITY_DIALECT_ID;
}

/** The launch command of an Antigravity request, as the server registered it. */
export function antigravityCommand(message: unknown): string | null {
  if (!isObject(message)) return null;
  const launchSpec = providerOptionsOf(message.params)?.acpLaunchSpec;
  return isObject(launchSpec) && typeof launchSpec.command === "string" && launchSpec.command.length > 0
    ? launchSpec.command
    : null;
}

function withTempEnv(providerOptions: JsonObject, tempDir: string): JsonObject {
  const launchSpec = providerOptions.acpLaunchSpec;
  if (!isObject(launchSpec)) return providerOptions;
  const env = isObject(launchSpec.env) ? launchSpec.env : {};
  // PyInstaller on Windows reads TMP and TEMP; TMPDIR covers macOS and Linux.
  return {
    ...providerOptions,
    acpLaunchSpec: { ...launchSpec, env: { ...env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir } },
  };
}

/** Returns a copy of an Antigravity request whose server unpacks into `tempDir`; any other message comes back as is. */
export function withAntigravityTemp<T>(message: T, tempDir: string): T {
  if (!isObject(message) || !isAntigravityRequest(message)) return message;
  const params = message.params as JsonObject;
  if (isObject(params.providerOptions)) {
    return { ...message, params: { ...params, providerOptions: withTempEnv(params.providerOptions, tempDir) } } as T;
  }
  const options = params.options as JsonObject;
  return {
    ...message,
    params: { ...params, options: { ...options, providerOptions: withTempEnv(options.providerOptions as JsonObject, tempDir) } },
  } as T;
}

/** The server version from its install folder; the server itself has no `--version` flag. */
export function versionFromInstallPath(executablePath: string): string | null {
  return VERSIONED_INSTALL.exec(executablePath)?.[1] ?? null;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isOldEnough(dir: string, now: number, minAgeMs: number): Promise<boolean> {
  try {
    const info = await stat(dir);
    return now - Math.max(info.birthtimeMs, info.mtimeMs) >= minAgeMs;
  } catch {
    return false;
  }
}

export interface SweepOptions {
  now?: number;
  minAgeMs?: number;
  /** Only remove folders that hold the Antigravity fingerprint, for temp folders other programs share. */
  requireFingerprint?: boolean;
}

export interface SweepResult {
  removed: string[];
  kept: string[];
}

/**
 * Removes leftover `_MEI…` folders under `root`. Windows refuses to rename a
 * folder while a server unpacks into it or runs from it, so a folder is first
 * renamed and only removed when that worked.
 */
export async function sweepExtractions(root: string, options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? EXTRACTION_MIN_AGE_MS;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { removed: [], kept: [] };
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(EXTRACTION_PREFIX)) continue;
    const dir = path.join(root, entry.name);
    if (entry.name.endsWith(REMOVING_SUFFIX)) {
      // An earlier sweep renamed it, so nothing runs from it any more.
      await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
      continue;
    }
    if (options.requireFingerprint && !(await isDirectory(path.join(dir, FINGERPRINT)))) continue;
    if (!(await isOldEnough(dir, now, minAgeMs))) {
      kept.push(entry.name);
      continue;
    }
    const doomed = `${dir}${REMOVING_SUFFIX}`;
    try {
      await rename(dir, doomed);
    } catch {
      kept.push(entry.name);
      continue;
    }
    await rm(doomed, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
    removed.push(entry.name);
  }
  return { removed, kept };
}

export interface AntigravityHealthDeps {
  loginCommand: string;
  resolveExecutable(command: string): Promise<string | null>;
  readAccount(): Promise<{ email: string | null } | null>;
}

type HealthStatus = "ready" | "not_installed" | "unauthenticated" | "unknown";

function healthResult(loginCommand: string, status: HealthStatus, fields: { accountEmail?: string | null; installedVersion?: string | null; statusMessage?: string | null } = {}) {
  // Same shape and flags as the ACP bridge's own health answer for an agent with maintenance hooks.
  return {
    supported: true as const,
    health: {
      status,
      statusMessage: fields.statusMessage ?? null,
      accountEmail: fields.accountEmail ?? null,
      planLabel: null,
      installedVersion: fields.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand,
    },
  };
}

/** The ACP bridge's health check without its `--version` probe, which starts the whole server. */
export async function readAntigravityHealth(command: string | null, deps: AntigravityHealthDeps) {
  if (command === null) {
    return healthResult(deps.loginCommand, "unknown", { statusMessage: "The ACP provider has no launch command." });
  }
  const executable = await deps.resolveExecutable(command).catch(() => null);
  if (executable === null) return healthResult(deps.loginCommand, "not_installed");
  const installedVersion = versionFromInstallPath(executable);
  try {
    const account = await deps.readAccount();
    return healthResult(deps.loginCommand, account === null ? "unauthenticated" : "ready", {
      accountEmail: account?.email ?? null,
      installedVersion,
    });
  } catch (error) {
    return healthResult(deps.loginCommand, "unknown", {
      installedVersion,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
