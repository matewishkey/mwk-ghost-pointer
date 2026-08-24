import { DurableObject } from "cloudflare:workers";

/**
 * Ghost Pointer relay.
 *
 * One Durable Object per room code. Clients connect over WebSocket, send pointer
 * samples, and the room fans them out to everyone else. The relay is deliberately
 * dumb: it knows about membership and the last display geometry each viewer
 * announced, and nothing else.
 *
 * Wire protocol: docs/spec.md
 */

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
}

/** Room codes are 6 chars from an unambiguous alphabet (no I/O/0/1). */
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/** Runaway guard. Well above the 60 Hz a sane client sends. */
const MAX_MSG_PER_SEC = 200;

/** Durable Object placement regions. Anything else is a 400, not a runtime error. */
const HINTS = ["oc", "apac", "weur", "eeur", "wnam", "enam", "sam", "afr", "me"] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "ghost-pointer-relay" });
    }

    const match = url.pathname.match(/^\/r\/([^/]+)$/);
    if (!match) return json({ error: "not_found" }, 404);

    const code = decodeURIComponent(match[1]).toUpperCase();
    if (!CODE_RE.test(code)) {
      return json({ error: "bad_room_code", expected: CODE_RE.source }, 400);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "expected_websocket_upgrade" }, 426);
    }

    // idFromName places the object near whoever connects first. For a session
    // that is always hosted from the same place, pass ?hint=oc (or apac/weur/
    // eeur/wnam/enam/sam/afr/me) to pin it near the host instead.
    const hint = url.searchParams.get("hint");
    if (hint && !HINTS.includes(hint as (typeof HINTS)[number])) {
      return json({ error: "bad_location_hint", allowed: HINTS }, 400);
    }

    const id = env.ROOM.idFromName(code);
    const stub = hint
      ? env.ROOM.get(id, { locationHint: hint as DurableObjectLocationHint })
      : env.ROOM.get(id);

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** Per-socket state. Survives hibernation via serializeAttachment. */
type Member = {
  id: string;
  /** "point" sends the ghost, "view" draws it. */
  role: "point" | "view";
  name: string;
  /** Viewer's target display, so a pointer joining later can fit its aim rect. */
  geo: { w: number; h: number; label: string } | null;
};

export class Room extends DurableObject<Env> {
  /**
   * Per-member message counters over a fixed 1-second window that resets wholesale at the
   * boundary (tumbling, not sliding — a burst straddling the boundary can briefly pass 2x).
   * Good enough for a runaway guard. Rebuilt after hibernation.
   */
  private rate = new Map<string, { since: number; n: number }>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "point" ? "point" : "view";
    const name = (url.searchParams.get("name") ?? role).slice(0, 40);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: the DO can be evicted while sockets stay open, so an idle
    // room stops billing duration. Handlers below are re-entered on wake.
    this.ctx.acceptWebSocket(server);

    const me: Member = { id: crypto.randomUUID().slice(0, 8), role, name, geo: null };
    server.serializeAttachment(me);

    const peers = this.members().filter((m) => m.id !== me.id);
    server.send(
      JSON.stringify({
        k: "hello",
        you: { id: me.id, role: me.role, name: me.name },
        peers: peers.map((p) => ({ id: p.id, role: p.role, name: p.name, geo: p.geo })),
      }),
    );
    this.broadcast({ k: "join", id: me.id, role: me.role, name: me.name }, me.id);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Member | null;
    if (!me) return;

    if (this.throttled(me.id)) return;
    if (typeof raw !== "string") return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.k) {
      // Round-trip probe. Answered directly, never fanned out.
      case "ping":
        ws.send(JSON.stringify({ k: "pong", t: msg.t }));
        return;

      // Pointer sample. The hot path — straight to everyone else, unmodified
      // apart from the sender id so a viewer can tell two pointers apart.
      case "p":
        this.broadcast({ ...msg, id: me.id }, me.id);
        return;

      // A viewer announcing which display it is drawing on. Viewers only: a pointer has no
      // display to announce, and letting one set `geo` would poison the aim-rect fit that
      // other pointers read out of `hello.peers`.
      case "geo": {
        if (me.role !== "view") return;
        const g = msg.g as Member["geo"];
        if (!g || typeof g.w !== "number" || typeof g.h !== "number") return;
        me.geo = { w: g.w, h: g.h, label: String(g.label ?? "").slice(0, 60) };
        ws.serializeAttachment(me);
        this.broadcast({ k: "geo", id: me.id, g: me.geo }, me.id);
        return;
      }

      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.departed(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.departed(ws);
  }

  private departed(ws: WebSocket): void {
    const me = ws.deserializeAttachment() as Member | null;
    if (!me) return;
    this.rate.delete(me.id);
    this.broadcast({ k: "leave", id: me.id }, me.id);
  }

  private members(): Member[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as Member | null)
      .filter((m): m is Member => m !== null);
  }

  private broadcast(payload: unknown, exceptId?: string): void {
    const body = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const m = ws.deserializeAttachment() as Member | null;
      if (!m || m.id === exceptId) continue;
      try {
        ws.send(body);
      } catch {
        // Socket is going away; webSocketClose will clean up.
      }
    }
  }

  private throttled(id: string): boolean {
    const now = Date.now();
    const win = this.rate.get(id);
    if (!win || now - win.since >= 1000) {
      this.rate.set(id, { since: now, n: 1 });
      return false;
    }
    win.n += 1;
    return win.n > MAX_MSG_PER_SEC;
  }
}
