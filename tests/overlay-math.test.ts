import assert from "node:assert/strict";
import test from "node:test";

import {
  clampDrag,
  DISMISS_LIFT_PX,
  DISMISS_SIZE_PX,
  dismissPoint,
  dockEdgesFor,
  dockPx,
  dropTarget,
  EDGE_GAP,
  flingEdge,
  FLING_PX_PER_MS,
  fullViewport,
  parseDock,
  pointerVelocity,
  presetAnchors,
  presetPx,
  springMs,
  type ViewportBox,
} from "../src/overlay-math.ts";

const VP = fullViewport(390, 844); // iPhone-ish portrait
const KEYBOARD_VP: ViewportBox = { w: 390, h: 460, offX: 0, offY: 0 };
const PILL = { w: 120, h: 40 };

test("parseDock accepts edge:fraction and rejects malformed values", () => {
  assert.deepEqual(parseDock("left:0.62"), { edge: "left", t: 0.62 });
  assert.deepEqual(parseDock("bottom:0"), { edge: "bottom", t: 0 });
  assert.deepEqual(parseDock("top:1"), { edge: "top", t: 1 });
  assert.equal(parseDock("left:1.5"), null);
  assert.equal(parseDock("diag:0.5"), null);
  assert.equal(parseDock("left:abc"), null);
  assert.equal(parseDock(42), null);
  assert.equal(parseDock(""), null);
});

test("dockEdgesFor maps orientation to its hugging edges", () => {
  assert.deepEqual(dockEdgesFor("vertical"), ["left", "right"]);
  assert.deepEqual(dockEdgesFor("horizontal"), ["top", "bottom"]);
});

test("pointerVelocity computes px/ms over the trailing 120ms window", () => {
  assert.deepEqual(pointerVelocity([]), { vx: 0, vy: 0 });
  assert.deepEqual(pointerVelocity([{ t: 0, x: 0, y: 0 }]), { vx: 0, vy: 0 });
  const v = pointerVelocity([
    { t: 0, x: 0, y: 0 },
    { t: 50, x: 40, y: -20 },
    { t: 100, x: 80, y: -40 },
  ]);
  assert.equal(v.vx, 0.8);
  assert.equal(v.vy, -0.4);
  // A long pause before release decays velocity to ~0 (finger held still).
  const stalled = pointerVelocity([
    { t: 0, x: 0, y: 0 },
    { t: 50, x: 300, y: 0 },
    { t: 500, x: 300, y: 0 },
  ]);
  assert.equal(stalled.vx, 0);
});

test("flingEdge honours orientation and the px/ms threshold", () => {
  assert.equal(flingEdge(0, 0, "vertical"), null);
  assert.equal(flingEdge(FLING_PX_PER_MS - 0.01, 2, "vertical"), null);
  assert.equal(flingEdge(1, 0, "vertical"), "right");
  assert.equal(flingEdge(-1, 0, "vertical"), "left");
  // Vertical pills ignore vertical flings; horizontal ignore horizontal.
  assert.equal(flingEdge(0, 3, "vertical"), null);
  assert.equal(flingEdge(3, 0, "horizontal"), null);
  assert.equal(flingEdge(0, -1, "horizontal"), "top");
  assert.equal(flingEdge(0, 1, "horizontal"), "bottom");
});

test("dockPx rests the pill EDGE_GAP inside the visible box", () => {
  const left = dockPx({ edge: "left", t: 0.5 }, VP);
  assert.equal(left.left, EDGE_GAP);
  assert.equal(left.top, 422);
  assert.equal(left.transform, "translateY(-50%)");

  const right = dockPx({ edge: "right", t: 0.25 }, VP);
  assert.equal(right.left, 390 - EDGE_GAP);
  assert.equal(right.top, 211);
  assert.equal(right.transform, "translate(-100%,-50%)");

  const bottom = dockPx({ edge: "bottom", t: 0.5 }, VP);
  assert.equal(bottom.left, 195);
  assert.equal(bottom.top, 844 - EDGE_GAP);
  assert.equal(bottom.transform, "translate(-50%,-100%)");
});

test("dockPx follows the visual viewport when the keyboard shrinks it", () => {
  const px = dockPx({ edge: "left", t: 0.9 }, KEYBOARD_VP);
  assert.equal(px.top, 414); // 0.9 * 460 — proportional, stays visible
  const offset: ViewportBox = { w: 390, h: 700, offX: 0, offY: 144 };
  const moved = dockPx({ edge: "left", t: 0.9 }, offset);
  assert.equal(moved.top, 144 + 0.9 * 700);
});

test("presetPx corner and centre slots resolve with transforms", () => {
  assert.deepEqual(presetPx("top-left", VP), {
    left: EDGE_GAP,
    top: EDGE_GAP,
    transform: "none",
  });
  assert.deepEqual(presetPx("bottom-center", VP), {
    left: 195,
    top: 844 - EDGE_GAP,
    transform: "translate(-50%,-100%)",
  });
  assert.equal(presetPx("top-right", VP).left, 390 - EDGE_GAP);
});

test("presetAnchors are the pill-centre rest points of each slot", () => {
  const anchors = presetAnchors(VP, PILL.w, PILL.h);
  assert.equal(anchors.length, 6);
  const tl = anchors.find((a) => a.position === "top-left")!;
  assert.equal(tl.x, EDGE_GAP + PILL.w / 2);
  assert.equal(tl.y, EDGE_GAP + PILL.h / 2);
  const br = anchors.find((a) => a.position === "bottom-right")!;
  assert.equal(br.x, 390 - EDGE_GAP - PILL.w / 2);
  assert.equal(br.y, 844 - EDGE_GAP - PILL.h / 2);
});

test("dismissPoint parks the X above the visible bottom edge", () => {
  const p = dismissPoint(VP);
  assert.equal(p.x, 195);
  assert.equal(p.y, 844 - DISMISS_LIFT_PX + DISMISS_SIZE_PX / 2);
});

test("dropTarget: releasing on the dismiss target hides the overlay", () => {
  const p = dismissPoint(VP);
  const result = dropTarget({
    cx: p.x,
    cy: p.y,
    w: PILL.w,
    h: PILL.h,
    vp: VP,
    orientation: "vertical",
    dismiss: p,
  });
  assert.deepEqual(result, { kind: "dismiss" });
  // A drop away from the target (and outside every preset magnet) docks.
  const near = dropTarget({
    cx: 195,
    cy: 600,
    w: PILL.w,
    h: PILL.h,
    vp: VP,
    orientation: "vertical",
    dismiss: p,
  });
  assert.equal(near.kind, "dock");
});

test("dropTarget: a drop near a preset slot adopts the preset", () => {
  const anchor = presetAnchors(VP, PILL.w, PILL.h).find(
    (a) => a.position === "bottom-right",
  )!;
  const result = dropTarget({
    cx: anchor.x + 10,
    cy: anchor.y - 10,
    w: PILL.w,
    h: PILL.h,
    vp: VP,
    orientation: "vertical",
  });
  assert.deepEqual(result, { kind: "preset", position: "bottom-right" });
});

test("dropTarget: slow releases dock to the nearest legal edge", () => {
  const left = dropTarget({
    cx: 60,
    cy: 400,
    w: 40,
    h: 120,
    vp: VP,
    orientation: "vertical",
  });
  assert.deepEqual(left, { kind: "dock", dock: { edge: "left", t: 400 / 844 } });
  const top = dropTarget({
    cx: 300,
    cy: 200,
    w: 120,
    h: 40,
    vp: VP,
    orientation: "horizontal",
  });
  assert.deepEqual(top, { kind: "dock", dock: { edge: "top", t: 300 / 390 } });
});

test("dropTarget: a fling reaches the edge it flies toward, not the nearest", () => {
  // Released left-of-centre but flicked hard rightwards → docks right.
  const result = dropTarget({
    cx: 120,
    cy: 400,
    w: 40,
    h: 120,
    vp: VP,
    orientation: "vertical",
    vx: 1.4,
    vy: 0,
  });
  assert.equal(result.kind, "dock");
  assert.equal((result as { dock: { edge: string } }).dock.edge, "right");
});

test("dropTarget: t clamps so the pill stays inside EDGE_GAP bounds", () => {
  const result = dropTarget({
    cx: 20,
    cy: 10, // jammed against the top edge, clear of preset magnets
    w: 40,
    h: 120,
    vp: VP,
    orientation: "vertical",
  });
  assert.equal(result.kind, "dock");
  const t = (result as { dock: { t: number } }).dock.t;
  // Pill centre never closer than half-height + EDGE_GAP from the edge.
  assert.equal(t, (120 / 2 + EDGE_GAP) / 844);
});

test("dropTarget resolves against the keyboard-shrunk viewport", () => {
  const result = dropTarget({
    cx: 30,
    cy: 10,
    w: 40,
    h: 120,
    vp: KEYBOARD_VP,
    orientation: "vertical",
  });
  assert.equal(result.kind, "dock");
  const t = (result as { dock: { t: number } }).dock.t;
  // t is a fraction of the *visible* span — clamped by the same geometry.
  assert.equal(t, (120 / 2 + EDGE_GAP) / 460);
});

test("clampDrag keeps DRAG_MIN_VISIBLE of the pill inside the box", () => {
  const p = clampDrag(-500, -500, PILL.w, PILL.h, VP);
  assert.equal(p.left, -PILL.w + 24);
  assert.equal(p.top, -PILL.h + 24);
  const q = clampDrag(9999, 9999, PILL.w, PILL.h, VP);
  assert.equal(q.left, 390 - 24);
  assert.equal(q.top, 844 - 24);
  const inside = clampDrag(100, 200, PILL.w, PILL.h, VP);
  assert.deepEqual(inside, { left: 100, top: 200 });
  // Offsets (scrolled visual viewport) bound the clamp too.
  const offset: ViewportBox = { w: 390, h: 700, offX: 0, offY: 144 };
  const r = clampDrag(0, 9999, PILL.w, PILL.h, offset);
  assert.equal(r.top, 144 + 700 - 24);
});

test("springMs scales with distance inside its bounds", () => {
  assert.equal(springMs(0), 240);
  assert.equal(springMs(-50), 240);
  assert.equal(springMs(1000), 460);
  const mid = springMs(300);
  assert.ok(mid > 240 && mid < 460, `mid ${mid}`);
});
