/** Pure geometry for the floating usage pill — DOM-free so the drag, dock,
 * fling and dismiss math can be unit-tested. The model deliberately mirrors
 * Android's chat-head / bubble behaviour:
 *
 * - Docking happens on the orientation's hugging edges at a fixed inset that
 *   clears the OS back-gesture strip (the outermost ~24dp on gesture-nav
 *   devices; web content cannot register gesture-exclusion rects, so keeping
 *   the whole hit area outside that strip is the only reliable fix).
 * - Releasing a drag flings: a pointer velocity above FLING_PX_PER_MS picks
 *   the edge the pill flies toward, otherwise the nearest legal edge wins.
 * - Settling uses an overshooting spring curve whose duration scales with
 *   travel distance, like the Rebound springs Messenger uses.
 * - A dismiss target at the bottom-centre of the *visible* viewport hides
 *   the pill, mirroring the "Drag here to hide" target.
 * - All positions derive from the visual viewport (offset + size), so the
 *   pill stays put — proportionally — when the on-screen keyboard shrinks
 *   the visible area or the device rotates. */

export type Position =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export const POSITIONS = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type Orientation = "horizontal" | "vertical";
export const ORIENTATIONS = ["horizontal", "vertical"] as const;

export type DockEdge = "left" | "right" | "top" | "bottom";

export interface Dock {
  edge: DockEdge;
  /** Pill-centre position along the docked edge, 0..1 of the visible span. */
  t: number;
}

/** The visible box in client (layout-viewport) coordinates. With the
 * keyboard closed this is just {w,h,offX:0,offY:0}; when the OSK shrinks
 * the visual viewport, offY/height describe what is actually on screen. */
export interface ViewportBox {
  w: number;
  h: number;
  offX: number;
  offY: number;
}

export const fullViewport = (w: number, h: number): ViewportBox => ({
  w,
  h,
  offX: 0,
  offY: 0,
});

/** Keep the pill's hit area outside the ~24dp back-gesture strip. */
export const EDGE_GAP = 24;
/** While dragging, at least this much of the pill stays visible. */
export const DRAG_MIN_VISIBLE = 24;
/** |v| above this (px/ms) counts as a fling and chooses the edge it flies to. */
export const FLING_PX_PER_MS = 0.5;
/** Drop closer than this to a preset slot centre adopts that preset. */
export const PRESET_MAGNET_PX = 64;
/** Pill centre closer than this to the dismiss target hides the overlay.
 * Kept tight (X circle 28px + ~24px tolerance) so dropping *near* the target
 * still docks/magnets normally — the X only claims its own area. */
export const DISMISS_RADIUS_PX = 52;
/** Dismiss target: 56px circle parked this far above the visible bottom edge. */
export const DISMISS_LIFT_PX = 84;
export const DISMISS_SIZE_PX = 56;

/** Overshoot curve for the settle animation — a gentle chat-head bounce. */
export const SPRING_EASE = "cubic-bezier(0.34, 1.4, 0.64, 1)";

/** Spring settle duration grows with travel distance (like Rebound: more
 * distance → more overshoot time), capped so long flights stay snappy. */
export function springMs(distance: number): number {
  return Math.round(clamp(240 + distance * 0.35, 240, 460));
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** "left:0.62" — written by drag, cleared when a preset is picked. */
export function parseDock(value: unknown): Dock | null {
  if (typeof value !== "string") return null;
  const match = /^(left|right|top|bottom):([01](?:\.\d+)?)$/.exec(value.trim());
  if (match === null) return null;
  const t = Number(match[2]);
  return t >= 0 && t <= 1 ? { edge: match[1] as DockEdge, t } : null;
}

/** Edges a pill may dock to: a vertical rail hugs left/right like a chat
 * head; a horizontal bar hugs top/bottom. */
export function dockEdgesFor(orientation: Orientation): [DockEdge, DockEdge] {
  return orientation === "vertical" ? ["left", "right"] : ["top", "bottom"];
}

export interface PointSample {
  t: number;
  x: number;
  y: number;
}

/** Pointer velocity (px/ms) estimated over a trailing ~120ms window of
 * move samples — the web equivalent of Android's VelocityTracker. */
export function pointerVelocity(samples: PointSample[]): {
  vx: number;
  vy: number;
} {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  let base = samples[0];
  for (const sample of samples) {
    if (last.t - sample.t <= 120) {
      base = sample;
      break;
    }
  }
  const dt = last.t - base.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - base.x) / dt, vy: (last.y - base.y) / dt };
}

/** Which edge a fling flies to; null below the fling threshold. Only the
 * orientation's hugging edges are legal targets. */
export function flingEdge(
  vx: number,
  vy: number,
  orientation: Orientation,
): DockEdge | null {
  const [e1, e2] = dockEdgesFor(orientation);
  const v = orientation === "vertical" ? vx : vy;
  if (Math.abs(v) < FLING_PX_PER_MS) return null;
  return v < 0 ? e1 : e2;
}

/** Docked rest position in client px. The pill centre sits at t along the
 * visible box; EDGE_GAP keeps it out of the OS gesture strip. Callers wrap
 * the edge coordinate in a safe-area max()/min() at the CSS layer. */
export function dockPx(
  dock: Dock,
  vp: ViewportBox,
): { left: number; top: number; transform: string } {
  switch (dock.edge) {
    case "left":
      return {
        left: vp.offX + EDGE_GAP,
        top: vp.offY + dock.t * vp.h,
        transform: "translateY(-50%)",
      };
    case "right":
      return {
        left: vp.offX + vp.w - EDGE_GAP,
        top: vp.offY + dock.t * vp.h,
        transform: "translate(-100%,-50%)",
      };
    case "top":
      return {
        left: vp.offX + dock.t * vp.w,
        top: vp.offY + EDGE_GAP,
        transform: "translateX(-50%)",
      };
    default:
      return {
        left: vp.offX + dock.t * vp.w,
        top: vp.offY + vp.h - EDGE_GAP,
        transform: "translate(-50%,-100%)",
      };
  }
}

/** Preset slot position in client px — same model as docks, so dropping a
 * preset and rendering it later produce identical geometry (no jump), and
 * keyboard-shrunk viewports keep the pill visible. `w`/`h` are the pill
 * size for slots that align by their far edge. */
export function presetPx(
  position: Position,
  vp: ViewportBox,
): { left: number; top: number; transform: string } {
  const x0 = vp.offX + EDGE_GAP;
  const x1 = vp.offX + vp.w - EDGE_GAP;
  const y0 = vp.offY + EDGE_GAP;
  const y1 = vp.offY + vp.h - EDGE_GAP;
  switch (position) {
    case "top-left":
      return { left: x0, top: y0, transform: "none" };
    case "top-center":
      return { left: vp.offX + vp.w / 2, top: y0, transform: "translateX(-50%)" };
    case "top-right":
      return { left: x1, top: y0, transform: "translateX(-100%)" };
    case "bottom-left":
      return { left: x0, top: y1, transform: "translateY(-100%)" };
    case "bottom-center":
      return {
        left: vp.offX + vp.w / 2,
        top: y1,
        transform: "translate(-50%,-100%)",
      };
    default:
      return { left: x1, top: y1, transform: "translate(-100%,-100%)" };
  }
}

/** Centre point of each preset slot — where the pill centre would rest.
 * Needs the pill size because far-edge slots translate by their own box. */
export function presetAnchors(
  vp: ViewportBox,
  w: number,
  h: number,
): { position: Position; x: number; y: number }[] {
  const g = EDGE_GAP;
  return [
    { position: "top-left", x: vp.offX + g + w / 2, y: vp.offY + g + h / 2 },
    {
      position: "top-center",
      x: vp.offX + vp.w / 2,
      y: vp.offY + g + h / 2,
    },
    {
      position: "top-right",
      x: vp.offX + vp.w - g - w / 2,
      y: vp.offY + g + h / 2,
    },
    {
      position: "bottom-left",
      x: vp.offX + g + w / 2,
      y: vp.offY + vp.h - g - h / 2,
    },
    {
      position: "bottom-center",
      x: vp.offX + vp.w / 2,
      y: vp.offY + vp.h - g - h / 2,
    },
    {
      position: "bottom-right",
      x: vp.offX + vp.w - g - w / 2,
      y: vp.offY + vp.h - g - h / 2,
    },
  ];
}

/** Centre of the dismiss target — a 56px circle parked DISMISS_LIFT_PX above
 * the visible bottom edge (plus the CSS safe-area lift applied at render). */
export function dismissPoint(vp: ViewportBox): { x: number; y: number } {
  return {
    x: vp.offX + vp.w / 2,
    y: vp.offY + vp.h - DISMISS_LIFT_PX + DISMISS_SIZE_PX / 2,
  };
}

export type DropResult =
  | { kind: "dismiss" }
  | { kind: "preset"; position: Position }
  | { kind: "dock"; dock: Dock };

/** Resolve a committed drop: dismiss target wins, then a nearby preset slot
 * (magnet), then an edge dock where a fling's direction beats proximity —
 * the chat-head rule that a flick always reaches the edge it flies toward. */
export function dropTarget(opts: {
  cx: number;
  cy: number;
  w: number;
  h: number;
  vp: ViewportBox;
  orientation: Orientation;
  vx?: number;
  vy?: number;
  dismiss?: { x: number; y: number } | null;
}): DropResult {
  const { cx, cy, w, h, vp, orientation } = opts;

  if (
    opts.dismiss &&
    Math.hypot(opts.dismiss.x - cx, opts.dismiss.y - cy) <= DISMISS_RADIUS_PX
  ) {
    return { kind: "dismiss" };
  }

  let nearest: { position: Position; dist: number } | null = null;
  for (const anchor of presetAnchors(vp, w, h)) {
    const dist = Math.hypot(anchor.x - cx, anchor.y - cy);
    if (nearest === null || dist < nearest.dist) {
      nearest = { position: anchor.position, dist };
    }
  }
  if (nearest !== null && nearest.dist <= PRESET_MAGNET_PX) {
    return { kind: "preset", position: nearest.position };
  }

  const vertical = orientation === "vertical";
  const fling = flingEdge(opts.vx ?? 0, opts.vy ?? 0, orientation);
  const edge: DockEdge =
    fling ??
    (vertical
      ? cx < vp.offX + vp.w / 2
        ? "left"
        : "right"
      : cy < vp.offY + vp.h / 2
        ? "top"
        : "bottom");
  // Fraction along the edge, clamped so the pill stays fully inside the
  // visible box with EDGE_GAP clearance at both ends.
  const half = vertical ? h / 2 : w / 2;
  const span = vertical ? vp.h : vp.w;
  const raw = vertical ? cy - vp.offY : cx - vp.offX;
  const lo = (half + EDGE_GAP) / span;
  const t = clamp(raw / span, Math.min(lo, 0.5), Math.max(1 - lo, 0.5));
  return { kind: "dock", dock: { edge, t } };
}

/** Clamp a live-drag position so at least DRAG_MIN_VISIBLE of the pill
 * stays inside the visible box on every side. */
export function clampDrag(
  left: number,
  top: number,
  w: number,
  h: number,
  vp: ViewportBox,
): { left: number; top: number } {
  return {
    left: clamp(
      left,
      vp.offX - w + DRAG_MIN_VISIBLE,
      vp.offX + vp.w - DRAG_MIN_VISIBLE,
    ),
    top: clamp(
      top,
      vp.offY - h + DRAG_MIN_VISIBLE,
      vp.offY + vp.h - DRAG_MIN_VISIBLE,
    ),
  };
}
