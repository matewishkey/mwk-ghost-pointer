// The control window. It owns the socket, the aim rect and the arm state; the overlay and the
// aim picker are dumb views that this file feeds.

import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Relay, randomCode, normaliseCode, isValidCode } from "./protocol";
import type { ClickButton, Geo, Peer, Role } from "./protocol";

interface Display {
  id: string; label: string;
  x: number; y: number; w: number; h: number;
  scale: number; is_primary: boolean;
}
interface Rect { x: number; y: number; w: number; h: number }
interface Cursor {
  x: number; y: number;
  alt: boolean; ctrl: boolean; shift: boolean; meta: boolean;
  /** Running totals, not per-tick counts. Only the delta between two ticks means anything. */
  clicks: { left: number; right: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  role: $("role"), code: $<HTMLInputElement>("code"), gen: $<HTMLButtonElement>("gen"),
  roomStep: $("room-step"), displayStep: $("display-step"), display: $<HTMLSelectElement>("display"),
  testOverlay: $<HTMLButtonElement>("test-overlay"), testOverlayHint: $("test-overlay-hint"),
  connectStep: $("connect-step"), connect: $<HTMLButtonElement>("connect"),
  dot: $("dot"), statusText: $("status-text"), rtt: $("rtt"),
  aimStep: $("aim-step"), aim: $<HTMLButtonElement>("aim"), aimHint: $("aim-hint"), peerHint: $("peer-hint"),
  armStep: $("arm-step"), mode: $("mode"), hotkey: $<HTMLInputElement>("hotkey"),
  armed: $("armed"), armedText: $("armed-text"), guestLive: $("guest-live"),
  diag: $<HTMLButtonElement>("diag"),
};

const DEFAULT_HOTKEY = "Control+Alt+Shift+G";
const store = {
  get: (k: string, fallback = "") => localStorage.getItem(`gp.${k}`) ?? fallback,
  set: (k: string, v: string) => localStorage.setItem(`gp.${k}`, v),
};

let role: Role | null = null;
let displays: Display[] = [];
let aim: Rect | null = null;
/** The display the host's own echo overlay covers — the one the aim rect sits on. */
let hostScreen: Display | null = null;
/** The guest's display, as announced over the wire. Drives the aim picker's aspect ratio. */
let guestGeo: Geo | null = null;
let armMode: "tap" | "hold" = "tap";
let armed = false;
/** True on the frame after disarming, so exactly one `a:0` goes out to start the fade. */
let wasArmed = false;
/**
 * Last click totals seen. `null` until the first sample, because these counters are system-wide
 * and monotonic — treating the first absolute reading as a delta would fire a pulse for every
 * click made since the machine booted.
 */
let prevClicks: { left: number; right: number } | null = null;
let connected = false;
/** Which OS this build is running on, from `build_info`. Empty until `boot()` has answered. */
let os = "";

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Which display contains a point in the global desktop space. Displays never overlap, so the
 *  first hit is the only hit. */
const displayAt = (x: number, y: number): Display | null =>
  displays.find((d) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) ?? null;

const primaryDisplay = (): Display | null =>
  displays.find((d) => d.is_primary) ?? displays[0] ?? null;

// ---------------------------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------------------------

const relay = new Relay({
  onOpen: (_you, peers) => {
    connected = true;
    setStatus("on", role === "point" ? "Connected — waiting for them" : "Connected");
    onPeers(peers);
    void (role === "point" ? startHosting() : startViewing());
  },
  onPeers,
  onPointer: (m) => {
    if (role === "view") void invoke("draw", { payload: { x: m.x, y: m.y, a: m.a } });
  },
  onClick: (m) => {
    // The guest's overlay covers exactly the display it picked, so normalised coordinates land
    // straight on it with nothing to offset.
    if (role === "view") void invoke("pulse", { payload: { x: m.x, y: m.y, b: m.b } });
  },
  onRtt: (ms) => { el.rtt.textContent = `${ms} ms`; },
  onClose: (why) => {
    connected = false;
    setStatus(why === "disconnected" ? "" : "bad", why[0].toUpperCase() + why.slice(1));
    void teardown();
  },
});

function onPeers(peers: Peer[]): void {
  const others = peers.filter((p) => p.role !== role);
  if (role === "point") {
    const viewer = peers.find((p) => p.role === "view" && p.geo);
    guestGeo = viewer?.geo ?? null;
    el.peerHint.textContent = guestGeo
      ? `Their screen: ${Math.round(guestGeo.w)} × ${Math.round(guestGeo.h)} — ${guestGeo.label}`
      : others.length
        ? "They're here, but haven't picked a screen yet."
        : "Waiting for the other side to join…";
    el.aim.disabled = !connected;
    if (connected) {
      setStatus("on", others.length ? "Connected — they're here" : "Connected — waiting for them");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------------------------

async function startHosting(): Promise<void> {
  await invoke("start_cursor_stream");
  await applyHotkey(el.hotkey.value || DEFAULT_HOTKEY);
  await openHostOverlay();
}

/**
 * The host draws its own ghost locally rather than waiting for one to come back.
 *
 * There is no round trip that would make waiting acceptable: the guest's screen reaches the
 * host through a video call, one to three seconds behind. A pointer that lagged that far
 * behind the hand moving it would be unusable.
 */
async function openHostOverlay(): Promise<void> {
  if (!aim) return;
  hostScreen = displayAt(aim.x + aim.w / 2, aim.y + aim.h / 2) ?? primaryDisplay();
  if (hostScreen) {
    await invoke("open_overlay", { x: hostScreen.x, y: hostScreen.y, w: hostScreen.w, h: hostScreen.h });
  }
}

/**
 * Aim-rect coordinates to a position on the host's *own* overlay window.
 *
 * Deliberately routed back through the aim rect rather than using the raw cursor, so the host
 * sees the ghost park at the edge exactly as the guest does when the mouse leaves the rect.
 */
function toHostOverlay(nx: number, ny: number): { x: number; y: number } | null {
  if (!aim || !hostScreen) return null;
  return {
    x: (aim.x + nx * aim.w - hostScreen.x) / hostScreen.w,
    y: (aim.y + ny * aim.h - hostScreen.y) / hostScreen.h,
  };
}

/**
 * A click while pointing puts a pulse on their screen.
 *
 * Fired from a real mouse click, which the M2 spike proved costs no permission to read. The
 * click *also* reaches whatever is under the cursor — but while pointing that is a video of
 * someone else's screen, where a click does nothing. Drawing cannot use this: a drag would drag
 * inside the call app too, which is why ink is bound to a held modifier instead.
 */
function firePulse(nx: number, ny: number, b: ClickButton): void {
  relay.sendClick(nx, ny, b);
  const local = toHostOverlay(nx, ny);
  if (local) void invoke("pulse", { payload: { ...local, b } });
}

void listen<Cursor>("cursor", (ev) => {
  if (role !== "point" || !connected) return;
  const c = ev.payload;
  if (armMode === "hold") setArmed(c.alt);
  if (!aim) return;

  const nx = clamp01((c.x - aim.x) / aim.w);
  const ny = clamp01((c.y - aim.y) / aim.h);

  // Skip the whole frame while disarmed — except the first one, which carries a:0 and is what
  // tells the guest to start fading.
  if (armed || wasArmed) {
    relay.sendPointer(nx, ny, armed);
    const local = toHostOverlay(nx, ny);
    if (local) void invoke("draw", { payload: { ...local, a: armed ? 1 : 0 } });
  }
  wasArmed = armed;

  // Deltas, and only while pointing — otherwise every click anywhere on the machine would throw
  // a pulse onto someone else's screen. The totals are tracked even while disarmed, so arming
  // never inherits a backlog of clicks made in between.
  if (prevClicks && armed) {
    // Capped: a double-click should show as two, but a counter that jumps (a wake from sleep,
    // a missed second) must not spray the guest's screen.
    const fire = (delta: number, b: ClickButton) => {
      for (let i = 0; i < Math.min(delta, 3); i++) firePulse(nx, ny, b);
    };
    fire(c.clicks.left - prevClicks.left, 0);
    fire(c.clicks.right - prevClicks.right, 2);
  }
  prevClicks = { ...c.clicks };
});

void listen("hotkey", () => {
  if (role === "point" && armMode === "tap") {
    setArmed(!armed);
    return;
  }
  if (role === "view" && connected) {
    // The guest's escape hatch. A transparent click-through overlay is one bug away from being
    // an opaque one that eats every click, and at that point the mouse cannot reach the app to
    // fix it. A global hotkey still gets through, so there is always a way out without a
    // force-quit. Cheap insurance; keep it even once the overlay is well proven.
    relay.close();
    void teardown();
    setStatus("", "Overlay closed with the hotkey");
  }
});

function setArmed(v: boolean): void {
  if (armed === v) return;
  armed = v;
  el.armed.classList.toggle("on", v);
  el.armedText.textContent = v ? "Pointing — they can see the ghost" : "Not pointing";
}

// ---------------------------------------------------------------------------------------------
// Guest
// ---------------------------------------------------------------------------------------------

async function startViewing(): Promise<void> {
  const d = chosenDisplay();
  if (!d) return;
  // Registered for the guest too — not to arm anything, but as the way out if the overlay
  // misbehaves. See the `hotkey` listener.
  await applyHotkey(el.hotkey.value || DEFAULT_HOTKEY);
  relay.sendGeo({ w: d.w, h: d.h, label: d.label });
  try {
    await invoke("open_overlay", { x: d.x, y: d.y, w: d.w, h: d.h });
    el.guestLive.hidden = false;
  } catch (err) {
    // This is the failure that locked up a real machine on 31 Aug: open_overlay rejected and
    // nobody heard about it. Say so instead of leaving a silent, possibly-unarmed overlay.
    setStatus("bad", `Overlay failed to arm: ${err}`);
  }
}

const chosenDisplay = (): Display | null =>
  displays.find((d) => d.id === el.display.value) ?? primaryDisplay();

// ---------------------------------------------------------------------------------------------
// Overlay click-through test
// ---------------------------------------------------------------------------------------------

/**
 * Arm the overlay with nothing behind it — no room, no relay — and destroy it on a timer.
 *
 * This is the bounded test the Windows lock-up on 31 Aug never got: if the overlay is not
 * actually click-through, the failure costs ten seconds instead of Task Manager, because the
 * timer that ends it runs in this window's own JS and does not depend on a click reaching
 * anything. Try clicking your desktop while it counts down.
 */
let testOverlayTimer: ReturnType<typeof setTimeout> | null = null;

function endOverlayTest(msg: string): void {
  if (testOverlayTimer !== null) {
    clearTimeout(testOverlayTimer);
    testOverlayTimer = null;
  }
  el.testOverlay.disabled = false;
  el.testOverlay.textContent = "Test click-through";
  el.testOverlayHint.textContent = msg;
  void invoke("close_overlay");
}

el.testOverlay.onclick = async () => {
  if (connected) {
    el.testOverlayHint.textContent = "Disconnect first — the overlay is already in use.";
    return;
  }
  const d = chosenDisplay();
  if (!d) return;
  el.testOverlay.disabled = true;
  el.testOverlay.textContent = "Testing…";
  el.testOverlayHint.textContent =
    "Try clicking your desktop now. Closes itself in 10s either way.";
  try {
    await invoke("open_overlay", { x: d.x, y: d.y, w: d.w, h: d.h });
    testOverlayTimer = setTimeout(() => {
      endOverlayTest("Closed automatically. If your desktop took the click, it's click-through.");
    }, 10_000);
  } catch (err) {
    el.testOverlay.disabled = false;
    el.testOverlay.textContent = "Test click-through";
    el.testOverlayHint.textContent = `Overlay failed to arm: ${err}`;
  }
};

// ---------------------------------------------------------------------------------------------
// Aim rect
// ---------------------------------------------------------------------------------------------

const aimKey = () => `aim.${normaliseCode(el.code.value)}`;

function showAim(): void {
  if (aim) {
    // Name the screen it landed on. With two monitors "1200 × 750" alone does not tell you
    // which one you framed, and redrawing on the wrong screen is a confusing five minutes.
    const on = displayAt(aim.x + aim.w / 2, aim.y + aim.h / 2);
    el.aimHint.textContent =
      `Set — ${Math.round(aim.w)} × ${Math.round(aim.h)}` +
      (on ? ` on ${on.label}` : "") +
      ". Drag again any time that window moves.";
  } else {
    el.aimHint.textContent = "Not set yet. Drag a box around the window showing their screen.";
  }
  el.aim.textContent = aim ? "Redraw the aim area" : "Set the aim area";
}

el.aim.onclick = async () => {
  // The picker opens on whichever screen the mouse is on — move to the screen showing their
  // video, then click. `showAim` names the one you framed, so there is no guessing afterwards.
  const p = await invoke<{ x: number; y: number } | null>("cursor_position");
  const d = (p ? displayAt(p.x, p.y) : null) ?? primaryDisplay();
  if (!d) return;
  await invoke("open_aim", {
    x: d.x, y: d.y, w: d.w, h: d.h,
    ratio: guestGeo ? guestGeo.w / guestGeo.h : 0,
  });
};

void listen<Rect>("aim-set", async (ev) => {
  aim = ev.payload;
  store.set(aimKey(), JSON.stringify(aim));
  showAim();
  await openHostOverlay();
});

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

function setStatus(kind: "" | "on" | "bad", text: string): void {
  el.dot.className = `dot ${kind}`;
  el.statusText.textContent = text;
}

async function teardown(): Promise<void> {
  setArmed(false);
  wasArmed = false;
  prevClicks = null;
  // Clearing this here rather than in onClose covers the manual Disconnect too — that path
  // suppresses onClose on purpose, and a latency reading left over from a dead socket reads
  // as if the connection were still up.
  el.rtt.textContent = "";
  await invoke("stop_cursor_stream");
  await invoke("close_overlay");
  el.guestLive.hidden = true;
  el.connect.textContent = "Connect";
  el.connect.classList.remove("on");
}

async function applyHotkey(accel: string): Promise<void> {
  try {
    await invoke("set_hotkey", { accelerator: accel });
    el.hotkey.setCustomValidity("");
    store.set("hotkey", accel);
  } catch {
    // A shortcut the OS will not give us is worth saying out loud — silently not arming is the
    // kind of bug that gets blamed on the network.
    setStatus("bad", `Can't register ${accel} — another app has it`);
  }
}

function setRole(r: Role): void {
  role = r;
  store.set("role", r);
  for (const b of el.role.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.getAttribute("data-role") === r));
  }
  el.roomStep.hidden = false;
  el.connectStep.hidden = false;
  el.displayStep.hidden = r !== "view";
  el.aimStep.hidden = r !== "point";
  el.armStep.hidden = r !== "point";
  validate();
}

function validate(): void {
  el.connect.disabled = !(role && isValidCode(normaliseCode(el.code.value)));
}

el.role.onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button[data-role]");
  if (b && !connected) setRole(b.getAttribute("data-role") as Role);
};

el.mode.onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button[data-mode]");
  if (!b) return;
  armMode = b.getAttribute("data-mode") as "tap" | "hold";
  store.set("mode", armMode);
  for (const x of el.mode.querySelectorAll("button")) {
    x.setAttribute("aria-pressed", String(x.getAttribute("data-mode") === armMode));
  }
  setArmed(false);
};

el.code.oninput = () => {
  el.code.value = normaliseCode(el.code.value);
  validate();
  aim = loadAim();
  showAim();
};
el.gen.onclick = () => { el.code.value = randomCode(); el.code.oninput!(new Event("input")); };

el.hotkey.onchange = () => void applyHotkey(el.hotkey.value.trim() || DEFAULT_HOTKEY);

el.connect.onclick = async () => {
  if (connected) {
    relay.close();
    await teardown();
    setStatus("", "Not connected");
    return;
  }
  const code = normaliseCode(el.code.value);
  store.set("code", code);
  aim = loadAim();
  showAim();
  setStatus("", "Connecting…");
  el.connect.textContent = "Disconnect";
  el.connect.classList.add("on");
  relay.connect(code, role!, role === "point" ? "host" : "guest");
};

/**
 * Copy build info plus the Rust side's log tail to the clipboard in one click.
 *
 * The overlay can fail with nothing visible on screen — see the `open_overlay` catch above — so
 * this is what turns "it didn't work" into something with a build number and a log attached.
 */
el.diag.onclick = async () => {
  const original = el.diag.textContent;
  try {
    const text = await invoke<string>("diagnostics");
    await navigator.clipboard.writeText(text);
    el.diag.textContent = "Copied";
  } catch {
    el.diag.textContent = "Couldn't copy — try again";
  }
  setTimeout(() => { el.diag.textContent = original; }, 2000);
};

/** Stamp the footer with exactly which build this is — first question of any bug report. */
async function showBuild(): Promise<void> {
  try {
    const b = await invoke<{ version: string; commit: string; built: string; os: string }>("build_info");
  os = b.os;
    const when = new Date(Number(b.built) * 1000);
    const stamp = when.toLocaleString(undefined, {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
    // The trailing "+" on a commit means it was built from a modified tree — see build.rs.
    $("build").textContent = `v${b.version} · ${b.commit} · ${stamp}`;
  } catch {
    $("build").textContent = "";
  }
}

/**
 * Hide what this platform cannot do yet, rather than letting someone find out by hitting it.
 *
 * The Windows build implements only the viewing side — `cursor_position`, `modifiers` and
 * `clicks` are stubs there. They return empty values rather than panicking, so a hole in this
 * guard degrades instead of crashing, but the honest thing is to not offer the button at all.
 */
function applyPlatformLimits(): void {
  if (os !== "windows") return;
  const host = el.role.querySelector('button[data-role="point"]') as HTMLButtonElement | null;
  if (host) {
    host.disabled = true;
    host.title = "Pointing from Windows is not built yet — this build can receive only.";
    const sub = host.querySelector("span");
    if (sub) sub.textContent = "Not on Windows yet";
  }
  if (role === "point") setRole("view");
}

function loadAim(): Rect | null {
  try {
    const raw = store.get(aimKey());
    return raw ? (JSON.parse(raw) as Rect) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  await showBuild();
  applyPlatformLimits();
  displays = await invoke<Display[]>("displays");
  el.display.innerHTML = "";
  for (const d of displays) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = `${d.label} — ${Math.round(d.w)} × ${Math.round(d.h)}`;
    el.display.append(o);
  }
  const savedDisplay = store.get("display");
  if (displays.some((d) => d.id === savedDisplay)) el.display.value = savedDisplay;
  el.display.onchange = async () => {
    store.set("display", el.display.value);
    if (connected && role === "view") await startViewing();
  };

  el.code.value = store.get("code");
  el.hotkey.value = store.get("hotkey", DEFAULT_HOTKEY);
  armMode = store.get("mode", "tap") === "hold" ? "hold" : "tap";
  for (const x of el.mode.querySelectorAll("button")) {
    x.setAttribute("aria-pressed", String(x.getAttribute("data-mode") === armMode));
  }
  const savedRole = store.get("role");
  if (savedRole === "point" || savedRole === "view") setRole(savedRole);
  aim = loadAim();
  showAim();
  validate();
}

void boot();
