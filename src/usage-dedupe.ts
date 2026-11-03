// One provider account reported by several bb hosts (for example the server
// and an enrolled second PC signed in to the same subscription) is one quota.
// Merge those reports into one entry so the pill and the popup show it once.

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
  planLabel: string | null;
  windows: DedupeWindow[];
}

export type Merged<T> = T & { alsoOnHosts: string[] };

const RESET_TOLERANCE_MS = 5 * 60_000;

function sameReset(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return Math.abs(ta - tb) <= RESET_TOLERANCE_MS;
}

function sameWindows(a: DedupeWindow[], b: DedupeWindow[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  // Without a reset time two fresh accounts look identical; do not merge them.
  if (a.every((window) => window.resetsAt === null)) return false;
  return a.every((window, index) => {
    const other = b[index]!;
    return (
      window.label === other.label &&
      Math.round(window.usedPercent) === Math.round(other.usedPercent) &&
      sameReset(window.resetsAt, other.resetsAt)
    );
  });
}

/** True when two reports describe the same provider account. */
export function sameAccount(a: DedupeEntry, b: DedupeEntry): boolean {
  if (a.providerId !== b.providerId || a.hostId === b.hostId) return false;
  if (a.status !== "ok" || b.status !== "ok") return false;
  if (a.accountEmail !== null && b.accountEmail !== null) {
    return a.accountEmail.toLowerCase() === b.accountEmail.toLowerCase();
  }
  if (a.accountEmail !== b.accountEmail) return false;
  return a.planLabel === b.planLabel && sameWindows(a.windows, b.windows);
}

/**
 * Keep one entry per account. `hostOrder` ranks hosts (the server first); the
 * kept entry comes from the best-ranked host and names the others in
 * `alsoOnHosts`. Entries that are not ok are never merged: an error on one
 * host is that host's problem.
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
  const kept: Merged<T>[] = [];
  for (const entry of ordered) {
    const index = kept.findIndex((candidate) => sameAccount(candidate, entry));
    if (index === -1) {
      kept.push({ ...entry, alsoOnHosts: [] });
      continue;
    }
    const target = kept[index]!;
    const name = entry.hostName ?? entry.hostId;
    kept[index] = { ...target, alsoOnHosts: [...target.alsoOnHosts, name] };
  }
  return kept;
}
