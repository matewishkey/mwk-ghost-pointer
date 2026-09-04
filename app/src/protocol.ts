// The wire protocol, exactly as `docs/spec.md` defines it. That file is owned by the relay
// side of the project and is read-only here — if this file and that file ever disagree, that
// file is right and this one is the bug.

export const RELAY = "wss://ghost-pointer-relay.mergodon.workers.dev";

/** No I, O, 0 or 1 — they get misheard if anyone does still read a code aloud. */
export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/**
 * Length of a code this app mints. 32^10 ≈ 1.1 quadrillion.
 *
 * Six was chosen so it could be read out on a call. Since the code became masked-and-copied that
 * reason is gone, and the extra entropy costs a person nothing — they press Copy either way.
 */
export const CODE_LEN = 10;
/** What we still *accept*, so a code from an older build keeps working. */
export const CODE_MIN = 6;
export const CODE_MAX = 12;

export type Role = "point" | "view";

export interface Geo {
  w: number;
  h: number;
  label: string;
}

export interface Peer {
  id: string;
  role: Role;
  name?: string;
  geo?: Geo;
}

/** Which mouse button a click pulse came from. DOM numbering, so 1 (middle) is skipped. */
export type ClickButton = 0 | 2;

/** A click pulse as it arrives from the relay. */
export interface ClickMsg {
  k: "c";
  x: number;
  y: number;
  b: ClickButton;
  t: number;
  id: string;
}

/** A pointer sample as it arrives from the relay: normalised 0..1, with the sender stamped on. */
export interface PointerMsg {
  k: "p";
  x: number;
  y: number;
  a: 0 | 1;
  t: number;
  id: string;
}

/**
 * The longest string a single `txt` may carry.
 *
 * **The relay has not stated its own ceiling yet** (issue #6 asks it to). Until it does this is
 * the app's own limit, enforced at the composer with a visible count — never by clipping. Text
 * is for handing over things to paste, so a silently truncated command is worse than a rejected
 * one: it looks whole, and it is not.
 */
export const TEXT_MAX = 2000;

/** A text mark as it arrives from the relay. `s` is carried verbatim — see `sendText`. */
export interface TextMsg {
  k: "txt";
  /** Mark id, minted by the sender. Not the sender's id — that is `id`, as everywhere else. */
  m: string;
  x: number;
  y: number;
  s: string;
  /** 1 on the last chunk of a mark. Chunks before it are the text mid-typing. */
  end: 0 | 1;
  /** 1 = stay mode (the mark persists), 0 = trail mode (it fades like the ghost). */
  keep: 0 | 1;
  t: number;
  id: string;
}

/** Clear every mark in the room. Carries nothing — "clear everything, keep it simple for now". */
export interface ClearMsg {
  k: "clr";
  id: string;
}

export function randomCode(): string {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normaliseCode(raw: string): string {
  // The relay uppercases before validating, so codes are case-insensitive. Doing it here too
  // means the field shows the user the same string the room is actually keyed on.
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_MAX);
}

export function isValidCode(code: string): boolean {
  return (
    code.length >= CODE_MIN &&
    code.length <= CODE_MAX &&
    [...code].every((c) => ALPHABET.includes(c))
  );
}

type Handlers = {
  onOpen?: (you: Peer, peers: Peer[]) => void;
  onPeers?: (peers: Peer[]) => void;
  onPointer?: (m: PointerMsg) => void;
  onClick?: (m: ClickMsg) => void;
  onText?: (m: TextMsg) => void;
  onClear?: (m: ClearMsg) => void;
  onRtt?: (ms: number) => void;
  onClose?: (why: string) => void;
  /** A drop we intend to recover from. `wait` is how long until the next attempt, in ms. */
  onRetrying?: (attempt: number, wait: number) => void;
};

/** Backoff between reconnect attempts, in ms. The last value repeats for as long as it takes. */
const RETRY_MS = [400, 1000, 2000, 4000, 8000];
/** How long a connection has to hold before it counts as good and the backoff resets. */
const STABLE_MS = 5000;

/**
 * One room, one socket — and it reconnects.
 *
 * It used to be deliberately dumb: no retry, no queue, "if the socket drops the UI says so and
 * you press connect again". That held right up until a real call, where a single blip did not
 * read as a blip — it read as the app breaking, mid-conversation, with a client watching. On a
 * guest's machine the control window is behind their browser, so nobody sees the status line
 * that explains it either.
 *
 * It still does not queue or replay: pointer samples are worthless a second later. It reopens
 * the room and lets the normal join path put everything back.
 */
export class Relay {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  /** What we are trying to stay joined to. `null` means the user asked to disconnect. */
  private want: { code: string; role: Role; name: string } | null = null;
  private retryTimer: number | null = null;
  private stableTimer: number | null = null;
  private attempt = 0;
  private peers = new Map<string, Peer>();
  /** Last sample actually put on the wire — used to skip frames that would say nothing new. */
  private lastSent = { x: -1, y: -1, a: -1 };

  constructor(private h: Handlers) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(code: string, role: Role, name: string): void {
    this.close();
    this.want = { code, role, name };
    this.attempt = 0;
    this.open();
  }

  private open(): void {
    if (!this.want) return;
    const { code, role, name } = this.want;
    const url = `${RELAY}/r/${code}?role=${role}&name=${encodeURIComponent(name)}&hint=oc`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
    // No onClose here: a failed socket always fires onclose too, and reporting both told the
    // user the connection died twice.
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      this.clearStable();
      this.stopPinging();
      this.peers.clear();
      this.lastSent = { x: -1, y: -1, a: -1 };
      // 1000 is our own close(); anything else the user did not ask for.
      this.h.onClose?.(ev.code === 1000 ? "disconnected" : `dropped (${ev.code})`);
      if (this.want) this.scheduleRetry();
    };
    ws.onopen = () => {
      // Backoff resets only once a connection has *held* for a while, not the instant it opens.
      // A socket the relay accepts and drops again immediately would otherwise reset the counter
      // every time and hammer it at the shortest interval forever.
      this.stableTimer = window.setTimeout(() => { this.attempt = 0; }, STABLE_MS);
      this.startPinging();
    };
  }

  private handle(m: any): void {
    switch (m.k) {
      case "hello":
        this.peers = new Map((m.peers ?? []).map((p: Peer) => [p.id, p]));
        this.h.onOpen?.(m.you, [...this.peers.values()]);
        break;
      case "join":
        this.peers.set(m.id, { id: m.id, role: m.role, name: m.name });
        this.h.onPeers?.([...this.peers.values()]);
        break;
      case "leave":
        this.peers.delete(m.id);
        this.h.onPeers?.([...this.peers.values()]);
        break;
      case "geo": {
        const p = this.peers.get(m.id);
        if (p) p.geo = m.g;
        this.h.onPeers?.([...this.peers.values()]);
        break;
      }
      case "p":
        this.h.onPointer?.(m as PointerMsg);
        break;
      case "c":
        this.h.onClick?.(m as ClickMsg);
        break;
      case "txt":
        this.h.onText?.(m as TextMsg);
        break;
      case "clr":
        this.h.onClear?.(m as ClearMsg);
        break;
      case "pong":
        this.h.onRtt?.(Date.now() - m.t);
        break;
      // Unknown `k` is ignored by design — that is what makes adding messages backwards-compatible.
    }
  }

  /**
   * Send a pointer sample. Returns false if the frame was identical to the last one and
   * therefore skipped — the spec asks senders to transmit only on actual movement.
   */
  sendPointer(x: number, y: number, visible: boolean): boolean {
    if (!this.connected) return false;
    const a = visible ? 1 : 0;
    // Quantise to the smallest step that can still land on a distinct pixel of a 4K display
    // (1/4096). Below that we would be spending a frame to move the ghost nowhere.
    const qx = Math.round(x * 4096) / 4096;
    const qy = Math.round(y * 4096) / 4096;
    if (qx === this.lastSent.x && qy === this.lastSent.y && a === this.lastSent.a) return false;
    this.lastSent = { x: qx, y: qy, a };
    this.ws!.send(JSON.stringify({ k: "p", x: qx, y: qy, a, t: Date.now() }));
    return true;
  }

  /**
   * Send a click pulse.
   *
   * **The live relay drops this** — it ends its switch with `default: return`, so `c` goes
   * nowhere until issue #6 lands. Sending it anyway is deliberate: the host draws its own pulse
   * locally either way, so the feature is usable and testable now, and the day the relay learns
   * `c` the guest starts seeing them with no change here.
   */
  sendClick(x: number, y: number, b: ClickButton): void {
    if (this.connected) this.ws!.send(JSON.stringify({ k: "c", x, y, b, t: Date.now() }));
  }

  /**
   * Send a text mark, or a chunk of one as it is being typed.
   *
   * Dropped by the live relay today for the same reason `c` is, and sent anyway for the same
   * reason: the host echoes it locally, so it works and can be tested now, and the day the
   * relay learns `txt` the guest starts seeing them with no change here.
   *
   * `s` goes on the wire **verbatim** — not trimmed, not normalised, not re-encoded. Leading
   * whitespace is meaningful in a pasted command block, and the string the guest copies has to
   * be the string that was typed. Length is the caller's problem, capped at `TEXT_MAX` before
   * it ever reaches here.
   */
  sendText(m: string, x: number, y: number, s: string, end: boolean, keep: boolean): void {
    if (!this.connected) return;
    this.ws!.send(JSON.stringify({
      k: "txt", m, x, y, s, end: end ? 1 : 0, keep: keep ? 1 : 0, t: Date.now(),
    }));
  }

  /** Clear every mark in the room. Same drop-today caveat as `sendText`. */
  sendClear(): void {
    if (this.connected) this.ws!.send(JSON.stringify({ k: "clr" }));
  }

  sendGeo(g: Geo): void {
    if (this.connected) this.ws!.send(JSON.stringify({ k: "geo", g }));
  }

  private clearStable(): void {
    if (this.stableTimer !== null) window.clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.h.onRetrying?.(this.attempt, wait);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, wait);
  }

  private startPinging(): void {
    const ping = () => {
      if (this.connected) this.ws!.send(JSON.stringify({ k: "ping", t: Date.now() }));
    };
    ping();
    this.pingTimer = window.setInterval(ping, 3000);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  close(): void {
    // Clearing `want` first is what makes this a disconnect rather than a blip: the onclose
    // handler checks it, so nothing reconnects behind the user's back.
    this.want = null;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearStable();
    this.attempt = 0;
    this.stopPinging();
    this.peers.clear();
    this.lastSent = { x: -1, y: -1, a: -1 };
    if (this.ws) {
      this.ws.onclose = null; // a close we asked for is not an event worth reporting
      this.ws.close(1000);
      this.ws = null;
    }
  }
}
