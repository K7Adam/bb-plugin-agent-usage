// Order of the rings in the thread header. The provider the thread runs on
// matters most in that moment, so it always leads and is never folded into
// "+n". The rest follow: on a phone the ones closest to their limit (only a
// few fit), on a desktop the pill's order so every ring keeps its place.
// Failed reads go last, except for the thread's own provider.
//
// Pure module: runs under node --test.

export interface OrderableRing {
  providerId: string;
  failed: boolean;
  /** Percent of the headline window still left. */
  left: number;
}

export interface HeaderOrderOptions {
  /** The provider of the thread this header belongs to, null when unknown. */
  currentProviderId: string | null;
  compact: boolean;
  /** Rings shown on a compact header before the rest becomes "+n". */
  limit: number;
}

export function orderHeaderRings<T extends OrderableRing>(
  rings: readonly T[],
  { currentProviderId, compact, limit }: HeaderOrderOptions,
): { shown: T[]; hidden: number } {
  const current = rings.filter((ring) => ring.providerId === currentProviderId);
  const others = rings.filter((ring) => ring.providerId !== currentProviderId);
  const rest = compact
    ? [...others].sort((a, b) => Number(a.failed) - Number(b.failed) || a.left - b.left)
    : others;
  const ordered = [...current, ...rest];
  const shown = compact ? ordered.slice(0, Math.max(limit, current.length)) : ordered;
  return { shown, hidden: ordered.length - shown.length };
}
