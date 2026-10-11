import { useEffect, useRef } from "react";
import { audioLevelsAvailable, subscribeLevels, type Levels } from "../platform/audio";
import type { AppearanceEffect } from "../settings/store";

/*
 * Background effects for the open panel: album colours that move with the
 * music (or breathe gently when silent). Canvas 2D, values straight to pixels
 * — no React state per frame. Mounted only while the panel is open and an
 * effect is picked; everything (rAF, level subscription) is cleaned up on
 * unmount. Synthwave is static JSX: zero per-frame cost.
 */

/** Fixed backing size (the window max): CSS stretches it, so no resize logic. */
const W = 740;
const H = 540;
/** Same frame cap as the equalizer: levels arrive ~40×/s, more frames add nothing. */
const MIN_FRAME_MS = 13;
const ATTACK = 0.045;
const RELEASE = 0.14;
const BARS = 28;

type RGB = [number, number, number];

/** Soft fake motion per index (layered sines), like the equalizer's. */
function synthetic(i: number, t: number): number {
  const a = Math.sin(t * (5.1 + i * 1.3) + i * 1.7);
  const b = Math.sin(t * (2.3 + i * 0.7) + i * 0.9);
  return 0.5 + 0.32 * a + 0.18 * b;
}

function parseRgb(css: string): RGB {
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!m) return [255, 69, 58];
  return [Math.min(255, +m[1]), Math.min(255, +m[2]), Math.min(255, +m[3])];
}

function css(c: RGB, a = 1): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

function mix(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function shiftHue([r, g, b]: RGB, deg: number): RGB {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [r * 255, g * 255, b * 255];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  h = (((h + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [pr, pg, pb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(pr + m) * 255, (pg + m) * 255, (pb + m) * 255];
}

export function BackgroundEffects({ effect, playing, radius }: { effect: AppearanceEffect; playing: boolean; radius: number }) {
  if (effect === "none") return null;
  if (effect === "synthwave") return <SynthwaveScene radius={radius} />;
  if (effect === "nightsky") return <NightSky radius={radius} />;
  return <LiveCanvas effect={effect} playing={playing} radius={radius} />;
}

function LiveCanvas({ effect, playing, radius }: { effect: "visualizer" | "ambient" | "waves" | "aurora" | "holographic" | "topographic"; playing: boolean; radius: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // Reduced motion: slow the clock instead of freezing — the effect was
    // explicitly picked, so it stays alive but calm. Audio still responds.
    const TS = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.3 : 1;

    // The base colour is the --accent variable: album colour while music plays,
    // the Accent setting when silent (Cycle included — no extra plumbing).
    const readBase = (): RGB => parseRgb(getComputedStyle(canvas).getPropertyValue("--accent") || "#ff453a");
    const lerpTo = (cur: RGB, tgt: RGB, k: number): RGB => [cur[0] + (tgt[0] - cur[0]) * k, cur[1] + (tgt[1] - cur[1]) * k, cur[2] + (tgt[2] - cur[2]) * k];

    const draw = (t: number, loud: number, ink: RGB, bands: number[] | null) => {
      ctx.clearRect(0, 0, W, H);
      if (effect === "visualizer") {
        const grad = ctx.createLinearGradient(0, H, 0, H * 0.25);
        grad.addColorStop(0, css(ink, 0.9));
        grad.addColorStop(1, css(ink, 0.05));
        ctx.fillStyle = grad;
        const bw = W / BARS;
        for (let i = 0; i < BARS; i++) {
          const h = Math.max(3, bands![i] * H * 0.68);
          ctx.fillRect(i * bw + 2, H - h, bw - 4, h);
        }
      } else if (effect === "ambient") {
        ctx.globalCompositeOperation = "lighter";
        const cols = [ink, shiftHue(ink, 45), shiftHue(ink, -40)];
        for (let k = 0; k < 3; k++) {
          const cx = W * (0.5 + 0.3 * Math.sin(t * (0.35 + k * 0.13) + k * 2.1));
          const cy = H * (0.44 + 0.22 * Math.cos(t * (0.28 + k * 0.11) + k * 1.3));
          const r = 150 * (0.85 + 0.5 * loud) + k * 30;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, css(cols[k], 0.5));
          g.addColorStop(1, css(cols[k], 0));
          ctx.fillStyle = g;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
        ctx.globalCompositeOperation = "source-over";
      } else if (effect === "waves") {
        const cols = [shiftHue(ink, -30), ink, mix(ink, [255, 255, 255], 0.35)];
        const baseY = H * 0.62;
        cols.forEach((c, k) => {
          const amp = (26 + k * 14) * (0.55 + 0.9 * loud);
          ctx.beginPath();
          ctx.moveTo(0, H);
          for (let x = 0; x <= W; x += 12) {
            ctx.lineTo(x, baseY - k * 26 + Math.sin((x / W) * Math.PI * (2 + k) + t * (0.9 + k * 0.35) + k * 2.1) * amp);
          }
          ctx.lineTo(W, H);
          ctx.closePath();
          ctx.fillStyle = css(c, 0.3 - k * 0.07);
          ctx.fill();
        });
      } else if (effect === "aurora") {
        // Aurora: a soft northern-lights wash under faint swaying curtains.
        const wash = ctx.createLinearGradient(0, 0, 0, H);
        wash.addColorStop(0, css(mix(ink, [180, 255, 220], 0.25), 0.5 + 0.3 * loud));
        wash.addColorStop(0.45, css(ink, 0.22 + 0.25 * loud));
        wash.addColorStop(1, css(ink, 0));
        ctx.fillStyle = wash;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "lighter";
        const cols = [mix(ink, [255, 255, 255], 0.3), shiftHue(ink, 50)];
        for (let k = 0; k < 2; k++) {
          const baseX = W * (0.35 + k * 0.3);
          const sway = 26 * (0.5 + loud);
          const grad = ctx.createLinearGradient(0, 0, 0, H * 0.7);
          grad.addColorStop(0, css(cols[k], 0.35 + 0.3 * loud));
          grad.addColorStop(1, css(cols[k], 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(baseX - 46, 0);
          for (let y = 0; y <= H * 0.7; y += 16) {
            ctx.lineTo(baseX - 46 + Math.sin((y / H) * Math.PI * 2.4 + t * (0.6 + k * 0.3) + k * 2.6) * sway, y);
          }
          for (let y = H * 0.7; y >= 0; y -= 16) {
            ctx.lineTo(baseX + 46 + Math.sin((y / H) * Math.PI * 2.4 + t * (0.6 + k * 0.3) + k * 2.6 + 1) * sway, y);
          }
          ctx.closePath();
          ctx.fill();
        }
        // Sparse stars in the dark half.
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        for (let i = 0; i < 24; i++) {
          const sx = (i * 197.3) % W;
          const sy = H * 0.55 + ((i * 331.7) % (H * 0.45));
          ctx.globalAlpha = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.5 + i * 1.7));
          ctx.fillRect(sx, sy, 1.6, 1.6);
        }
        ctx.globalAlpha = 1;
      } else if (effect === "holographic") {
        // Iridescent foil: dark base, slow rainbow sheen bands + a sweeping shine.
        ctx.fillStyle = "#0b0a16";
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "lighter";
        const drift = (t * 24) % (W * 1.6);
        const sheen: Array<[number, RGB]> = [
          [0.15, shiftHue(ink, 120)],
          [0.38, shiftHue(ink, 60)],
          [0.62, ink],
          [0.85, shiftHue(ink, -70)],
        ];
        for (const [p, c] of sheen) {
          const x = ((p * W * 1.6 + drift) % (W * 1.6)) - W * 0.3;
          const g = ctx.createLinearGradient(x, 0, x + 190, H);
          g.addColorStop(0, css(c, 0));
          g.addColorStop(0.5, css(c, 0.34));
          g.addColorStop(1, css(c, 0));
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, W, H);
        }
        const sx = ((t * 60) % (W + 500)) - 250;
        const shine = ctx.createLinearGradient(sx - 60, 0, sx + 60, 0);
        shine.addColorStop(0, "rgba(255, 255, 255, 0)");
        shine.addColorStop(0.5, "rgba(255, 255, 255, 0.10)");
        shine.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.fillStyle = shine;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "source-over";
      } else if (effect === "topographic") {
        // Slow contour lines: wobbling rings drifting over near-black.
        ctx.fillStyle = "#070604";
        ctx.fillRect(0, 0, W, H);
        ctx.lineWidth = 1.4;
        for (let k = 0; k < 12; k++) {
          const cx = W * 0.5 + 46 * Math.sin(t * 0.2 + k * 0.9);
          const cy = H * 0.55 + 34 * Math.cos(t * 0.16 + k * 1.7);
          const R = 34 + k * 27;
          ctx.strokeStyle = css(mix(ink, [255, 200, 120], 0.25), 0.55 - k * 0.035);
          ctx.beginPath();
          for (let s = 0; s <= 64; s++) {
            const a = (s / 64) * Math.PI * 2 + t * 0.05 * (k % 2 === 0 ? 1 : -1);
            const wob = 11 * Math.sin(3 * a + t * 0.5 + k * 1.3) + 6 * Math.sin(5 * a - t * 0.34 + k);
            const x = cx + Math.cos(a) * (R + wob);
            const y = cy + Math.sin(a) * (R + wob) * 0.72;
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
    };

    let frame = 0;
    let last = performance.now();
    let n = 0;
    let live: { values: Levels; at: number } | null = null;
    const off = playing && audioLevelsAvailable ? subscribeLevels((values) => (live = { values, at: performance.now() })) : null;
    const shown = readBase();
    let target = shown;
    const vals = new Array<number>(BARS).fill(0.2);

    const tick = (now: number) => {
      if (now - last < MIN_FRAME_MS) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now / 1000) * TS;
      if (n++ % 30 === 0) target = readBase();
      const k = 1 - Math.exp(-dt / 0.18);
      const ink = lerpTo(shown, target, k);
      shown[0] = ink[0];
      shown[1] = ink[1];
      shown[2] = ink[2];

      const lv = live && now - live.at < 400 ? live.values : null;
      const loud = lv ? Math.max(...lv) : 0.24 + 0.12 * Math.sin(t * 1.3);
      let bands: number[] | null = null;
      if (effect === "visualizer") {
        bands = vals;
        for (let i = 0; i < BARS; i++) {
          const pos = (i / (BARS - 1)) * 3;
          const a = Math.floor(pos);
          const b = Math.min(3, a + 1);
          const v = lv ? lv[a] + (lv[b] - lv[a]) * (pos - a) : 0;
          const goal = lv ? 0.12 + 0.88 * v : 0.14 + 0.5 * synthetic(i, t);
          const tau = goal > vals[i] ? ATTACK : RELEASE;
          vals[i] += (goal - vals[i]) * (1 - Math.exp(-dt / tau));
        }
      }
      draw(t, loud, shown, bands);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      off?.();
    };
  }, [effect, playing]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      width={W}
      height={H}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
      style={{ borderRadius: radius }}
    />
  );
}

/** Retro sun and neon grid: pure CSS, no animation loop. */
function SynthwaveScene({ radius }: { radius: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden" style={{ borderRadius: radius }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, #150833 0%, #3d1160 42%, #a12c6d 68%, #1a0b2e 69%, #0d0518 100%)" }} />
      {/* Sun with slits, sinking into the horizon. */}
      <div className="absolute top-[16%] left-1/2 h-[38%] w-[46%] -translate-x-1/2">
        <div className="absolute inset-0 rounded-full" style={{ background: "linear-gradient(180deg, #ffd60a 0%, #ff9f0a 55%, #ff453a 100%)" }} />
        {[0, 1, 2].map((i) => (
          <div key={i} className="absolute right-0 left-0" style={{ top: `${58 + i * 13}%`, height: 2 + i * 1.5, background: "#3d1160" }} />
        ))}
      </div>
      {/* Neon grid floor. */}
      <div
        className="absolute right-0 bottom-0 left-0 h-[32%]"
        style={{
          background:
            "repeating-linear-gradient(90deg, rgb(224 123 255 / 0.5) 0 1px, transparent 1px 34px), repeating-linear-gradient(0deg, rgb(224 123 255 / 0.5) 0 1px, transparent 1px 14px)",
          maskImage: "linear-gradient(180deg, transparent, #000 45%)",
        }}
      />
      {/* Stars. */}
      {[
        [8, 12],
        [22, 6],
        [38, 16],
        [64, 8],
        [78, 18],
        [90, 10],
        [50, 5],
      ].map(([x, y], i) => (
        <div key={i} className="absolute size-[2px] rounded-full bg-white/80" style={{ left: `${x}%`, top: `${y}%` }} />
      ))}
    </div>
  );
}

/** Night sky: gradient dusk, a glowing moon and slowly twinkling stars. No audio needed. */
function NightSky({ radius }: { radius: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // Reduced motion: slow the clock instead of freezing.
    const TS = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.3 : 1;

    const stars = Array.from({ length: 90 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H * 0.75,
      r: 0.6 + Math.random() * 1.4,
      p: Math.random() * Math.PI * 2,
      s: 0.6 + Math.random() * 2.2,
    }));
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#060a1c");
    sky.addColorStop(0.6, "#0b1030");
    sky.addColorStop(1, "#02030a");
    // Faint nebulae, baked once.
    const nebulae = [
      { x: W * 0.22, y: H * 0.3, r: 150, c: "124, 93, 250" },
      { x: W * 0.62, y: H * 0.55, r: 120, c: "70, 120, 250" },
    ];
    const meteors: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
    let nextMeteor = 2;

    const draw = (t: number) => {
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      for (const n of nebulae) {
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
        g.addColorStop(0, `rgba(${n.c}, 0.16)`);
        g.addColorStop(1, `rgba(${n.c}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
      }
      // Moon + halo.
      const mx = W * 0.78;
      const my = H * 0.22;
      const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 90);
      halo.addColorStop(0, "rgba(244, 241, 222, 0.35)");
      halo.addColorStop(1, "rgba(244, 241, 222, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(mx - 90, my - 90, 180, 180);
      ctx.fillStyle = "#f4f1de";
      ctx.beginPath();
      ctx.arc(mx, my, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(190, 186, 160, 0.5)";
      ctx.beginPath();
      ctx.arc(mx - 8, my - 5, 6, 0, Math.PI * 2);
      ctx.arc(mx + 7, my + 9, 4, 0, Math.PI * 2);
      ctx.fill();
      for (const st of stars) {
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t * st.s + st.p))).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // A meteor streak every few seconds, with a fading trail.
      if (t > nextMeteor) {
        nextMeteor = t + 3 + Math.random() * 5;
        meteors.push({
          x: W * (0.3 + Math.random() * 0.6),
          y: H * Math.random() * 0.3,
          vx: -(260 + Math.random() * 200),
          vy: 150 + Math.random() * 120,
          life: 1,
        });
      }
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.life -= 0.03;
        if (m.life <= 0) {
          meteors.splice(i, 1);
          continue;
        }
        m.x += m.vx / 60;
        m.y += m.vy / 60;
        const tx = m.x - (m.vx / 60) * 9;
        const ty = m.y - (m.vy / 60) * 9;
        const trail = ctx.createLinearGradient(m.x, m.y, tx, ty);
        trail.addColorStop(0, `rgba(255, 255, 255, ${(0.9 * m.life).toFixed(3)})`);
        trail.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.strokeStyle = trail;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
    };

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (now - last < MIN_FRAME_MS) {
        frame = requestAnimationFrame(tick);
        return;
      }
      last = now;
      draw((now / 1000) * TS);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      width={W}
      height={H}
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
      style={{ borderRadius: radius }}
    />
  );
}
