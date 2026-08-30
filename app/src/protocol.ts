// The wire protocol, exactly as `docs/spec.md` defines it. That file is owned by the relay
// side of the project and is read-only here — if this file and that file ever disagree, that
// file is right and this one is the bug.

export const RELAY = "wss://ghost-pointer-relay.mergodon.workers.dev";

/** No I, O, 0 or 1 — they get misheard when someone reads the code aloud on a call. */
export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LEN = 6;

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

/** A pointer sample as it arrives from the relay: normalised 0..1, with the sender stamped on. */
export interface PointerMsg {
  k: "p";
  x: number;
  y: number;
  a: 0 | 1;
  t: number;
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
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
}

export function isValidCode(code: string): boolean {
  return code.length === CODE_LEN && [...code].every((c) => ALPHABET.includes(c));
}

type Handlers = {
  onOpen?: (you: Peer, peers: Peer[]) => void;
  onPeers?: (peers: Peer[]) => void;
  onPointer?: (m: PointerMsg) => void;
  onRtt?: (ms: number) => void;
  onClose?: (why: string) => void;
};

/**
 * One room, one socket.
 *
 * Deliberately dumb: it does not reconnect, it does not queue, it does not retry. Reconnect
 * handling is explicitly out of scope for the first build — if the socket drops, the UI says so
 * and you press connect again.
 */
export class Relay {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private peers = new Map<string, Peer>();
  /** Last sample actually put on the wire — used to skip frames that would say nothing new. */
  private lastSent = { x: -1, y: -1, a: -1 };

  constructor(private h: Handlers) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(code: string, role: Role, name: string): void {
    this.close();
    const url = `${RELAY}/r/${code}?role=${role}&name=${encodeURIComponent(name)}&hint=oc`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
    ws.onerror = () => this.h.onClose?.("connection failed");
    ws.onclose = (ev) => {
      this.stopPinging();
      // 1000 is our own close(); anything else the user did not ask for.
      this.h.onClose?.(ev.code === 1000 ? "disconnected" : `dropped (${ev.code})`);
    };
    ws.onopen = () => this.startPinging();
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

  sendGeo(g: Geo): void {
    if (this.connected) this.ws!.send(JSON.stringify({ k: "geo", g }));
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
