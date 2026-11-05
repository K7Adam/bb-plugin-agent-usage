import assert from "node:assert/strict";
import test from "node:test";

import { mergeSameAccounts, type DedupeEntry } from "../src/usage-dedupe.ts";

const RESET = "2026-11-08T10:00:00.000Z";

function entry(overrides: Partial<DedupeEntry> = {}): DedupeEntry {
  return {
    providerId: "claude-code",
    hostId: "host_work",
    hostName: "Work Venneker",
    status: "ok",
    accountEmail: null,
    planLabel: "Max",
    windows: [{ label: "Weekly limit", usedPercent: 25, resetsAt: RESET }],
    ...overrides,
  };
}

const ORDER = ["host_work", "host_omen"];

test("merges the same account reported by two hosts and keeps the server's entry", () => {
  const merged = mergeSameAccounts(
    [entry({ hostId: "host_omen", hostName: "OMEN" }), entry()],
    ORDER,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.hostId, "host_work");
  assert.deepEqual(merged[0]!.alsoOnHosts, ["OMEN"]);
});

test("matches by account email, case-insensitively, even when usage differs slightly", () => {
  const merged = mergeSameAccounts(
    [
      entry({ accountEmail: "Adam@Example.test" }),
      entry({
        hostId: "host_omen",
        hostName: "OMEN",
        accountEmail: "adam@example.test",
        windows: [{ label: "Weekly limit", usedPercent: 26, resetsAt: RESET }],
      }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 1);
});

test("keeps two different accounts of the same provider apart", () => {
  const merged = mergeSameAccounts(
    [
      entry({ accountEmail: "a@example.test" }),
      entry({ hostId: "host_omen", accountEmail: "b@example.test" }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 2);
});

test("keeps accounts without email apart when their usage differs", () => {
  const merged = mergeSameAccounts(
    [
      entry(),
      entry({
        hostId: "host_omen",
        windows: [{ label: "Weekly limit", usedPercent: 60, resetsAt: RESET }],
      }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 2);
});

test("tolerates a few minutes of drift between reset times", () => {
  const merged = mergeSameAccounts(
    [
      entry(),
      entry({
        hostId: "host_omen",
        windows: [{ label: "Weekly limit", usedPercent: 25, resetsAt: "2026-11-08T10:02:30.000Z" }],
      }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 1);
});

test("does not merge fresh accounts that carry no reset time", () => {
  const fresh = [{ label: "Weekly", usedPercent: 0, resetsAt: null }];
  const merged = mergeSameAccounts(
    [entry({ windows: fresh }), entry({ hostId: "host_omen", windows: fresh })],
    ORDER,
  );
  assert.equal(merged.length, 2);
});

test("never merges entries of one host", () => {
  const merged = mergeSameAccounts(
    [entry({ providerId: "codex" }), entry({ providerId: "codex" })],
    ORDER,
  );
  assert.equal(merged.length, 2);
});

test("shows a provider that fails on every host once, with the other hosts as issues", () => {
  const merged = mergeSameAccounts(
    [
      entry({ hostId: "host_omen", hostName: "OMEN", status: "error", windows: [] }),
      entry({ status: "unauthenticated", windows: [] }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.hostId, "host_work");
  assert.equal(merged[0]!.status, "unauthenticated");
  assert.deepEqual(merged[0]!.issuesOnHosts, [{ host: "OMEN", status: "error" }]);
});

// Seen on 05.11.2026: Claude Code signed out on OMEN showed a second, greyed-out chip.
test("folds a host that is not signed in into the working entry of the same provider", () => {
  const merged = mergeSameAccounts(
    [
      entry({ hostId: "host_omen", hostName: "OMEN", status: "unauthenticated", windows: [], planLabel: null }),
      entry({ accountEmail: "adam@example.test" }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.status, "ok");
  assert.deepEqual(merged[0]!.alsoOnHosts, []);
  assert.deepEqual(merged[0]!.issuesOnHosts, [{ host: "OMEN", status: "unauthenticated" }]);
});

// Seen on 05.11.2026: Antigravity reports no email. Both hosts read the same quota a few
// minutes apart, so the reset times matched to the second while usage read 4 % and 3 %.
test("merges an account without email whose distinctive reset times match while usage drifted", () => {
  const server = [
    { label: "Gemini Models · Weekly", usedPercent: 4, resetsAt: "2026-11-09T05:57:50.000Z" },
    { label: "Gemini Models · 5 hours", usedPercent: 4, resetsAt: "2026-11-05T12:01:40.000Z" },
  ];
  const omen = [
    { label: "Gemini Models · 5 hours", usedPercent: 3, resetsAt: "2026-11-05T12:01:40.000Z" },
    { label: "Gemini Models · Weekly", usedPercent: 3, resetsAt: "2026-11-09T05:57:50.000Z" },
  ];
  const merged = mergeSameAccounts(
    [
      entry({ providerId: "antigravity-cli", hostId: "host_omen", hostName: "OMEN", planLabel: null, windows: omen }),
      entry({ providerId: "antigravity-cli", planLabel: null, windows: server }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.alsoOnHosts, ["OMEN"]);
  // usage only grows inside a window, so the higher reading is the newer one
  assert.deepEqual(
    merged[0]!.windows.map((w) => w.usedPercent),
    [4, 4],
  );
});

test("keeps accounts apart when their distinctive reset times differ", () => {
  const merged = mergeSameAccounts(
    [
      entry({ windows: [{ label: "5 hours", usedPercent: 4, resetsAt: "2026-11-05T12:01:40.000Z" }] }),
      entry({ hostId: "host_omen", windows: [{ label: "5 hours", usedPercent: 4, resetsAt: "2026-11-05T14:37:12.000Z" }] }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 2);
});

test("an account key decides before usage: different keys stay apart, equal keys merge", () => {
  const apart = mergeSameAccounts(
    [entry({ accountKey: "openai:a" }), entry({ hostId: "host_omen", accountKey: "openai:b" })],
    ORDER,
  );
  assert.equal(apart.length, 2);
  const together = mergeSameAccounts(
    [
      entry({ accountKey: "openai:a" }),
      entry({
        hostId: "host_omen",
        accountKey: "openai:a",
        windows: [{ label: "Weekly limit", usedPercent: 70, resetsAt: null }],
      }),
    ],
    ORDER,
  );
  assert.equal(together.length, 1);
});

test("does not mutate its input", () => {
  const input = [entry({ hostId: "host_omen", hostName: "OMEN" }), entry()];
  const snapshot = JSON.stringify(input);
  mergeSameAccounts(input, ORDER);
  assert.equal(JSON.stringify(input), snapshot);
});
