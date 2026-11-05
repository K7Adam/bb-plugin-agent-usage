// Where the usage display sits, decided per form factor, and where the
// floating pill was dragged to, kept per device.
//
// The dragged position used to be one plugin setting. bb syncs settings to
// every client live, so dragging the pill on the phone moved it on the
// desktop at the same moment. The position now lives in this device's
// localStorage, one entry per form factor. The shared settings only supply
// the starting point for a device that has not been arranged yet, and they
// are never written from a drag again.
//
// Pure module: no React, no DOM globals, so it runs under node --test.

export type FormFactor = "desktop" | "mobile";
export type Placement = "floating" | "header" | "off";

export const PLACEMENTS: readonly Placement[] = ["floating", "header", "off"];

/** Setting key holding the placement of each form factor. */
export const PLACEMENT_SETTING: Record<FormFactor, string> = {
  desktop: "overlayPlacementDesktop",
  mobile: "overlayPlacementMobile",
};

// On a phone the thread header is always visible and covers nothing; a
// floating pill sits over the conversation and the keyboard.
const DEFAULT_PLACEMENT: Record<FormFactor, Placement> = {
  desktop: "floating",
  mobile: "header",
};

export function placementFor(form: FormFactor, values: Readonly<Record<string, unknown>> | null | undefined): Placement {
  if (values?.overlayEnabled === false) return "off";
  const value = values?.[PLACEMENT_SETTING[form]];
  return typeof value === "string" && (PLACEMENTS as readonly string[]).includes(value)
    ? (value as Placement)
    : DEFAULT_PLACEMENT[form];
}

/** `dock` is the `edge:fraction` string of a dragged pill, "" when it sits on a preset. */
export interface DeviceLayout {
  dock: string;
  position: string;
}

/** The part of the Web Storage API this module uses. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function layoutKey(form: FormFactor): string {
  return `agent-usage:overlay-layout:${form}`;
}

function isLayout(value: unknown): value is DeviceLayout {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as DeviceLayout).dock === "string" &&
    typeof (value as DeviceLayout).position === "string"
  );
}

export function readLayout(storage: LayoutStorage | null, form: FormFactor, fallback: DeviceLayout): DeviceLayout {
  if (storage === null) return fallback;
  try {
    const raw = storage.getItem(layoutKey(form));
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isLayout(parsed) ? { dock: parsed.dock, position: parsed.position } : fallback;
  } catch {
    // private mode, a denied storage or a value another version wrote
    return fallback;
  }
}

/** Returns false when the device refused to store it; the layout then lasts until reload. */
export function writeLayout(storage: LayoutStorage | null, form: FormFactor, layout: DeviceLayout): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(layoutKey(form), JSON.stringify({ dock: layout.dock, position: layout.position }));
    return true;
  } catch {
    return false;
  }
}
