/**
 * Runnable check for the socket lifecycle in signaling.ts: connect -> join,
 * queued-frame flush, the 8s keepalive, server-frame dispatch, reconnect +
 * rejoin, superseded sockets, wake-on-network-event, and close().
 * (signaling.check.mjs covers only the scheduleReconnect backoff decisions.)
 *
 * Test doubles, all hand-rolled (no deps, same as the other harnesses):
 *   - FakeWebSocket (fake): a working in-memory socket that records every frame
 *     the client sends and lets the test drive open / message / close.
 *   - timers (stub): setTimeout/setInterval capture their callback + delay
 *     instead of scheduling, so the test fires them on demand.
 *   - window/document (spy): record which wake listeners are installed/removed.
 *
 * Run:  node src/lib/warp/signaling.socket.check.mjs   (from web/)
 */

import assert from "node:assert/strict";
import { importBundle } from "../../../scripts/importBundle.mjs";

// --- test doubles -----------------------------------------------------------
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    this.handlers = {};
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.handlers[type] ??= []).push(fn);
  }
  send(frame) {
    this.sent.push(JSON.parse(frame));
  }
  close() {
    this.closeCalls += 1;
  }
  // --- test controls ---
  fire(type, ev = {}) {
    for (const fn of this.handlers[type] ?? []) fn(ev);
  }
  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open");
  }
  serverSend(msg) {
    this.fire("message", { data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  serverDrop(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", { code, reason: "" });
  }
}
globalThis.WebSocket = FakeWebSocket;

let timers = [];
let nextTimer = 1;
const stubTimer = (kind) => (fn, delay) => {
  const t = { id: nextTimer++, kind, fn, delay, cleared: false };
  timers.push(t);
  return t.id;
};
const stubClear = (id) => {
  const t = timers.find((x) => x.id === id);
  if (t) t.cleared = true;
};
globalThis.setTimeout = stubTimer("timeout");
globalThis.setInterval = stubTimer("interval");
globalThis.clearTimeout = stubClear;
globalThis.clearInterval = stubClear;
const live = (kind) => timers.filter((t) => t.kind === kind && !t.cleared);

function spyTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
}
globalThis.window = spyTarget();
globalThis.document = Object.assign(spyTarget(), { visibilityState: "visible" });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });

// --- load the real module -----------------------------------------------------
let esbuild;
try {
  esbuild = await import("esbuild");
} catch (e) {
  console.error("SKIP: esbuild not available —", e.message);
  process.exit(0);
}
const path = await import("node:path");
const url = await import("node:url");
const here = path.dirname(url.fileURLToPath(import.meta.url));
const { SignalingClient } = await importBundle(esbuild, {
  entryPoints: [path.join(here, "signaling.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
});

function fresh() {
  FakeWebSocket.instances = [];
  timers = [];
  return new SignalingClient();
}
const lastSocket = () => FakeWebSocket.instances.at(-1);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok  : ${name}`);
}

// --- tests --------------------------------------------------------------------
test("creator joins with NO room so the server mints the code", () => {
  const c = fresh();
  c.connect();
  lastSocket().serverOpen();
  assert.deepEqual(lastSocket().sent[0], { type: "join" }, "no client-side room code");
});

test("frames sent while connecting are queued and flushed after the join", () => {
  const c = fresh();
  c.connect("ABC234");
  c.signal("peer-1", { kind: "ice", candidate: { candidate: "x" } });
  assert.equal(lastSocket().sent.length, 0, "nothing hits a CONNECTING socket");
  lastSocket().serverOpen();
  assert.deepEqual(
    lastSocket().sent.map((f) => f.type),
    ["join", "signal"],
    "join goes first, then the queued signal",
  );
  assert.equal(lastSocket().sent[0].room, "ABC234");
  assert.equal(lastSocket().sent[1].to, "peer-1");
});

test("keepalive pings every 8s and stops when the socket closes", () => {
  const c = fresh();
  c.connect();
  lastSocket().serverOpen();
  const [ka] = live("interval");
  assert.equal(ka.delay, 8000, "8s keeps the Durable Object from hibernating");
  ka.fn();
  assert.deepEqual(lastSocket().sent.at(-1), { type: "ping" });
  lastSocket().serverDrop();
  assert.equal(live("interval").length, 0, "keepalive interval cleared on close");
});

test("server frames are dispatched to listeners; garbage JSON is ignored", () => {
  const c = fresh();
  const seen = [];
  c.on("joined", (j) => seen.push(["joined", j]));
  c.on("peer-joined", (id) => seen.push(["peer-joined", id]));
  c.on("peer-left", (id) => seen.push(["peer-left", id]));
  c.on("signal", (s) => seen.push(["signal", s]));
  c.on("error", (e) => seen.push(["error", e]));
  c.connect();
  const ws = lastSocket();
  ws.serverOpen();
  ws.serverSend("{not json");
  ws.serverSend({ type: "joined", selfId: "me", room: "ROOM22" }); // peers omitted
  ws.serverSend({ type: "peer-joined", peerId: "p2" });
  ws.serverSend({ type: "signal", from: "p2", data: { kind: "answer", sdp: "s" } });
  ws.serverSend({ type: "peer-left", peerId: "p2" });
  ws.serverSend({ type: "error", error: "bad-room" });
  assert.deepEqual(seen, [
    ["joined", { selfId: "me", room: "ROOM22", peers: [] }],
    ["peer-joined", "p2"],
    ["signal", { from: "p2", data: { kind: "answer", sdp: "s" } }],
    ["peer-left", "p2"],
    ["error", "bad-room"],
  ]);
  assert.equal(c.room, "ROOM22");
  assert.equal(c.selfId, "me");
});

test("an unexpected drop reconnects and rejoins with the server-assigned room", () => {
  const c = fresh();
  const closes = [];
  c.on("close", (info) => closes.push(info));
  c.connect(); // creator: original join had no room
  lastSocket().serverOpen();
  lastSocket().serverSend({ type: "joined", selfId: "me", room: "SRV234", peers: [] });
  lastSocket().serverDrop(1006);
  assert.deepEqual(closes, [{ code: 1006, reason: "" }]);
  const [retry] = live("timeout");
  assert.equal(retry.delay, 500, "first backoff step");
  retry.fn();
  assert.equal(FakeWebSocket.instances.length, 2, "a new socket was opened");
  lastSocket().serverOpen();
  assert.deepEqual(lastSocket().sent[0], { type: "join", room: "SRV234" }, "rejoins the same room");
});

test("a late close from a superseded socket is ignored", () => {
  const c = fresh();
  c.connect();
  const oldWs = lastSocket();
  c.ws = null; // simulate wake() replacing the socket before the old one finished closing
  c.openSocket();
  const newWs = lastSocket();
  oldWs.serverDrop();
  assert.equal(c.ws, newWs, "the newer socket stays current");
  assert.equal(live("timeout").length, 0, "no reconnect scheduled for a stale socket");
});

test("an `online` event resets backoff and reconnects immediately", () => {
  const c = fresh();
  c.connect();
  lastSocket().serverDrop();
  c.reconnectAttempts = 4;
  const pendingRetry = live("timeout")[0];
  assert.ok(pendingRetry, "a backoff retry is pending");
  window.listeners.get("online")();
  assert.equal(pendingRetry.cleared, true, "the slow retry is cancelled");
  assert.equal(c.reconnectAttempts, 0, "backoff budget reset");
  assert.equal(FakeWebSocket.instances.length, 2, "reconnected without waiting");
});

test("close() closes the socket, removes wake listeners, and never reconnects", () => {
  const c = fresh();
  c.connect();
  lastSocket().serverOpen();
  const ws = lastSocket();
  assert.ok(window.listeners.has("online") && document.listeners.has("visibilitychange"));
  c.close();
  assert.equal(ws.closeCalls, 1);
  assert.equal(window.listeners.has("online"), false, "online listener removed");
  assert.equal(document.listeners.has("visibilitychange"), false, "visibility listener removed");
  assert.equal(live("interval").length, 0, "keepalive cleared");
  ws.serverDrop(); // the browser's close event after our close()
  assert.equal(live("timeout").length, 0, "an intentional close never schedules a reconnect");
  assert.equal(FakeWebSocket.instances.length, 1);
});

console.log(`signaling.socket.check: OK — ${passed} socket-lifecycle tests passed`);
