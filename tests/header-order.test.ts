import assert from "node:assert/strict";
import test from "node:test";

import {
  formatHeaderActionDetail,
  formatHeaderActionLabel,
  orderHeaderRings,
} from "../src/header-order.ts";

const ring = (providerId: string, left: number, failed = false) => ({ providerId, left, failed });
// alphabetical, as the pill lists them
const rings = [ring("acp-opencode", 99), ring("antigravity-cli", 96), ring("claude-code", 61), ring("codex", 82), ring("devin-cli", 59)];
const ids = (list: readonly { providerId: string }[]) => list.map((r) => r.providerId);

// 05.11.2026: in an Antigravity thread the phone header showed Devin, Claude
// and Codex, and Antigravity sat hidden in "+2".
test("on a phone the thread's provider comes first even when it has the most quota left", () => {
  const { shown, hidden } = orderHeaderRings(rings, { currentProviderId: "antigravity-cli", compact: true, limit: 3 });
  assert.deepEqual(ids(shown), ["antigravity-cli", "devin-cli", "claude-code"]);
  assert.equal(hidden, 2);
});

test("on a phone without a known thread provider the tightest come first", () => {
  const { shown, hidden } = orderHeaderRings(rings, { currentProviderId: null, compact: true, limit: 3 });
  assert.deepEqual(ids(shown), ["devin-cli", "claude-code", "codex"]);
  assert.equal(hidden, 2);
});

test("on a desktop the thread's provider leads and the rest keep their order", () => {
  const { shown, hidden } = orderHeaderRings(rings, { currentProviderId: "codex", compact: false, limit: 3 });
  assert.deepEqual(ids(shown), ["codex", "acp-opencode", "antigravity-cli", "claude-code", "devin-cli"]);
  assert.equal(hidden, 0);
});

test("a failing thread provider still comes first, failures elsewhere go last", () => {
  const list = [ring("claude-code", 0, true), ring("codex", 82), ring("devin-cli", 10, true), ring("acp-opencode", 99)];
  const { shown } = orderHeaderRings(list, { currentProviderId: "claude-code", compact: true, limit: 3 });
  assert.deepEqual(ids(shown), ["claude-code", "codex", "acp-opencode"]);
});

test("several accounts of the thread's provider all lead", () => {
  const list = [ring("codex", 82), ring("claude-code", 61), ring("claude-code", 20), ring("devin-cli", 5)];
  const { shown } = orderHeaderRings(list, { currentProviderId: "claude-code", compact: true, limit: 3 });
  assert.deepEqual(ids(shown), ["claude-code", "claude-code", "devin-cli"]);
});

test("a thread provider that reports no usage changes nothing", () => {
  const { shown } = orderHeaderRings(rings, { currentProviderId: "acp-hermes-agent", compact: true, limit: 3 });
  assert.deepEqual(ids(shown), ["devin-cli", "claude-code", "codex"]);
});

test("does not mutate its input", () => {
  const before = JSON.stringify(rings);
  orderHeaderRings(rings, { currentProviderId: "codex", compact: true, limit: 3 });
  assert.equal(JSON.stringify(rings), before);
});

test("formats compact and desktop labels for the header thread action", () => {
  const entries = [
    { providerId: "antigravity-cli", displayName: "Google Antigravity", left: 35, failed: false, summary: "Google Antigravity: Weekly, 35% left" },
    { providerId: "devin-cli", displayName: "Devin", left: 49, failed: false, summary: "Devin: Weekly, 49% left" },
    { providerId: "claude-code", displayName: "Claude Code", left: 36, failed: false, summary: "Claude Code: Weekly, 36% left" },
    { providerId: "codex", displayName: "Codex", left: 20, failed: false, summary: "Codex: Weekly, 20% left" },
  ];
  assert.equal(formatHeaderActionLabel([], 0, { loading: true, compact: false }), "Usage …");
  assert.equal(formatHeaderActionLabel([], 0, { loading: false, compact: true }), "Usage");
  assert.equal(formatHeaderActionLabel(entries.slice(0, 3), 1, { loading: false, compact: true }), "35% · +3");
  assert.equal(formatHeaderActionLabel(entries, 0, { loading: false, compact: false }), "35% · 49% · 36% · +1");
  assert.equal(
    formatHeaderActionDetail(entries.slice(0, 2), "antigravity-cli"),
    "Google Antigravity: Weekly, 35% left (this thread) · Devin: Weekly, 49% left",
  );
});
