// The control window. It owns the socket, the aim rect and the arm state; the overlay and the
// aim picker are dumb views that this file feeds.

import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Relay, randomCode, normaliseCode, isValidCode } from "./protocol";
import type { Geo, Peer, Role } from "./protocol";

interface Display {
  id: string; label: string;
  x: number; y: number; w: number; h: number;
  scale: number; is_primary: boolean;
}
interface Rect { x: number; y: number; w: number; h: number }
interface Cursor { x: number; y: number; alt: boolean; ctrl: boolean; shift: boolean; meta: boolean }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  role: $("role"), code: $<HTMLInputElement>("code"), gen: $<HTMLButtonElement>("gen"),
  roomStep: $("room-step"), displayStep: $("display-step"), display: $<HTMLSelectElement>("display"),
  connectStep: $("connect-step"), connect: $<HTMLButtonElement>("connect"),
  dot: $("dot"), statusText: $("status-text"), rtt: $("rtt"),
  aimStep: $("aim-step"), aim: $<HTMLButtonElement>("aim"), aimHint: $("aim-hint"), peerHint: $("peer-hint"),
  armStep: $("arm-step"), mode: $("mode"), hotkey: $<HTMLInputElement>("hotkey"),
  armed: $("armed"), armedText: $("armed-text"), guestLive: $("guest-live"),
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
let connected = false;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

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
  const cx = aim.x + aim.w / 2;
  const cy = aim.y + aim.h / 2;
  hostScreen =
    displays.find((d) => cx >= d.x && cx < d.x + d.w && cy >= d.y && cy < d.y + d.h) ??
    displays.find((d) => d.is_primary) ??
    displays[0] ?? null;
  if (hostScreen) {
    await invoke("open_overlay", { x: hostScreen.x, y: hostScreen.y, w: hostScreen.w, h: hostScreen.h });
  }
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
    if (hostScreen) {
      // Map back through the aim rect rather than using the raw cursor, so the host sees the
      // ghost park at the edge exactly as the guest does when the mouse leaves the rect.
      void invoke("draw", {
        payload: {
          x: (aim.x + nx * aim.w - hostScreen.x) / hostScreen.w,
          y: (aim.y + ny * aim.h - hostScreen.y) / hostScreen.h,
          a: armed ? 1 : 0,
        },
      });
    }
  }
  wasArmed = armed;
});

void listen("hotkey", () => {
  if (role === "point" && armMode === "tap") setArmed(!armed);
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
  relay.sendGeo({ w: d.w, h: d.h, label: d.label });
  await invoke("open_overlay", { x: d.x, y: d.y, w: d.w, h: d.h });
  el.guestLive.hidden = false;
}

const chosenDisplay = (): Display | null =>
  displays.find((d) => d.id === el.display.value) ?? displays.find((d) => d.is_primary) ?? displays[0] ?? null;

// ---------------------------------------------------------------------------------------------
// Aim rect
// ---------------------------------------------------------------------------------------------

const aimKey = () => `aim.${normaliseCode(el.code.value)}`;

function showAim(): void {
  el.aimHint.textContent = aim
    ? `Set — ${Math.round(aim.w)} × ${Math.round(aim.h)} at ${Math.round(aim.x)}, ${Math.round(aim.y)}. Drag again any time the window moves.`
    : "Not set yet. Drag a box around the window showing their screen.";
  el.aim.textContent = aim ? "Redraw the aim area" : "Set the aim area";
}

el.aim.onclick = async () => {
  const p = await invoke<{ x: number; y: number } | null>("cursor_position");
  const under = p ? displays.find((d) => p.x >= d.x && p.x < d.x + d.w && p.y >= d.y && p.y < d.y + d.h) : null;
  const d = under ?? displays.find((x) => x.is_primary) ?? displays[0];
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
