/*
 * Notch dimensions per state (CSS px = DIPs, scaled with Windows DPI).
 * Derived from NotchDrop (MIT) and the MacBook notch proportions.
 *
 *   w    width of the black body (without ears)
 *   h    height
 *   r    radius of the bottom corners
 *   ear  radius of the outward-curved "ears" at the top edge
 */
export interface NotchGeometry {
  w: number;
  h: number;
  r: number;
  ear: number;
}

/** Header height when open = height of the closed notch. */
export const HEADER_HEIGHT = 32;

/** Tool bar at the bottom of the open notch (like OmniNotch). */
export const DOCK_HEIGHT = 46;

/** Padding when open. Inner radii = r − PADDING (concentric). */
export const PADDING = 16;

export const geometry = {
  /** Focus mode "line": a thin strip at the screen edge, just enough to find it again. */
  line: { w: 150, h: 5, r: 2.5, ear: 3 },
  /** Hover on the line: it stays a line, just a touch bigger, then opens straight away. */
  linePeek: { w: 166, h: 7, r: 3.5, ear: 3.5 },
} satisfies Record<string, NotchGeometry>;

/** Open state: size comes from the active tab, radii are fixed. */
export function openGeometry(w: number, h: number): NotchGeometry {
  return { w, h, r: 30, ear: 14 };
}

/** Idle size bounds for the settings sliders (defaults = MacBook proportions). */
export const IDLE_W = { min: 80, max: 480, step: 2, def: 188 };
export const IDLE_H = { min: 12, max: 72, step: 1, def: 30 };

/** Idle notch + hover nudge from the user's size setting (Idle Appearance). */
export function idleGeometry(w: number, h: number): { closed: NotchGeometry; peek: NotchGeometry } {
  // Never let a missing value become NaN: the springs would never settle.
  const cw = clamp(Math.round(w), IDLE_W.min, IDLE_W.max, IDLE_W.def);
  const ch = clamp(Math.round(h), IDLE_H.min, IDLE_H.max, IDLE_H.def);
  return {
    closed: { w: cw, h: ch, r: 10, ear: 6 },
    peek: { w: cw + 16, h: ch + 4, r: 12, ear: 7 },
  };
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Slot space the activity boxes add around the idle width (cover, stats). */
const LIVE_DW = 96;
const GAMING_DW = 248;
/** Activity boxes never exceed this (the window is 760 wide). */
const ACTIVITY_MAX_W = 700;

/** Music box: idle size + fixed slots for cover and equalizer. */
export function liveGeometry(w: number, h: number): NotchGeometry {
  return activityGeometry(w, h, LIVE_DW);
}

/** Gaming box: idle size + fixed slots for the stat clusters. */
export function gamingGeometry(w: number, h: number): NotchGeometry {
  return activityGeometry(w, h, GAMING_DW);
}

function activityGeometry(w: number, h: number, dw: number): NotchGeometry {
  const cw = clamp(Math.round(w), IDLE_W.min, IDLE_W.max, IDLE_W.def);
  const ch = clamp(Math.round(h), IDLE_H.min, IDLE_H.max, IDLE_H.def);
  return {
    w: Math.min(ACTIVITY_MAX_W, cw + dw),
    // Slot content (cover, stats) needs at least the classic 30 px height.
    h: Math.max(30, ch),
    r: 10,
    ear: 6,
  };
}
