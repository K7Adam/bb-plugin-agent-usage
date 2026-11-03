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

test("never merges errors and never merges entries of one host", () => {
  const merged = mergeSameAccounts(
    [
      entry({ status: "error", windows: [] }),
      entry({ hostId: "host_omen", status: "error", windows: [] }),
      entry({ providerId: "codex" }),
      entry({ providerId: "codex" }),
    ],
    ORDER,
  );
  assert.equal(merged.length, 4);
});

test("does not mutate its input", () => {
  const input = [entry({ hostId: "host_omen", hostName: "OMEN" }), entry()];
  const snapshot = JSON.stringify(input);
  mergeSameAccounts(input, ORDER);
  assert.equal(JSON.stringify(input), snapshot);
});
