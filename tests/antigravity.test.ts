import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyAgyError,
  findUsageEnvelope,
  FRESH_OK_MS,
  FRESH_OTHER_MS,
  isFresh,
  isModelTurn,
  isSameVerifiedAgy,
  isSupportedVersion,
  mapAgyUsage,
  parseVersion,
  readAntigravityAccount,
} from "../src/collectors/antigravity.ts";

const envelope = {
  status: "SUCCESS",
  response: "Usage …",
  num_turns: 0,
  conversation_id: "",
  command: {
    name: "usage",
    data: {
      description: "Quota",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.989, reset_time: "2026-10-26T05:57:50Z" },
            { id: "gemini-5h", name: "5 hours", window: "5h", remaining_fraction: 0.998, reset_time: "2026-10-19T20:29:05Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.398, reset_time: "2026-10-23T16:39:09Z" },
            { id: "3p-5h", name: "5 hours", window: "5h", remaining_fraction: 1, reset_time: "2026-10-19T21:19:52Z", disabled: true },
          ],
        },
      ],
    },
  },
};

test("finds the JSON envelope among other stdout lines", () => {
  const found = findUsageEnvelope(`Loading…\n${JSON.stringify(envelope)}\n`);
  assert.equal(found?.status, "SUCCESS");
  assert.equal(findUsageEnvelope("no json here"), null);
});

test("maps buckets to windows and skips disabled ones", () => {
  const result = mapAgyUsage(envelope);
  if (!result.supported || result.usage.status !== "ok") assert.fail("expected ok usage");
  assert.deepEqual(
    result.usage.windows.map((window) => [window.id, window.kind, window.usedPercent, window.model]),
    [
      ["gemini-weekly", "weekly", 1, "Gemini Models"],
      ["gemini-5h", "five-hour", 0, "Gemini Models"],
      ["3p-weekly", "weekly", 60, "Claude and GPT models"],
    ],
  );
  assert.equal(result.usage.windows[2].resetsAt, "2026-10-23T16:39:09.000Z");
});

test("detects a model turn instead of the command reply", () => {
  assert.equal(isModelTurn(envelope), false);
  assert.equal(isModelTurn({ num_turns: 1 }), true);
  assert.equal(isModelTurn({ num_turns: 0, conversation_id: "abc" }), true);
});

test("classifies AGY_ERROR lines and signed-out text", () => {
  const signedOut = classifyAgyError('AGY_ERROR:{"status":"UNAUTHENTICATED","error_code":401}');
  assert.equal(signedOut?.supported && signedOut.usage.status, "unauthenticated");
  const limited = classifyAgyError('AGY_ERROR:{"status":"RESOURCE_EXHAUSTED","error_code":429}');
  assert.equal(limited?.supported && limited.usage.status, "error");
  const loggedOut = classifyAgyError("You are not logged in. Run agy login.");
  assert.equal(loggedOut?.supported && loggedOut.usage.status, "unauthenticated");
  const apiKey = classifyAgyError("GEMINI_API_KEY has no account quota; view usage in AI Studio.");
  assert.equal(apiKey?.supported && apiKey.usage.status, "error");
  assert.equal(classifyAgyError("all good"), null);
});

test("invalidates cached agy version when the binary timestamp or size changes", () => {
  const known = { path: "C:\\agy.exe", version: [1, 5, 0], mtimeMs: 1000, size: 500 };
  assert.equal(isSameVerifiedAgy(known, "C:\\agy.exe", { mtimeMs: 1000, size: 500 }), true);
  assert.equal(isSameVerifiedAgy(known, "C:\\agy.exe", { mtimeMs: 2000, size: 500 }), false);
  assert.equal(isSameVerifiedAgy(known, "C:\\agy.exe", { mtimeMs: 1000, size: 600 }), false);
  assert.equal(isSameVerifiedAgy({ path: "C:\\agy.exe", version: [1, 5, 0] }, "C:\\agy.exe", { mtimeMs: 1000, size: 500 }), false);
});

test("detects Antigravity auth via acp_token.json, GEMINI_API_KEY, and ADC env vars", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-auth-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  assert.equal(await readAntigravityAccount({}, home), null);
  assert.deepEqual(await readAntigravityAccount({ GEMINI_API_KEY: "test-key" }, home), { email: null });
  assert.deepEqual(await readAntigravityAccount({ AGY_ADC_AUTH: "1" }, home), { email: null });
  assert.equal(await readAntigravityAccount({ AGY_ADC_AUTH: "false" }, home), null);
  assert.deepEqual(await readAntigravityAccount({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" }, home), { email: null });

  const tokenDir = path.join(home, ".gemini", "antigravity-acp");
  await mkdir(tokenDir, { recursive: true });
  await writeFile(path.join(tokenDir, "acp_token.json"), "{}");
  assert.deepEqual(await readAntigravityAccount({}, home), { email: null });
});

test("requires agy 1.1.11 or newer", () => {
  assert.deepEqual(parseVersion("agy 1.4.2"), [1, 4, 2]);
  assert.equal(isSupportedVersion([1, 4, 2]), true);
  assert.equal(isSupportedVersion([1, 1, 11]), true);
  assert.equal(isSupportedVersion([1, 1, 10]), false);
  assert.equal(isSupportedVersion([0, 9, 0]), false);
});

test("keeps good results fresh for the ok window and others for one minute", () => {
  const ok: Parameters<typeof isFresh>[0] = {
    at: 0,
    result: { supported: true, usage: { status: "ok", accountEmail: null, planLabel: null, windows: [] } },
  };
  const failed: Parameters<typeof isFresh>[0] = { at: 0, result: { supported: true, usage: { status: "unauthenticated" } } };
  assert.equal(isFresh(ok, FRESH_OK_MS - 1), true);
  assert.equal(isFresh(ok, FRESH_OK_MS), false);
  assert.equal(isFresh(failed, FRESH_OTHER_MS - 1), true);
  assert.equal(isFresh(failed, FRESH_OTHER_MS), false);
});
