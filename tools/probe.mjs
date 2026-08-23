#!/usr/bin/env node
/**
 * Relay smoke test. Opens a viewer and a pointer against the same room,
 * checks presence, geometry replay and pointer fan-out, then measures
 * round-trip latency over a burst of samples.
 *
 *   node tools/probe.mjs ws://127.0.0.1:8787
 *   node tools/probe.mjs wss://ghost-pointer-relay.<subdomain>.workers.dev
 */

const base = (process.argv[2] ?? "ws://127.0.0.1:8787").replace(/\/$/, "");
const ROOM = "PRBE27";
const SAMPLES = 120; // 2 seconds at 60 Hz

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function connect(role, name) {
  const ws = new WebSocket(`${base}/r/${ROOM}?role=${role}&name=${name}`);
  ws.inbox = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    ws.inbox.push(m);
    ws.onkind?.(m);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`connect failed: ${role}`)));
  });
}

const waitFor = (ws, kind, ms = 4000) =>
  new Promise((resolve, reject) => {
    const hit = ws.inbox.find((m) => m.k === kind);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${kind}"`)), ms);
    const prev = ws.onkind;
    ws.onkind = (m) => {
      prev?.(m);
      if (m.k === kind) {
        clearTimeout(timer);
        ws.onkind = prev;
        resolve(m);
      }
    };
  });

console.log(`\nGhost Pointer relay probe → ${base}  (room ${ROOM})\n`);

// --- HTTP surface -----------------------------------------------------------
const httpBase = base.replace(/^ws/, "http");
const health = await fetch(`${httpBase}/health`).then((r) => r.json());
check("GET /health", health.ok === true, JSON.stringify(health));

const bad = await fetch(`${httpBase}/r/lower1`);
check("bad room code rejected", bad.status === 400, `got ${bad.status}`);

const noUpgrade = await fetch(`${httpBase}/r/${ROOM}`);
check("plain GET on room rejected", noUpgrade.status === 426, `got ${noUpgrade.status}`);

// --- presence ---------------------------------------------------------------
const viewer = await connect("view", "viewer");
const vHello = await waitFor(viewer, "hello");
check("viewer hello", vHello.you.role === "view" && vHello.peers.length === 0);

viewer.send(JSON.stringify({ k: "geo", g: { w: 3024, h: 1964, label: "Built-in" } }));
await new Promise((r) => setTimeout(r, 150));

const pointer = await connect("point", "pointer");
const pHello = await waitFor(pointer, "hello");
check("pointer hello sees viewer", pHello.peers.length === 1 && pHello.peers[0].role === "view");
check(
  "viewer geometry replayed to late joiner",
  pHello.peers[0].geo?.w === 3024 && pHello.peers[0].geo?.h === 1964,
  JSON.stringify(pHello.peers[0].geo),
);

const join = await waitFor(viewer, "join");
check("viewer notified of join", join.role === "point");

// --- fan-out ----------------------------------------------------------------
const got = [];
viewer.onkind = (m) => m.k === "p" && got.push(m);

const rtt = [];
pointer.onkind = (m) => m.k === "pong" && rtt.push(Date.now() - m.t);

for (let i = 0; i < SAMPLES; i++) {
  pointer.send(JSON.stringify({ k: "p", x: i / SAMPLES, y: 0.5, a: 1, t: Date.now() }));
  if (i % 10 === 0) pointer.send(JSON.stringify({ k: "ping", t: Date.now() }));
  await new Promise((r) => setTimeout(r, 1000 / 60));
}
await new Promise((r) => setTimeout(r, 500));

check("pointer samples delivered", got.length === SAMPLES, `${got.length}/${SAMPLES}`);
check("sender id stamped", got.every((m) => m.id === pHello.you.id));
check("payload intact", got[0]?.x === 0 && got.at(-1)?.x === (SAMPLES - 1) / SAMPLES);
check("no echo to sender", !pointer.inbox.some((m) => m.k === "p"));

// --- leave ------------------------------------------------------------------
pointer.close();
const leave = await waitFor(viewer, "leave");
check("leave broadcast", leave.id === pHello.you.id);
viewer.close();

// --- latency ----------------------------------------------------------------
rtt.sort((a, b) => a - b);
const p = (q) => rtt[Math.min(rtt.length - 1, Math.floor(rtt.length * q))];
console.log(
  `\n  round-trip over ${rtt.length} pings:  min ${rtt[0]}ms   p50 ${p(0.5)}ms   p95 ${p(0.95)}ms   max ${rtt.at(-1)}ms`,
);

console.log(failures === 0 ? "\n  ALL CHECKS PASSED\n" : `\n  ${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
