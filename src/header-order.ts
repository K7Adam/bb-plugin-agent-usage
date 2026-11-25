// Order and compact formatting of usage summaries in the thread header. The
// provider the thread runs on matters most in that moment, so it always leads
// and is never folded into "+n". The rest follow: on a phone the ones closest
// to their limit (only a few fit), on a desktop the pill's order so every entry
// keeps its place. Failed reads go last, except for the thread's own provider.
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
  /** Entries shown on a compact header before the rest becomes "+n". */
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

export interface HeaderActionEntry extends OrderableRing {
  displayName: string;
  summary: string;
}

/** Short label for the `experimental_threadAction` header button. */
export function formatHeaderActionLabel(
  shown: readonly HeaderActionEntry[],
  hidden: number,
  options: { loading: boolean; compact: boolean },
): string {
  if (shown.length === 0) return options.loading ? "Usage …" : "Usage";
  const lead = shown[0]!;
  const pct = (entry: HeaderActionEntry) => (entry.failed ? "!" : `${entry.left}%`);
  if (options.compact) {
    const restCount = shown.length - 1 + hidden;
    return restCount > 0 ? `${pct(lead)} · +${restCount}` : pct(lead);
  }
  const parts = shown.slice(0, 3).map(pct);
  const extra = Math.max(0, shown.length - 3) + hidden;
  if (extra > 0) parts.push(`+${extra}`);
  return parts.join(" · ");
}

/** Detail line / tooltip summarizing every ordered provider for the header action. */
export function formatHeaderActionDetail(
  ordered: readonly HeaderActionEntry[],
  currentProviderId: string | null,
): string | undefined {
  if (ordered.length === 0) return undefined;
  return ordered
    .map((entry) =>
      entry.providerId === currentProviderId ? `${entry.summary} (this thread)` : entry.summary,
    )
    .join(" · ");
}

export interface LegacyThreadHeaderActionRegistration<TComponent> {
  id: string;
  title: string;
  component: TComponent;
}

export interface HeaderUsageSlots<TComponent, TModern> {
  experimental_threadHeaderAction?(
    registration: LegacyThreadHeaderActionRegistration<TComponent>,
  ): void;
  experimental_threadAction(registration: TModern): void;
}

/**
 * Registers the ring header component when the host still exposes the legacy
 * `experimental_threadHeaderAction` slot, falling back to `experimental_threadAction`.
 */
export function registerHeaderUsageSlot<TComponent, TModern>(
  slots: HeaderUsageSlots<TComponent, TModern>,
  legacy: LegacyThreadHeaderActionRegistration<TComponent>,
  modern: TModern,
): "legacy" | "modern" {
  if (typeof slots.experimental_threadHeaderAction === "function") {
    slots.experimental_threadHeaderAction(legacy);
    return "legacy";
  }
  slots.experimental_threadAction(modern);
  return "modern";
}
