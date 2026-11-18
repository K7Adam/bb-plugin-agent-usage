// Wraps bb's ACP bridge for this plugin's providers. Requests targeting the
// built-in `agy acp` server reach bb's ACP bridge unchanged (normal TEMP/TMP
// and native `--version` health checks). Only requests targeting the legacy
// PyInstaller `agy_acp_server` receive their own isolated temp folder and a
// health check that avoids unpacking the server.

import { mkdirSync } from "node:fs";

import { isAgyCliCommand } from "./agents.ts";
import {
  antigravityCommand,
  antigravityTempDir,
  isAntigravityRequest,
  readAntigravityHealth,
  sweepExtractions,
  withAntigravityTemp,
  type AntigravityHealthDeps,
  type SweepResult,
} from "./antigravity-runtime.ts";

/** How often leftovers in the plugin's own temp folder are removed while the bridge runs. */
export const SWEEP_INTERVAL_MS = 30 * 60_000;
/** A launch sweeps first, at most this often. */
export const LAUNCH_SWEEP_MIN_GAP_MS = 5 * 60_000;

export interface BridgeContext {
  pluginId: string;
  dataDir: string;
  tempDir: string;
}

export interface Bridge {
  experimental_apiVersion: 1;
  handleLine: (line: string) => void;
  start?: (context: BridgeContext) => void;
  onClose?: () => void;
  onSigterm?: () => void;
  onSigint?: () => void;
}

export interface AntigravityBridgeDeps {
  health: AntigravityHealthDeps;
  /** The temp folder other programs share, swept once at start for leftovers from before this fix. */
  sharedTempDir(): string;
  /** Writes one JSON-RPC line to the runtime, the way the ACP bridge does. */
  write(line: string): void;
  log(message: string): void;
  /** Notifies the usage collector when an Antigravity request names an `agy` CLI command. */
  onAgyCommand?(command: string): void;
  now?(): number;
}

export function createAntigravityBridge(inner: Bridge, deps: AntigravityBridgeDeps): Bridge {
  const now = deps.now ?? Date.now;
  let dataDir: string | null = null;
  let legacyTempDir: string | null = null;
  let lastSweepAt = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;

  const report = (where: string, result: SweepResult): void => {
    if (result.removed.length > 0) deps.log(`removed ${result.removed.length} leftover Antigravity extraction(s) from ${where}`);
  };

  const ensureLegacyTempDir = (): string | null => {
    if (legacyTempDir !== null) return legacyTempDir;
    if (dataDir === null) return null;
    try {
      const dir = antigravityTempDir(dataDir);
      mkdirSync(dir, { recursive: true });
      legacyTempDir = dir;
      return dir;
    } catch (error) {
      deps.log(`could not create the Antigravity temp folder: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const sweepOwn = (): void => {
    if (dataDir === null) return;
    const dir = legacyTempDir ?? antigravityTempDir(dataDir);
    lastSweepAt = now();
    void sweepExtractions(dir, { now: lastSweepAt })
      .then((result) => report(dir, result))
      .catch(() => undefined);
  };

  const answerHealth = async (id: unknown, message: unknown): Promise<void> => {
    const result = await readAntigravityHealth(antigravityCommand(message), deps.health);
    deps.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };

  return {
    ...inner,
    experimental_apiVersion: 1,
    start(context) {
      dataDir = context.dataDir;
      // Still sweep any old `_MEI…` folders left from earlier legacy runs,
      // without creating `agy-temp` on machines that only use `agy acp`.
      sweepOwn();
      const shared = deps.sharedTempDir();
      void sweepExtractions(shared, { now: now(), requireFingerprint: true })
        .then((result) => report(shared, result))
        .catch(() => undefined);
      timer = setInterval(sweepOwn, SWEEP_INTERVAL_MS);
      timer.unref();
      inner.start?.(context);
    },
    handleLine(line) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        inner.handleLine(line);
        return;
      }
      if (!isAntigravityRequest(message)) {
        inner.handleLine(line);
        return;
      }
      const command = antigravityCommand(message);
      if (command !== null && isAgyCliCommand(command)) {
        deps.onAgyCommand?.(command);
        // Built-in `agy acp` does not self-extract into TEMP and answers
        // `agy --version` quickly, so let bb's native ACP bridge handle both.
        inner.handleLine(line);
        return;
      }

      const { id, method } = message as { id?: unknown; method?: unknown };
      if (method === "provider/health" && id !== undefined) {
        void answerHealth(id, message).catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          deps.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: text } })}\n`);
        });
        return;
      }
      const dir = ensureLegacyTempDir();
      if (dir === null) {
        inner.handleLine(line);
        return;
      }
      if (now() - lastSweepAt >= LAUNCH_SWEEP_MIN_GAP_MS) sweepOwn();
      inner.handleLine(JSON.stringify(withAntigravityTemp(message, dir)));
    },
    onClose() {
      clearInterval(timer);
      inner.onClose?.();
    },
  };
}
