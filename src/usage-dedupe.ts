// One provider account reported by several bb hosts (for example the server
// and an enrolled second PC signed in to the same subscription) is one quota.
// Merge those reports into one entry so the pill and the popup show it once.
//
// Two cases used to leave a second chip (05.11.2026):
// - a host that is not signed in, or fails to read usage, reported its own
//   greyed-out entry next to the working one. Such a report now hangs off the
//   provider's entry as an issue instead of becoming a chip of its own.
// - an account without email (Antigravity) was read on two hosts minutes
//   apart: the reset times matched to the second, usage read 4 % and 3 %.
//   Matching reset times are what identify the account; usage may drift.

export interface DedupeWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface DedupeEntry {
  providerId: string;
  hostId: string;
  hostName: string | null;
  status: string;
  accountEmail: string | null;
  /** A stable account id some providers report (e.g. Codex), stronger than the email. */
  accountKey?: string | null;
  planLabel: string | null;
  windows: DedupeWindow[];
}

export interface HostIssue {
  host: string;
  status: string;
}

export type Merged<T> = T & { alsoOnHosts: string[]; issuesOnHosts: HostIssue[] };

const RESET_TOLERANCE_MS = 5 * 60_000;

function sameReset(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return Math.abs(ta - tb) <= RESET_TOLERANCE_MS;
}

// A reset on a full hour (a calendar week, a daily quota at 08:00) is shared by
// every account of a provider. A rolling window resets at an odd second that
// only this account has.
function isDistinctive(resetsAt: string | null): boolean {
  if (resetsAt === null) return false;
  const time = Date.parse(resetsAt);
  return !Number.isNaN(time) && time % 3_600_000 !== 0;
}

function byLabel(windows: DedupeWindow[]): Map<string, DedupeWindow> {
  return new Map(windows.map((window) => [window.label, window]));
}

function sameWindows(a: DedupeWindow[], b: DedupeWindow[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const others = byLabel(b);
  if (others.size !== a.length || byLabel(a).size !== a.length) return false;
  // Without a reset time two fresh accounts look identical; do not merge them.
  if (a.every((window) => window.resetsAt === null)) return false;
  const pairs = a.map((window) => [window, others.get(window.label)] as const);
  if (pairs.some(([, other]) => other === undefined)) return false;
  if (!pairs.every(([window, other]) => sameReset(window.resetsAt, other!.resetsAt))) return false;
  // Matching odd reset times identify the account even when the two reads
  // were taken minutes apart and usage moved in between.
  if (pairs.some(([window]) => isDistinctive(window.resetsAt))) return true;
  return pairs.every(([window, other]) => Math.round(window.usedPercent) === Math.round(other!.usedPercent));
}

/** True when two working reports describe the same provider account. */
export function sameAccount(a: DedupeEntry, b: DedupeEntry): boolean {
  if (a.providerId !== b.providerId || a.hostId === b.hostId) return false;
  if (a.status !== "ok" || b.status !== "ok") return false;
  const keyA = a.accountKey ?? null;
  const keyB = b.accountKey ?? null;
  if (keyA !== null && keyB !== null) return keyA === keyB;
  if (a.accountEmail !== null && b.accountEmail !== null) {
    return a.accountEmail.toLowerCase() === b.accountEmail.toLowerCase();
  }
  if (a.accountEmail !== b.accountEmail) return false;
  return a.planLabel === b.planLabel && sameWindows(a.windows, b.windows);
}

// Usage only grows inside one window, so the higher of two readings is the newer.
function newerWindows<W extends DedupeWindow>(kept: W[], other: DedupeWindow[]): W[] {
  const others = byLabel(other);
  return kept.map((window) => {
    const reading = others.get(window.label);
    return reading && reading.usedPercent > window.usedPercent ? { ...window, usedPercent: reading.usedPercent } : window;
  });
}

/**
 * Keep one entry per account. `hostOrder` ranks hosts (the server first); the
 * kept entry comes from the best-ranked host and names the others in
 * `alsoOnHosts`. A report that is not ok (not signed in, not installed, an
 * error) never becomes a second entry next to a provider that is shown
 * already: it is listed in that entry's `issuesOnHosts`.
 */
export function mergeSameAccounts<T extends DedupeEntry>(
  entries: readonly T[],
  hostOrder: readonly string[],
): Merged<T>[] {
  const rank = (hostId: string) => {
    const index = hostOrder.indexOf(hostId);
    return index === -1 ? hostOrder.length : index;
  };
  const ordered = [...entries].sort((a, b) => rank(a.hostId) - rank(b.hostId));
  const working = ordered.filter((entry) => entry.status === "ok");
  const failing = ordered.filter((entry) => entry.status !== "ok");

  const kept: Merged<T>[] = [];
  for (const entry of working) {
    const index = kept.findIndex((candidate) => sameAccount(candidate, entry));
    if (index === -1) {
      kept.push({ ...entry, alsoOnHosts: [], issuesOnHosts: [] });
      continue;
    }
    const target = kept[index]!;
    kept[index] = {
      ...target,
      windows: newerWindows(target.windows, entry.windows),
      alsoOnHosts: [...target.alsoOnHosts, entry.hostName ?? entry.hostId],
    };
  }

  for (const entry of failing) {
    const issue = { host: entry.hostName ?? entry.hostId, status: entry.status };
    // The provider's first entry from another host takes the issue; a provider
    // that fails on one host only keeps its own entry.
    const index = kept.findIndex((candidate) => candidate.providerId === entry.providerId && candidate.hostId !== entry.hostId);
    if (index === -1) {
      kept.push({ ...entry, alsoOnHosts: [], issuesOnHosts: [] });
      continue;
    }
    const target = kept[index]!;
    kept[index] = { ...target, issuesOnHosts: [...target.issuesOnHosts, issue] };
  }
  return kept;
}
