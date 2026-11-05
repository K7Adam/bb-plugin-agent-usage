import assert from "node:assert/strict";
import test from "node:test";

import {
  layoutKey,
  placementFor,
  readLayout,
  writeLayout,
  type LayoutStorage,
} from "../src/device-layout.ts";

function memoryStorage(initial: Record<string, string> = {}): LayoutStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

test("desktop and mobile keep their positions under separate keys", () => {
  const storage = memoryStorage();
  writeLayout(storage, "desktop", { dock: "right:0.6000", position: "bottom-right" });
  writeLayout(storage, "mobile", { dock: "left:0.2000", position: "top-left" });
  assert.notEqual(layoutKey("desktop"), layoutKey("mobile"));
  const fallback = { dock: "", position: "bottom-right" };
  assert.deepEqual(readLayout(storage, "desktop", fallback), { dock: "right:0.6000", position: "bottom-right" });
  assert.deepEqual(readLayout(storage, "mobile", fallback), { dock: "left:0.2000", position: "top-left" });
});

// The position used to live in one synced setting, so dragging on the phone
// moved the pill on the desktop live (05.11.2026).
test("a device without its own position starts from the shared setting and never writes it back", () => {
  const storage = memoryStorage();
  const shared = { dock: "right:0.7950", position: "bottom-right" };
  assert.deepEqual(readLayout(storage, "mobile", shared), shared);
  writeLayout(storage, "mobile", { dock: "top:0.5000", position: "bottom-right" });
  assert.deepEqual(shared, { dock: "right:0.7950", position: "bottom-right" });
  assert.deepEqual(readLayout(storage, "desktop", shared), shared);
});

test("a broken or foreign stored value falls back instead of throwing", () => {
  const fallback = { dock: "", position: "bottom-right" };
  for (const raw of ["{not json", "null", "[]", '{"dock":42}', '{"dock":"x","position":7}']) {
    const storage = memoryStorage({ [layoutKey("desktop")]: raw });
    assert.deepEqual(readLayout(storage, "desktop", fallback), fallback, raw);
  }
});

test("storage that throws (private mode, quota) neither breaks reading nor writing", () => {
  const throwing: LayoutStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  const fallback = { dock: "", position: "top-right" };
  assert.deepEqual(readLayout(throwing, "mobile", fallback), fallback);
  assert.equal(writeLayout(throwing, "mobile", fallback), false);
  assert.deepEqual(readLayout(null, "mobile", fallback), fallback);
});

test("placement defaults: floating pill on desktop, thread header on mobile", () => {
  assert.equal(placementFor("desktop", {}), "floating");
  assert.equal(placementFor("mobile", {}), "header");
});

test("placement follows the setting of the device's form factor only", () => {
  const values = { overlayPlacementDesktop: "header", overlayPlacementMobile: "off" };
  assert.equal(placementFor("desktop", values), "header");
  assert.equal(placementFor("mobile", values), "off");
  assert.equal(placementFor("desktop", { overlayPlacementDesktop: "sideways" }), "floating");
});

test("the master switch still turns every placement off", () => {
  assert.equal(placementFor("desktop", { overlayEnabled: false }), "off");
  assert.equal(placementFor("mobile", { overlayEnabled: false, overlayPlacementMobile: "header" }), "off");
});
