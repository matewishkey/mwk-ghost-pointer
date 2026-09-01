// The aim-rect picker: the host drags a box around the window showing the guest's screen.
//
// This is the piece the whole product balances on. That rectangle is the only thing that turns
// "my cursor is at 1840,620 on my monitor" into "53% across, 31% down your screen".

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// The display this sheet covers, and the guest's aspect ratio. Used to be query params baked
// into this window's URL, read once at page load — but that needed a fresh window (a live
// `.build()`) every time the picker opened, which is the exact shape that hung real Windows
// hardware for the overlay window. This window is now built once and reused, so the numbers
// arrive as an event instead — see `open_aim` in `lib.rs`.
let originX = 0;
let originY = 0;
/** Guest display aspect ratio (w/h). 0 means the guest has not announced one yet. */
let ratio = 0;

const FRAUNCES = '600 15px Fraunces, ui-serif, Georgia, serif';
const MONO = '12px "JetBrains Mono", ui-monospace, Menlo, monospace';
const BODY = '500 14px Manrope, -apple-system, system-ui, sans-serif';

let W = 0, H = 0;
function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

type Rect = { x: number; y: number; w: number; h: number };
let start: { x: number; y: number } | null = null;
let rect: Rect | null = null;

/**
 * Force the dragged box to the guest's aspect ratio.
 *
 * The spec's rule is letterbox-fit, never stretch. Snapping here rather than letterboxing at
 * render time means a mismatched rect is impossible by construction — the host literally
 * cannot draw a box of the wrong shape, so there is no second code path to get wrong.
 */
function shape(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (ratio > 0) {
    // Grow to the ratio, then shrink to whatever actually fits between the anchor and the edge
    // of the screen. Without the second step a tall drag snaps to a box taller than the display,
    // and the part hanging off the bottom is guest screen the host's cursor can never reach.
    const roomX = b.x < a.x ? a.x : W - a.x;
    const roomY = b.y < a.y ? a.y : H - a.y;
    w = Math.min(Math.max(w, h * ratio), roomX, roomY * ratio);
    h = w / ratio;
  }
  return {
    x: b.x < a.x ? a.x - w : a.x,
    y: b.y < a.y ? a.y - h : a.y,
    w,
    h,
  };
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = "rgba(12, 11, 15, 0.62)";
  ctx.fillRect(0, 0, W, H);

  if (rect && rect.w > 4 && rect.h > 4) {
    // Punch the selection out of the dim so the host can see the video they are framing.
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);

    ctx.strokeStyle = "rgba(226, 52, 43, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);

    // Corner ticks — they read as "frame" in a way a plain rectangle does not.
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    const t = Math.min(22, rect.w / 4, rect.h / 4);
    for (const [cx, cy, sx, sy] of [
      [rect.x, rect.y, 1, 1],
      [rect.x + rect.w, rect.y, -1, 1],
      [rect.x, rect.y + rect.h, 1, -1],
      [rect.x + rect.w, rect.y + rect.h, -1, -1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * t, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * t);
      ctx.stroke();
    }

    const label = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    ctx.font = MONO;
    const lw = ctx.measureText(label).width + 18;
    const ly = rect.y > 34 ? rect.y - 30 : rect.y + rect.h + 8;
    ctx.fillStyle = "rgba(201, 37, 29, 0.95)";
    ctx.fillRect(rect.x, ly, lw, 22);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, rect.x + 9, ly + 12);
  }

  // Instructions, parked in the middle until the host starts dragging.
  if (!rect) {
    const cx = W / 2;
    const cy = H / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.font = FRAUNCES;
    ctx.fillText("Drag a box around the window showing their screen", cx, cy - 8);
    ctx.font = BODY;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(
      ratio > 0
        ? "The box snaps to their screen's shape. Esc to cancel."
        : "Their screen size is not known yet — drag any shape. Esc to cancel.",
      cx,
      cy + 16,
    );
    ctx.textAlign = "left";
  }
}

addEventListener("resize", resize);

listen<{ ox: number; oy: number; ar: number }>("aim-params", (ev) => {
  originX = ev.payload.ox;
  originY = ev.payload.oy;
  ratio = ev.payload.ar;
  // A window that is shown again for a new room must not open with the last room's frame
  // still drawn — that reads as "already set" when it is stale.
  start = null;
  rect = null;
  draw();
});

addEventListener("pointerdown", (e) => {
  start = { x: e.clientX, y: e.clientY };
  rect = null;
  draw();
});

addEventListener("pointermove", (e) => {
  if (!start) return;
  rect = shape(start, { x: e.clientX, y: e.clientY });
  draw();
});

addEventListener("pointerup", () => {
  start = null;
  if (!rect || rect.w < 20 || rect.h < 20) {
    rect = null;
    draw();
    return;
  }
  // Local window coords -> the global desktop space the sender's cursor is reported in.
  void invoke("commit_aim", {
    x: originX + rect.x,
    y: originY + rect.y,
    w: rect.w,
    h: rect.h,
  });
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape") void invoke("cancel_aim");
});

resize();
