import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAntigravityBridge, type Bridge, type BridgeContext } from "../src/antigravity-bridge.ts";

const launchSpec = { displayName: "Google Antigravity", command: "agy_acp_server", args: [], env: {} };

function line(message: unknown): string {
  return JSON.stringify(message);
}

async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "agy-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const received: string[] = [];
  const written: string[] = [];
  const events: string[] = [];
  const inner: Bridge = {
    experimental_apiVersion: 1,
    handleLine: (value) => {
      received.push(value);
    },
    start: () => {
      events.push("inner.start");
    },
    onClose: () => {
      events.push("inner.onClose");
    },
  };
  const bridge = createAntigravityBridge(inner, {
    health: {
      loginCommand: "agy_acp_server",
      resolveExecutable: async () => "C:\\Users\\me\\AppData\\Local\\agy-acp-server\\1.4.1\\agy_acp_server.exe",
      readAccount: async () => ({ email: null }),
    },
    sharedTempDir: () => path.join(root, "shared"),
    write: (value) => {
      written.push(value);
    },
    log: () => undefined,
  });
  const context: BridgeContext = { pluginId: "agent-usage", dataDir: path.join(root, "data"), tempDir: path.join(root, "tmp") };
  return { bridge, context, received, written, events, root };
}

test("keeps the bridge contract", async (t) => {
  const { bridge, context, events } = await setup(t);
  assert.equal(bridge.experimental_apiVersion, 1);
  assert.equal(typeof bridge.handleLine, "function");
  bridge.start?.(context);
  assert.equal((await stat(path.join(context.dataDir, "agy-temp"))).isDirectory(), true);
  bridge.onClose?.();
  assert.deepEqual(events, ["inner.start", "inner.onClose"]);
});

test("passes Devin, notifications and unreadable lines through unchanged", async (t) => {
  const { bridge, context, received, written } = await setup(t);
  bridge.start?.(context);
  const devin = line({ jsonrpc: "2.0", id: 1, method: "model/list", params: { providerOptions: { acpDialect: "devin-cli", acpLaunchSpec: { ...launchSpec, command: "devin" } } } });
  const notification = line({ jsonrpc: "2.0", method: "initialized" });
  bridge.handleLine(devin);
  bridge.handleLine(notification);
  bridge.handleLine("{not json");
  assert.deepEqual(received, [devin, notification, "{not json"]);
  assert.deepEqual(written, []);
  bridge.onClose?.();
});

test("starts the Antigravity server with its own temp folder", async (t) => {
  const { bridge, context, received } = await setup(t);
  bridge.start?.(context);
  bridge.handleLine(line({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { threadId: "thr_1", options: { providerOptions: { acpDialect: "antigravity-cli", acpLaunchSpec: launchSpec } } } }));
  assert.equal(received.length, 1);
  const forwarded = JSON.parse(received[0]);
  const tempDir = path.join(context.dataDir, "agy-temp");
  assert.equal(forwarded.params.options.providerOptions.acpLaunchSpec.env.TEMP, tempDir);
  assert.equal(forwarded.params.options.providerOptions.acpLaunchSpec.env.TMP, tempDir);
  assert.equal(forwarded.id, 2);
  bridge.onClose?.();
});

test("answers Antigravity health itself", async (t) => {
  const { bridge, context, received, written } = await setup(t);
  bridge.start?.(context);
  bridge.handleLine(line({ jsonrpc: "2.0", id: 3, method: "provider/health", params: { providerOptions: { acpDialect: "antigravity-cli", acpLaunchSpec: launchSpec } } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, []);
  assert.equal(written.length, 1);
  assert.ok(written[0].endsWith("\n"));
  const response = JSON.parse(written[0]);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 3);
  assert.equal(response.result.health.status, "ready");
  assert.equal(response.result.health.installedVersion, "1.4.1");
  bridge.onClose?.();
});

test("before start, Antigravity launches reach the ACP bridge unchanged", async (t) => {
  const { bridge, received } = await setup(t);
  const start = line({ jsonrpc: "2.0", id: 4, method: "model/list", params: { providerOptions: { acpDialect: "antigravity-cli", acpLaunchSpec: launchSpec } } });
  bridge.handleLine(start);
  assert.deepEqual(received, [start]);
});
