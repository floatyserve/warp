/**
 * Runnable check for the ICE-restart state machine and signal handling in
 * peer.ts (connectionstatechange -> scheduleRestart -> attemptRestart, plus
 * handleSignal offer/answer/ice). peer.check.mjs drives an always-"connected"
 * FakePC, so none of the drop/recovery paths ever ran there.
 *
 * Test doubles, all hand-rolled (no deps, same as the other harnesses):
 *   - MockPC (mock): an RTCPeerConnection whose connectionState the test sets;
 *     it records every call (restartIce, createOffer, setRemoteDescription, …)
 *     so the test can assert WHAT the peer did to the transport.
 *   - mock signaling: records every signal(to, data) the peer relays.
 *   - timers (stub): setTimeout captures callback + delay, fired on demand.
 *
 * Run:  node src/lib/warp/peer.restart.check.mjs   (from web/)
 */

import assert from "node:assert/strict";
import { importBundle } from "../../../scripts/importBundle.mjs";

// --- test doubles -----------------------------------------------------------
class MockPC extends EventTarget {
  static last = null;
  constructor() {
    super();
    this.connectionState = "new";
    this.calls = [];
    this.failIce = false;
    MockPC.last = this;
  }
  createDataChannel() {
    const ch = new EventTarget();
    ch.readyState = "connecting";
    ch.close = () => {};
    return ch;
  }
  restartIce() {
    this.calls.push("restartIce");
  }
  async createOffer() {
    this.calls.push("createOffer");
    return { type: "offer", sdp: "offer-sdp" };
  }
  async createAnswer() {
    this.calls.push("createAnswer");
    return { type: "answer", sdp: "answer-sdp" };
  }
  async setLocalDescription(d) {
    this.calls.push(`setLocal:${d.type}`);
  }
  async setRemoteDescription(d) {
    this.calls.push(`setRemote:${d.type}`);
  }
  async addIceCandidate() {
    this.calls.push("addIceCandidate");
    if (this.failIce) throw new Error("no remote description yet");
  }
  close() {}
  // --- test control ---
  goTo(state) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}
globalThis.RTCPeerConnection = MockPC;

function mockSignaling() {
  return {
    sent: [],
    signal(to, data) {
      this.sent.push({ to, data });
    },
  };
}

let timers = [];
globalThis.setTimeout = (fn, delay) => {
  const t = { fn, delay, cleared: false };
  timers.push(t);
  return t;
};
globalThis.clearTimeout = (t) => {
  if (t) t.cleared = true;
};
const pending = () => timers.filter((t) => !t.cleared);
const flush = () => new Promise((r) => setImmediate(r)); // let attemptRestart's awaits settle
async function fireNextTimer() {
  const t = pending()[0];
  assert.ok(t, "expected a pending timer");
  t.cleared = true;
  t.fn();
  await flush();
  return t;
}

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
const { WarpPeer } = await importBundle(esbuild, {
  entryPoints: [path.join(here, "peer.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
});

function makePeer(initiator) {
  timers = [];
  const sig = mockSignaling();
  const peer = new WarpPeer(sig, "remote", initiator);
  const events = [];
  for (const e of ["reconnecting", "recovered", "error"]) peer.on(e, (arg) => events.push(arg ? `${e}:${arg}` : e));
  return { peer, sig, pc: MockPC.last, events };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok  : ${name}`);
}

// --- tests --------------------------------------------------------------------
await test("initiator: a 'disconnected' drop waits the grace window, then restarts ICE with a fresh offer", async () => {
  const { sig, pc, events } = makePeer(true);
  pc.goTo("connected");
  pc.goTo("disconnected");
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, 3000, "transient drop gets a 3s self-heal window");
  assert.deepEqual(pc.calls, [], "nothing renegotiated during the grace window");
  await fireNextTimer();
  assert.deepEqual(pc.calls, ["restartIce", "createOffer", "setLocal:offer"]);
  assert.deepEqual(sig.sent, [{ to: "remote", data: { kind: "offer", sdp: "offer-sdp" } }]);
  assert.deepEqual(events, ["reconnecting"]);
  assert.equal(pending()[0].delay, 7000, "a re-check is scheduled");
});

await test("responder never offers on restart (no glare) — it waits for the initiator", async () => {
  const { sig, pc, events } = makePeer(false);
  pc.goTo("connected");
  pc.goTo("failed");
  assert.equal(pending()[0].delay, 0, "'failed' restarts immediately");
  await fireNextTimer();
  assert.deepEqual(events, ["reconnecting"]);
  assert.equal(pc.calls.includes("restartIce"), false, "responder must not restartIce");
  assert.deepEqual(sig.sent, [], "responder sends no offer");
});

await test("a peer that NEVER connected and then fails reports an honest nat-failed", async () => {
  const { pc, events } = makePeer(true);
  pc.goTo("failed");
  await fireNextTimer();
  assert.deepEqual(events, ["error:nat-failed"]);
  assert.deepEqual(pc.calls, [], "no restart for a real NAT block");
  assert.equal(pending().length, 0, "no further re-checks");
});

await test("after 3 failed restarts a once-connected peer gives up with 'disconnected'", async () => {
  const { pc, events } = makePeer(true);
  pc.goTo("connected");
  pc.goTo("failed");
  for (let i = 0; i < 4; i++) await fireNextTimer(); // 3 restarts + the final check
  assert.deepEqual(events, ["reconnecting", "reconnecting", "reconnecting", "error:disconnected"]);
  assert.equal(pc.calls.filter((c) => c === "restartIce").length, 3);
  assert.equal(pending().length, 0, "stops re-checking after giving up");
});

await test("coming back to 'connected' mid-restart emits recovered and resets the budget", async () => {
  const { peer, pc, events } = makePeer(true);
  pc.goTo("connected");
  pc.goTo("failed");
  await fireNextTimer(); // restart #1, re-check pending
  const recheck = pending()[0];
  pc.goTo("connected");
  assert.deepEqual(events, ["reconnecting", "recovered"]);
  assert.equal(recheck.cleared, true, "pending re-check cancelled");
  assert.equal(peer.restartAttempts, 0, "restart budget reset for the next drop");
});

await test("handleSignal: answers an offer, applies an answer, swallows an early ICE candidate, ignores strangers", async () => {
  const { peer, sig, pc } = makePeer(false);
  await peer.handleSignal("remote", { kind: "offer", sdp: "o" });
  assert.deepEqual(pc.calls, ["setRemote:offer", "createAnswer", "setLocal:answer"]);
  assert.deepEqual(sig.sent, [{ to: "remote", data: { kind: "answer", sdp: "answer-sdp" } }]);

  pc.calls = [];
  await peer.handleSignal("remote", { kind: "answer", sdp: "a" });
  assert.deepEqual(pc.calls, ["setRemote:answer"]);

  pc.calls = [];
  pc.failIce = true;
  await peer.handleSignal("remote", { kind: "ice", candidate: { candidate: "c" } }); // must not throw
  assert.deepEqual(pc.calls, ["addIceCandidate"]);

  pc.calls = [];
  await peer.handleSignal("someone-else", { kind: "offer", sdp: "x" });
  assert.deepEqual(pc.calls, [], "frames from another peer are ignored");
});

console.log(`peer.restart.check: OK — ${passed} ICE-restart / signal-handling tests passed`);
