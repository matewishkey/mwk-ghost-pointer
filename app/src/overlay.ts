// The ghost itself. This window is transparent and click-through and does exactly one thing:
// draw a dot where the other person is pointing.
//
// Keep it cheap. It repaints every frame on someone else's machine while they are on a call,
// and the whole pitch is that it costs them nothing.

import { listen } from "@tauri-apps/api/event";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

/** Brand red. Same hue as the mark — see matewishkey.com/media. */
const RED = "226, 52, 43";
const TRAIL_MS = 600;
/** How long the ghost takes to fade after the sender disarms. */
const FADE_MS = 320;
/**
 * Smoothing time constant. Samples arrive at up to 60 Hz but the network delivers them in
 * clumps, so the ghost chases a target rather than teleporting to it. 45 ms is the point where
 * the motion stops looking stepped without feeling laggy — the spec's note that 15 Hz can pass
 * for 60 Hz is this plus the trail.
 */
const TAU_MS = 45;

let W = 0;
let H = 0;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener("resize", resize);

/** Where the sender says the ghost is, in this window's CSS pixels. */
let target: { x: number; y: number } | null = null;
/** Where it is actually drawn — chases `target`. */
let render: { x: number; y: number } | null = null;
let visible = false;
/** 0..1, ramps to 0 over FADE_MS once `visible` goes false. */
let alpha = 0;

const trail: { x: number; y: number; t: number }[] = [];

/** How long a click pulse lives. Long enough to notice across a laggy video, short enough not
 *  to pile up when someone clicks repeatedly. */
const PULSE_MS = 620;
const pulses: { x: number; y: number; b: number; t: number }[] = [];

listen<{ x: number; y: number; b: number }>("pulse", (ev) => {
  const { x, y, b } = ev.payload;
  pulses.push({
    x: Math.max(0, Math.min(1, x)) * W,
    y: Math.max(0, Math.min(1, y)) * H,
    b,
    t: performance.now(),
  });
  // A stuck sender must not be able to grow this without bound.
  if (pulses.length > 40) pulses.splice(0, pulses.length - 40);
});

/** Expanding ring where a click landed. Left is one ring, right is two — they have to be
 *  distinguishable across a compressed video stream, so the difference is structural rather
 *  than a change of shade. */
function drawPulse(now: number, p: { x: number; y: number; b: number; t: number }): void {
  const k = (now - p.t) / PULSE_MS; // 0 -> 1
  if (k >= 1) return;
  const ease = 1 - Math.pow(1 - k, 3); // fast out, slow settle
  const fade = (1 - k) * (1 - k);
  const rings = p.b === 2 ? [1, 0.58] : [1];
  for (const scale of rings) {
    ctx.strokeStyle = `rgba(${RED},${(0.85 * fade).toFixed(3)})`;
    ctx.lineWidth = 3 * (1 - k * 0.55);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 + ease * 46 * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  // A white inner ring keeps it readable on a dark desktop, the same trick the ghost uses.
  ctx.strokeStyle = `rgba(255,255,255,${(0.5 * fade).toFixed(3)})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 6 + ease * 46 + 2.5, 0, Math.PI * 2);
  ctx.stroke();
}

listen<{ x: number; y: number; a: number }>("ghost", (ev) => {
  const { x, y, a } = ev.payload;
  // Normalised 0..1 in, this window's pixels out. The window covers exactly the display the
  // guest picked, so there is no offset to apply — that is why the backend sizes it that way.
  target = { x: Math.max(0, Math.min(1, x)) * W, y: Math.max(0, Math.min(1, y)) * H };
  visible = a === 1;
  // A ghost that reappears somewhere else should not smear across the screen to get there.
  if (!render || (!visible && alpha === 0)) render = { ...target };
});

let prev = performance.now();

function frame(now: number): void {
  const dt = Math.min(now - prev, 100); // a backgrounded tab can hand us a huge dt
  prev = now;

  alpha += ((visible ? 1 : 0) - alpha) * (1 - Math.exp(-dt / (visible ? 90 : FADE_MS)));
  if (!visible && alpha < 0.004) alpha = 0;

  if (target && render) {
    const k = 1 - Math.exp(-dt / TAU_MS);
    render.x += (target.x - render.x) * k;
    render.y += (target.y - render.y) * k;
    if (alpha > 0.01) trail.push({ x: render.x, y: render.y, t: now });
  }
  while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift();

  ctx.clearRect(0, 0, W, H);

  // Pulses outlive the ghost on purpose: disarming should not wipe a click you just made.
  while (pulses.length && now - pulses[0].t > PULSE_MS) pulses.shift();
  for (const p of pulses) drawPulse(now, p);

  if (alpha > 0.004 && render) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1];
      const b = trail[i];
      const k = 1 - (now - b.t) / TRAIL_MS;
      ctx.strokeStyle = `rgba(${RED},${(k * k * 0.5 * alpha).toFixed(3)})`;
      ctx.lineWidth = 1.5 + k * 6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const { x, y } = render;
    // Glow first, so the dot and ring sit on top of it. This is what keeps the ghost readable
    // on a white document and on a dark editor without changing colour.
    const g = ctx.createRadialGradient(x, y, 0, x, y, 30);
    g.addColorStop(0, `rgba(${RED},${(0.42 * alpha).toFixed(3)})`);
    g.addColorStop(1, `rgba(${RED},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 30, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(255,255,255,${(0.85 * alpha).toFixed(3)})`;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = `rgba(${RED},${(0.95 * alpha).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = `rgba(${RED},${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 3.6, 0, Math.PI * 2);
    ctx.fill();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
