import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { providerHealthResultSchema } from "@get-bb/plugin-sdk/provider-bridge";

import {
  antigravityCommand,
  antigravityTempDir,
  EXTRACTION_MIN_AGE_MS,
  isAntigravityRequest,
  readAntigravityHealth,
  sweepExtractions,
  versionFromInstallPath,
  withAntigravityTemp,
} from "../src/antigravity-runtime.ts";

const launchSpec = {
  displayName: "Google Antigravity",
  command: "agy_acp_server",
  args: [],
  env: { KEEP: "1" },
};

const modelList = {
  jsonrpc: "2.0",
  id: 7,
  method: "model/list",
  params: { cwd: "C:/work", providerOptions: { acpDialect: "antigravity-cli", acpLaunchSpec: launchSpec } },
};

const threadStart = {
  jsonrpc: "2.0",
  id: 8,
  method: "thread/start",
  params: { threadId: "thr_1", cwd: "C:/work", options: { model: "gemini", providerOptions: { acpDialect: "antigravity-cli", acpLaunchSpec: launchSpec } } },
};

const devinStart = {
  jsonrpc: "2.0",
  id: 9,
  method: "thread/start",
  params: { threadId: "thr_2", cwd: "C:/work", options: { providerOptions: { acpDialect: "devin-cli", acpLaunchSpec: { ...launchSpec, command: "devin" } } } },
};

test("recognises Antigravity requests in either params layout", () => {
  assert.equal(isAntigravityRequest(modelList), true);
  assert.equal(isAntigravityRequest(threadStart), true);
  assert.equal(isAntigravityRequest(devinStart), false);
  assert.equal(isAntigravityRequest({ jsonrpc: "2.0", method: "initialized" }), false);
  assert.equal(isAntigravityRequest("not a message"), false);
  assert.equal(antigravityCommand(threadStart), "agy_acp_server");
  assert.equal(antigravityCommand(devinStart), "devin");
});

test("points a model list's server at the temp folder without touching the request", () => {
  const before = structuredClone(modelList);
  const rewritten = withAntigravityTemp(modelList, "D:/agy-temp");
  assert.deepEqual(modelList, before);
  assert.deepEqual(rewritten.params.providerOptions.acpLaunchSpec.env, { KEEP: "1", TEMP: "D:/agy-temp", TMP: "D:/agy-temp", TMPDIR: "D:/agy-temp" });
  assert.equal(rewritten.params.providerOptions.acpDialect, "antigravity-cli");
  assert.equal(rewritten.params.cwd, "C:/work");
});

test("points a thread's server at the temp folder", () => {
  const before = structuredClone(threadStart);
  const rewritten = withAntigravityTemp(threadStart, "D:/agy-temp");
  assert.deepEqual(threadStart, before);
  const env: Record<string, string> = rewritten.params.options.providerOptions.acpLaunchSpec.env;
  assert.equal(env.TEMP, "D:/agy-temp");
  assert.equal(rewritten.params.options.model, "gemini");
  assert.equal(rewritten.params.threadId, "thr_1");
});

test("leaves Devin and other messages alone", () => {
  assert.equal(withAntigravityTemp(devinStart, "D:/agy-temp"), devinStart);
  const notification = { jsonrpc: "2.0", method: "initialized" };
  assert.equal(withAntigravityTemp(notification, "D:/agy-temp"), notification);
});

test("reads the version from a registry install folder only", () => {
  assert.equal(versionFromInstallPath("C:\\Users\\me\\AppData\\Local\\agy-acp-server\\1.4.1\\agy_acp_server.exe"), "1.4.1");
  assert.equal(versionFromInstallPath("/home/me/.local/share/agy-acp-server/1.3.0/agy_acp_server.par"), "1.3.0");
  assert.equal(versionFromInstallPath("C:\\Users\\me\\.local\\bin\\agy_acp_server.exe"), null);
});

test("puts the temp folder under the bridge's data dir", () => {
  assert.equal(antigravityTempDir(path.join("C:", "data")), path.join("C:", "data", "agy-temp"));
});

async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agy-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function extraction(root: string, name: string, fingerprint: boolean): Promise<string> {
  const dir = path.join(root, name);
  const inner = fingerprint ? path.join(dir, "google3", "cloud", "developer_experience", "antigravity_extensions") : path.join(dir, "other");
  await mkdir(inner, { recursive: true });
  return dir;
}

const later = () => Date.now() + 2 * EXTRACTION_MIN_AGE_MS;

test("keeps a folder that may still be unpacking", async (t) => {
  const root = await scratch(t);
  await extraction(root, "_MEI1", true);
  const result = await sweepExtractions(root);
  assert.deepEqual(result, { removed: [], kept: ["_MEI1"] });
  assert.deepEqual(await readdir(root), ["_MEI1"]);
});

test("removes old leftovers and leaves other folders", async (t) => {
  const root = await scratch(t);
  await extraction(root, "_MEI1", true);
  await extraction(root, "_MEI2", false);
  await mkdir(path.join(root, "keep-me"));
  const result = await sweepExtractions(root, { now: later() });
  assert.deepEqual(result.removed.sort(), ["_MEI1", "_MEI2"]);
  assert.deepEqual(await readdir(root), ["keep-me"]);
});

test("removes only Antigravity folders from a shared temp folder", async (t) => {
  const root = await scratch(t);
  await extraction(root, "_MEI1", true);
  await extraction(root, "_MEI2", false);
  const result = await sweepExtractions(root, { now: later(), requireFingerprint: true });
  assert.deepEqual(result.removed, ["_MEI1"]);
  assert.deepEqual(await readdir(root), ["_MEI2"]);
});

test("finishes a folder an earlier sweep renamed", async (t) => {
  const root = await scratch(t);
  await extraction(root, "_MEI1.removing", false);
  await sweepExtractions(root);
  assert.deepEqual(await readdir(root), []);
});

test("returns nothing for a missing folder", async () => {
  assert.deepEqual(await sweepExtractions(path.join(tmpdir(), "agy-sweep-missing-folder")), { removed: [], kept: [] });
});

test("keeps a folder a running process holds", { skip: process.platform !== "win32" && "Windows locks a process's working folder" }, async (t) => {
  const root = await scratch(t);
  const dir = await extraction(root, "_MEI1", true);
  // A process whose working folder is inside blocks the rename, like a running server does.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: dir, stdio: "ignore" });
  t.after(() => {
    holder.kill();
  });
  await new Promise((resolve) => holder.once("spawn", resolve));
  const result = await sweepExtractions(root, { now: later() });
  assert.deepEqual(result, { removed: [], kept: ["_MEI1"] });
  assert.deepEqual(await readdir(root), ["_MEI1"]);
  holder.kill();
  await new Promise((resolve) => holder.once("exit", resolve));
});

const healthDeps = (overrides: Partial<Parameters<typeof readAntigravityHealth>[1]> = {}) => ({
  loginCommand: "agy_acp_server",
  resolveExecutable: async () => "C:\\Users\\me\\AppData\\Local\\agy-acp-server\\1.4.1\\agy_acp_server.exe",
  readAccount: async () => ({ email: null }),
  ...overrides,
});

test("reports a signed-in server with its version, without starting it", async () => {
  const result = await readAntigravityHealth("agy_acp_server", healthDeps());
  assert.equal(providerHealthResultSchema.safeParse(result).success, true);
  assert.equal(result.health.status, "ready");
  assert.equal(result.health.installedVersion, "1.4.1");
  assert.equal(result.health.canUpdate, true);
  assert.equal(result.health.loginCommand, "agy_acp_server");
});

test("reports a missing, a signed-out and a failing server", async () => {
  const missing = await readAntigravityHealth("agy_acp_server", healthDeps({ resolveExecutable: async () => null }));
  assert.equal(missing.health.status, "not_installed");
  assert.equal(missing.health.canUpdate, false);

  const signedOut = await readAntigravityHealth("agy_acp_server", healthDeps({ readAccount: async () => null }));
  assert.equal(signedOut.health.status, "unauthenticated");

  const failing = await readAntigravityHealth("agy_acp_server", healthDeps({ readAccount: async () => { throw new Error("token unreadable"); } }));
  assert.equal(failing.health.status, "unknown");
  assert.equal(failing.health.statusMessage, "token unreadable");

  const noCommand = await readAntigravityHealth(null, healthDeps());
  assert.equal(noCommand.health.status, "unknown");

  for (const result of [missing, signedOut, failing, noCommand]) {
    assert.equal(providerHealthResultSchema.safeParse(result).success, true);
  }
});
