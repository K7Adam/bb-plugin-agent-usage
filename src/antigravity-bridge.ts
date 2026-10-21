// Wraps bb's ACP bridge for this plugin's providers. Antigravity requests get
// their own temp folder and a health check that does not start the server;
// everything else, Devin included, reaches the ACP bridge unchanged.

import { mkdirSync } from "node:fs";

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
  now?(): number;
}

export function createAntigravityBridge(inner: Bridge, deps: AntigravityBridgeDeps): Bridge {
  const now = deps.now ?? Date.now;
  let tempDir: string | null = null;
  let lastSweepAt = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | undefined;

  const report = (where: string, result: SweepResult): void => {
    if (result.removed.length > 0) deps.log(`removed ${result.removed.length} leftover Antigravity extraction(s) from ${where}`);
  };

  const sweepOwn = (): void => {
    if (tempDir === null) return;
    const dir = tempDir;
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
      try {
        const dir = antigravityTempDir(context.dataDir);
        mkdirSync(dir, { recursive: true });
        tempDir = dir;
      } catch (error) {
        // Without the folder the server unpacks into the shared temp folder, as before.
        deps.log(`could not create the Antigravity temp folder: ${error instanceof Error ? error.message : String(error)}`);
      }
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
      const { id, method } = message as { id?: unknown; method?: unknown };
      if (method === "provider/health" && id !== undefined) {
        void answerHealth(id, message).catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          deps.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: text } })}\n`);
        });
        return;
      }
      if (tempDir === null) {
        inner.handleLine(line);
        return;
      }
      if (now() - lastSweepAt >= LAUNCH_SWEEP_MIN_GAP_MS) sweepOwn();
      inner.handleLine(JSON.stringify(withAntigravityTemp(message, tempDir)));
    },
    onClose() {
      clearInterval(timer);
      inner.onClose?.();
    },
  };
}
