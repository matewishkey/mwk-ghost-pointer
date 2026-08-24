// Throwaway: drives the viewer from node so the loop can be verified without a human hand.
// node 24 has WebSocket built in — no dependency.
const RELAY = "wss://ghost-pointer-relay.mergodon.workers.dev";
const room = (process.argv[2] ?? "GHSTPT").toUpperCase();
const mode = process.argv[3] ?? "hold";      // hold <x> <y> | sweep
const hx = Number(process.argv[4] ?? 0.25), hy = Number(process.argv[5] ?? 0.25);

const ws = new WebSocket(`${RELAY}/r/${room}?role=point&name=node-test`);
ws.onopen = () => console.log(`connected to ${room} as point`);
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.k === "hello") console.log(`hello — peers: ${JSON.stringify(m.peers)}`);
  if (m.k === "join") console.log(`join: ${m.role} ${m.name}`);
};
ws.onerror = e => console.log("error", e.message ?? e);

let n = 0;
const t0 = Date.now();
setInterval(() => {
  if (ws.readyState !== 1) return;
  let x = hx, y = hy;
  if (mode === "sweep") {
    const a = (Date.now() - t0) / 1000;
    x = 0.5 + 0.35 * Math.cos(a * 1.6);
    y = 0.5 + 0.35 * Math.sin(a * 1.6);
  }
  ws.send(JSON.stringify({ k: "p", x: +x.toFixed(4), y: +y.toFixed(4), a: 1, t: Date.now() }));
  if (++n % 60 === 0) console.log(`sent ${n} samples, latest ${x.toFixed(3)},${y.toFixed(3)}`);
}, 1000 / 60);
