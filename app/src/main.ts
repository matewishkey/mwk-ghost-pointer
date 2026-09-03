// The control window. It owns the socket, the aim rect and the arm state; the overlay and the
// aim picker are dumb views that this file feeds.

import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Relay, randomCode, normaliseCode, isValidCode, TEXT_MAX } from "./protocol";
import type { ClickButton, Geo, Peer, Role, TextMsg } from "./protocol";

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
  reveal: $<HTMLButtonElement>("reveal"), copyCode: $<HTMLButtonElement>("copy-code"),
  testOverlay: $<HTMLButtonElement>("test-overlay"), testOverlayHint: $("test-overlay-hint"),
  connectStep: $("connect-step"), connect: $<HTMLButtonElement>("connect"),
  dot: $("dot"), statusText: $("status-text"), rtt: $("rtt"),
  aimStep: $("aim-step"), aim: $<HTMLButtonElement>("aim"), aimHint: $("aim-hint"), peerHint: $("peer-hint"),
  armStep: $("arm-step"), mode: $("mode"), hotkey: $<HTMLInputElement>("hotkey"),
  pulseKey: $<HTMLInputElement>("pulse-key"),
  armed: $("armed"), armedText: $("armed-text"), guestLive: $("guest-live"),
  guestEscape: $("guest-escape"),
  textStep: $("text-step"), composer: $<HTMLTextAreaElement>("composer"), keep: $("keep"),
  textCount: $("text-count"), sendText: $<HTMLButtonElement>("send-text"),
  clearMarks: $<HTMLButtonElement>("clear-marks"), textHint: $("text-hint"),
  inboxStep: $("inbox-step"), inbox: $("inbox"),
  diag: $<HTMLButtonElement>("diag"),
};

const DEFAULT_HOTKEY = "Alt+Shift+A";
const DEFAULT_PULSE_KEY = "Alt+Shift+B";
/**
 * What the arm key used to be, before pulsing moved off the mouse (mate, 3 Sep).
 *
 * Anyone who ran an earlier build has the old accelerator saved, and a stored value beats a
 * changed default — so they would keep the old key and never see the new one. Migrated once,
 * and only when it is still the old default: a key someone actually chose is left alone.
 */
const LEGACY_HOTKEY = "Control+Alt+Shift+G";
/**
 * The guest's escape hatch. Deliberately awkward, and deliberately NOT the host's arm key.
 *
 * The guest registers a global shortcut whose only job is to tear down a misbehaving overlay —
 * it disconnects them. That must never be a chord someone can hit while working. `Alt+Shift+A`
 * became the arm key on 3 Sep and was handed to the guest as well, which meant two modifiers and
 * a letter would silently kill a guest's session mid-call. Roles have different needs here: the
 * host wants ergonomic, the guest wants unhittable.
 */
const GUEST_ESCAPE_HOTKEY = "Control+Alt+Shift+G";
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
/** Stay mode: the text mark persists until cleared. Off means it fades like the ghost does. */
let keepText = true;
/**
 * The mark id currently being composed, minted on the first keystroke and retired on send.
 * One id per mark is what lets chunks replace each other instead of piling up.
 */
let draftId: string | null = null;
/** Where the last pointer sample was, so text lands where the ghost is rather than mid-screen. */
let lastAim: { x: number; y: number } = { x: 0.5, y: 0.5 };
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

/** Pointer samples received since the last heartbeat, and the last RTT the relay reported. */
let rxSinceBeat = 0;
let lastRtt = -1;
let beatTimer: number | null = null;

/**
 * A line in the log every 5 seconds while connected.
 *
 * Two jobs. It records what the session actually did — message rate and latency — so a report of
 * "it was laggy" has numbers behind it instead of a memory. And because this is a `setInterval`
 * in the control window, **the spacing of the lines is itself the measurement**: macOS throttles
 * timers in a webview whose window is occluded, so if the guest buries this window behind their
 * browser and the beats stretch to 10 or 30 seconds, that is the lag, caught in the act.
 */
function startHeartbeat(): void {
  stopHeartbeat();
  beatTimer = window.setInterval(() => {
    logLine(`beat: rx=${rxSinceBeat} in ~5s, rtt=${lastRtt}ms, armed=${armed}, role=${role}`);
    rxSinceBeat = 0;
  }, 5000);
}

function stopHeartbeat(): void {
  if (beatTimer !== null) window.clearInterval(beatTimer);
  beatTimer = null;
}

/** Write to the app log. The socket lives here, so its lifecycle has to be recorded here. */
function logLine(msg: string, level: "info" | "warn" | "error" = "info"): void {
  void invoke("log_line", { level, msg });
}

const relay = new Relay({
  onOpen: (_you, peers) => {
    connected = true;
    logLine(`connected as ${role}, ${peers.length} peer(s) already in the room`);
    startHeartbeat();
    setStatus("on", role === "point" ? "Connected — waiting for them" : "Connected");
    onPeers(peers);
    void (role === "point" ? startHosting() : startViewing());
  },
  onPeers,
  onPointer: (m) => {
    rxSinceBeat++;
    if (role === "view") void invoke("draw", { payload: { x: m.x, y: m.y, a: m.a } });
  },
  onClick: (m) => {
    // The guest's overlay covers exactly the display it picked, so normalised coordinates land
    // straight on it with nothing to offset.
    if (role === "view") void invoke("pulse", { payload: { x: m.x, y: m.y, b: m.b } });
  },
  onText: (m) => {
    if (role !== "view") return;
    void invoke("text", { payload: { m: m.m, x: m.x, y: m.y, s: m.s, end: m.end, keep: m.keep } });
    showInbox(m);
  },
  onClear: () => {
    if (role !== "view") return;
    void invoke("clear_marks");
    // The inbox deliberately survives a clear. Clearing is about taking marks off their screen,
    // not about revoking a command they were part-way through pasting.
  },
  onRtt: (ms) => { lastRtt = ms; el.rtt.textContent = `${ms} ms`; },
  onClose: (why) => {
    logLine(`socket closed: ${why}`, why === "disconnected" ? "info" : "warn");
    connected = false;
    setStatus(why === "disconnected" ? "" : "bad", why[0].toUpperCase() + why.slice(1));
    void teardown();
  },
  onRetrying: (attempt, wait) => {
    logLine(`reconnecting, attempt ${attempt}, in ${wait}ms`, "warn");
    setStatus("bad", `Connection dropped — reconnecting (${attempt})…`);
    // The Connect button still says Disconnect while retrying, because pressing it is how you
    // stop the retries. Saying "Connect" would suggest nothing is happening.
    el.connect.textContent = "Stop trying";
    el.connect.classList.add("on");
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
    composerState();
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
  if (!hostScreen) return;
  try {
    await invoke("open_overlay", { x: hostScreen.x, y: hostScreen.y, w: hostScreen.w, h: hostScreen.h });
  } catch (err) {
    // Same failure shape the guest path already guards against (see startViewing) — open_overlay
    // rejecting here used to vanish as a silent unhandled rejection, on the host role too.
    setStatus("bad", `Overlay failed to arm: ${err}`);
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
 * Put a pulse on their screen, where the ghost is.
 *
 * **Bound to a hotkey, not to a mouse click** (mate, 3 Sep). Click-to-pulse shipped on 31 Aug on
 * the theory that while pointing, the thing under the cursor is a video of someone else's screen
 * where a click does nothing. In real use that is false often enough to be dangerous: the click
 * lands in whatever window is actually there and runs whatever it hits. Reading a click costs no
 * permission, but it was never possible to *consume* one — so the only safe pulse is one that
 * never involves the mouse button at all.
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
    // Remembered even while disarming, so text sent after you stop pointing still lands at the
    // last place you were pointing at rather than jumping to the middle of their screen.
    lastAim = { x: nx, y: ny };
    const local = toHostOverlay(nx, ny);
    if (local) void invoke("draw", { payload: { ...local, a: armed ? 1 : 0 } });
  }
  wasArmed = armed;
});

/**
 * The pulse hotkey.
 *
 * Only while pointing: a pulse that arrives when no ghost is visible appears out of nowhere on
 * their screen, with nothing to explain it.
 */
void listen("pulse-key", () => {
  if (role !== "point" || !connected || !armed) return;
  firePulse(lastAim.x, lastAim.y, 0);
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
    logLine("guest pressed the escape hotkey — closing the overlay and disconnecting", "warn");
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
  // misbehaves. Its own chord, never the host's arm key. See the `hotkey` listener.
  await applyHotkey(GUEST_ESCAPE_HOTKEY, null);
  el.guestEscape.textContent = GUEST_ESCAPE_HOTKEY;
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
 *
 * Click-through and cursor visibility turned out to be two different claims — a real Windows
 * machine passed clicks through while the system cursor stayed invisible the whole time, see
 * `overlay.html`. So this also polls `cursor_visible` (Windows only; `null` elsewhere) once a
 * second, which is what would have caught that without anyone having to notice it by eye, and
 * every reading lands in the Rust log too via `Copy diagnostics`.
 */
let testOverlayTimer: ReturnType<typeof setTimeout> | null = null;
let testOverlayPoll: ReturnType<typeof setInterval> | null = null;

/**
 * A Tauri command that panics drops its response without sending one, so `invoke` just never
 * resolves — the frontend has no way to tell "still working" from "silently died" apart. Race it
 * against a clock instead of trusting it to always answer.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} did not respond within ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err as Error); },
    );
  });
}

function endOverlayTest(msg: string): void {
  if (testOverlayTimer !== null) {
    clearTimeout(testOverlayTimer);
    testOverlayTimer = null;
  }
  if (testOverlayPoll !== null) {
    clearInterval(testOverlayPoll);
    testOverlayPoll = null;
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
  el.testOverlayHint.textContent = "Arming…";
  try {
    await withTimeout(
      invoke("open_overlay", { x: d.x, y: d.y, w: d.w, h: d.h }),
      5000,
      "open_overlay",
    );
  } catch (err) {
    el.testOverlay.disabled = false;
    el.testOverlay.textContent = "Test click-through";
    el.testOverlayHint.textContent = `Overlay failed to arm: ${err}`;
    return;
  }

  let sawHidden = false;
  let secondsLeft = 10;
  const tick = async () => {
    const showing = await invoke<boolean | null>("cursor_visible").catch(() => null);
    if (showing === false) sawHidden = true;
    const cursorNote = showing === null ? "" : ` Cursor: ${showing ? "visible" : "HIDDEN"}.`;
    el.testOverlayHint.textContent =
      `Try clicking your desktop now.${cursorNote} Closes in ${secondsLeft}s.`;
    secondsLeft--;
  };
  void tick();
  testOverlayPoll = setInterval(tick, 1000);
  testOverlayTimer = setTimeout(() => {
    endOverlayTest(
      sawHidden
        ? "Closed automatically. The cursor went invisible during the test — see Copy diagnostics."
        : "Closed automatically. Cursor stayed visible. If your desktop took the click, it's fully click-through.",
    );
  }, 10_000);
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
// Text
// ---------------------------------------------------------------------------------------------

/**
 * Text is composed in a focused box in our own window, never captured globally.
 *
 * That is the whole reason this feature costs no permission. Reading ordinary keystrokes while
 * another app has focus needs Input Monitoring on macOS — `m0-findings.md` calls it the one
 * exception with no way around it. A textarea we own reads only what is typed into it, which
 * is not a TCC concern at all, and zero permissions is a hard constraint here.
 */
function composerState(): void {
  const len = el.composer.value.length;
  const over = len > TEXT_MAX;
  el.textCount.textContent = len ? `${len}/${TEXT_MAX}` : "";
  el.textCount.classList.toggle("over", over);
  el.sendText.disabled = !connected || len === 0 || over;
  el.clearMarks.disabled = !connected;
  // Refusing is the point. Clipping to fit would hand them a command that looks whole and is
  // not — the failure mode issue #6 asks the relay never to allow either.
  el.textHint.textContent = over
    ? `Too long by ${len - TEXT_MAX}. Shorten it — it will not be sent cut off.`
    : "They see it appear as you type, and can copy it as text.";
}

/** Push the draft to the guest and to the host's own overlay. */
function streamText(end: boolean): void {
  if (!draftId) return;
  const s = el.composer.value;
  if (s.length > TEXT_MAX) return;
  const { x, y } = lastAim;
  relay.sendText(draftId, x, y, s, end, keepText);
  const local = toHostOverlay(x, y);
  if (local) {
    void invoke("text", {
      payload: { m: draftId, x: local.x, y: local.y, s, end: end ? 1 : 0, keep: keepText ? 1 : 0 },
    });
  }
}

el.composer.oninput = () => {
  // A draft is a mark from the first keystroke, so the guest watches it arrive rather than
  // having it appear whole — the same reason the ghost streams instead of waiting.
  if (!draftId) draftId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  composerState();
  if (el.composer.value.length <= TEXT_MAX) streamText(false);
};

el.composer.onkeydown = (e) => {
  // Enter sends, Shift+Enter makes a new line — text is multi-line, and a command block pasted
  // in here keeps its own newlines either way.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el.sendText.click();
  }
};

el.sendText.onclick = () => {
  if (el.sendText.disabled) return;
  streamText(true);
  draftId = null;
  el.composer.value = "";
  composerState();
};

el.clearMarks.onclick = () => {
  // Retract an uncommitted draft as well, or it would sit on their screen with no way to reach
  // it — the draft is not a mark the relay knows about yet.
  if (draftId) {
    const { x, y } = lastAim;
    relay.sendText(draftId, x, y, "", true, keepText);
    void invoke("text", { payload: { m: draftId, x, y, s: "", end: 1, keep: 0 } });
    draftId = null;
    el.composer.value = "";
  }
  relay.sendClear();
  void invoke("clear_marks");
  composerState();
};

el.keep.onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button[data-keep]");
  if (!b) return;
  keepText = b.getAttribute("data-keep") === "1";
  store.set("keep", keepText ? "1" : "0");
  for (const x of el.keep.querySelectorAll("button")) {
    x.setAttribute("aria-pressed", String((x.getAttribute("data-keep") === "1") === keepText));
  }
};

/** The guest's list of received text, newest first, each with a Copy button. */
function showInbox(m: TextMsg): void {
  el.inboxStep.hidden = false;
  let row = el.inbox.querySelector<HTMLElement>(`[data-mark="${CSS.escape(m.m)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.className = "note";
    row.dataset.mark = m.m;
    // Built element by element rather than from a markup string. Nothing here is interpolated
    // today, but this row exists to display a string another machine sent — a template literal
    // is one careless edit away from parsing that string as HTML.
    row.append(document.createElement("pre"));
    const copy = document.createElement("button");
    copy.className = "ghost-btn copy";
    copy.textContent = "Copy";
    row.append(copy);
    el.inbox.prepend(row);
    while (el.inbox.children.length > 8) el.inbox.lastElementChild!.remove();
  }
  row.querySelector("pre")!.textContent = m.s;
  row.classList.toggle("live", m.end === 0);
}

el.inbox.onclick = async (e) => {
  const b = (e.target as HTMLElement).closest("button.copy");
  if (!b) return;
  const pre = b.parentElement!.querySelector("pre")!;
  await navigator.clipboard.writeText(pre.textContent ?? "");
  b.textContent = "Copied";
  setTimeout(() => { b.textContent = "Copy"; }, 1500);
};

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
  stopHeartbeat();
  rxSinceBeat = 0;
  lastRtt = -1;
  // A draft belongs to the connection it was being typed into. Keeping it across a reconnect
  // would leave a mark id the other side has never heard of.
  draftId = null;
  composerState();
  await invoke("stop_cursor_stream");
  await invoke("close_overlay");
  el.guestLive.hidden = true;
  el.connect.textContent = "Connect";
  el.connect.classList.remove("on");
}

async function applyHotkey(accel: string, pulseAccel?: string | null): Promise<void> {
  // `null` is the guest: one key, no pulse. `undefined` means "whatever is in the field".
  const pulse = pulseAccel === null ? null : (pulseAccel || el.pulseKey.value.trim() || DEFAULT_PULSE_KEY);
  try {
    await invoke("set_hotkeys", { arm: accel, pulse });
    el.hotkey.setCustomValidity("");
    if (pulse !== null) {
      store.set("hotkey", accel);
      store.set("pulseKey", pulse);
    }
  } catch (err) {
    // A shortcut the OS will not give us is worth saying out loud — silently not arming is the
    // kind of bug that gets blamed on the network. Both keys go down together, so this covers
    // either one being refused; the message carries whichever the backend named.
    setStatus("bad", `${err}`);
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
  el.textStep.hidden = r !== "point";
  // The inbox appears when something actually arrives — an empty box on the guest's screen
  // would be one more thing to explain for a feature they may never be sent.
  if (r !== "view") el.inboxStep.hidden = true;
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

/**
 * The room code is masked by default.
 *
 * The relay has no auth — the code *is* the room — and the host is very often the one sharing a
 * screen while they read it out. A six-character code sitting in plain text on a shared screen
 * is the whole credential, handed to everyone watching. So it is hidden, copied rather than
 * read aloud, and revealed only deliberately.
 */
el.reveal.onclick = () => {
  const hidden = el.code.type === "password";
  el.code.type = hidden ? "text" : "password";
  el.reveal.textContent = hidden ? "Hide" : "Show";
};

el.copyCode.onclick = async () => {
  const code = normaliseCode(el.code.value);
  if (!code) return;
  await navigator.clipboard.writeText(code);
  el.copyCode.textContent = "Copied";
  setTimeout(() => { el.copyCode.textContent = "Copy"; }, 1500);
};

el.hotkey.onchange = () => void applyHotkey(el.hotkey.value.trim() || DEFAULT_HOTKEY);
el.pulseKey.onchange = () =>
  void applyHotkey(el.hotkey.value.trim() || DEFAULT_HOTKEY, el.pulseKey.value.trim() || DEFAULT_PULSE_KEY);

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
  const savedHotkey = store.get("hotkey", DEFAULT_HOTKEY);
  el.hotkey.value = savedHotkey === LEGACY_HOTKEY ? DEFAULT_HOTKEY : savedHotkey;
  el.pulseKey.value = store.get("pulseKey", DEFAULT_PULSE_KEY);
  armMode = store.get("mode", "tap") === "hold" ? "hold" : "tap";
  for (const x of el.mode.querySelectorAll("button")) {
    x.setAttribute("aria-pressed", String(x.getAttribute("data-mode") === armMode));
  }
  keepText = store.get("keep", "1") === "1";
  for (const x of el.keep.querySelectorAll("button")) {
    x.setAttribute("aria-pressed", String((x.getAttribute("data-keep") === "1") === keepText));
  }
  const savedRole = store.get("role");
  if (savedRole === "point" || savedRole === "view") setRole(savedRole);
  aim = loadAim();
  showAim();
  validate();
  composerState();
}

void boot();
