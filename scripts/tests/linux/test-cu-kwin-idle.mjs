// Regression test for the KDE Wayland Computer Use bridge session idle teardown in
// js/executor_linux.js (kwin-portal-bridge), issue #293 follow-up.
//
// Upstream can hold the CU lock across tasks (cloud Cowork releases it only after
// 12 min idle), and the lock was the only thing that ended the bridge session and
// cleared the stopped-by-user latch. So the desktop kept showing "screen is being
// shared" after a finished task, and after "Stop sharing" every later task in the
// same lock failed at once. The executor now ends the bridge session after
// CU_PORTAL_IDLE_MS (2 min) without a bridge input/capture command, and on a task
// boundary (__cuTaskBoundary, called from upstream's releaseRemoteCuLock IPC). The
// lock stays held; the next command starts a new session through the lazy start.
//
// Run headless: the bridge is a stub, timers are fake (setTimeout/clearTimeout are
// shadowed inside the loaded module only), no KDE needed.
import { readFileSync } from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = path.join(ROOT, "js", "executor_linux.js");
const IDLE_MS = 120000;
const NEW_MSG = "Screen sharing was stopped from the desktop (its screen-sharing indicator, or the desktop ended the session). Stop using Computer Use and ask the user whether to continue; do not retry. Computer Use can share the screen again once the task ends or after about 2 minutes without Computer Use actions.";
const STOPPED_STDERR = "screen sharing was stopped (the portal session was closed)";
const SCREENS = JSON.stringify([{ id: "DP-1", name: "DP-1", geometry: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1, is_primary: true }]);

let pass = 0, fail = 0, caseFailed = false;
const failedCases = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log("  ok   " + msg); }
  else { fail++; caseFailed = true; console.log("  FAIL " + msg + (extra !== undefined ? "  :: " + extra : "")); }
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

// One fresh module instance per case: module-level session state does not leak.
function load() {
  const kw = [];                    // bridge subcommands, in call order
  const argv = [];                  // full argument lists, in call order
  const gates = new Set();          // subcommands whose reply waits for release()
  const heldReplies = [];
  const gateAfter = {};             // sub -> number of calls to let through before gating
  const state = { stopped: false, noSession: false, startStopped: false };
  const diag = [];
  const clock = { now: 0, timers: [] };

  const fakeSetTimeout = (fn, ms) => {
    const t = { fn, at: clock.now + (Number(ms) || 0), cleared: false, fired: false, unrefed: false,
      unref() { this.unrefed = true; return this; }, ref() { this.unrefed = false; return this; } };
    clock.timers.push(t);
    return t;
  };
  const fakeClearTimeout = (t) => { if (t && typeof t === "object") t.cleared = true; };
  const live = () => clock.timers.filter(t => !t.cleared && !t.fired);

  const reply = (sub, cb) => {
    if (sub === "screens") { cb(null, { stdout: SCREENS, stderr: "" }); return; }
    if (sub === "session-end") { state.stopped = false; state.noSession = false; cb(null, { stdout: "", stderr: "" }); return; }
    if (sub === "session-start") {
      if (state.startStopped) { cb(Object.assign(new Error("Command failed"), { stderr: STOPPED_STDERR, code: 5 }), "", ""); return; }
      cb(null, { stdout: "", stderr: "" }); return;
    }
    if (sub === "set-overlay-display" && state.overlayFails) { state.overlayFails = false; cb(Object.assign(new Error("Command failed"), { stderr: "overlay failed", code: 1 }), "", ""); return; }
    if (state.stopped) { cb(Object.assign(new Error("Command failed"), { stderr: STOPPED_STDERR, code: 5 }), "", ""); return; }
    if (state.noSession) { state.noSession = false; cb(Object.assign(new Error("Command failed"), { stderr: "no active portal session", code: 4 }), "", ""); return; }
    cb(null, { stdout: "{}", stderr: "" });
  };
  const cpStub = {
    execFile(bin, args, opts, cb) {
      if (typeof opts === "function") cb = opts;
      const sub = (args || [])[0];
      kw.push(sub);
      argv.push((args || []).join(" "));
      if (gateAfter[sub] !== undefined && gateAfter[sub]-- === 0) { delete gateAfter[sub]; gates.add(sub); }
      if (gates.has(sub)) { heldReplies.push({ sub, run: () => reply(sub, cb) }); return; }
      setImmediate(() => reply(sub, cb));
    },
    spawnSync() { return { status: 0 }; }
  };

  const src = readFileSync(EXECUTOR, "utf8")
    .replace("import { execFile as execFileCb, spawnSync } from 'node:child_process'", "const { execFile: execFileCb, spawnSync } = __cp")
    .replace("import { screen as electronScreen } from 'electron'", "const electronScreen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) }")
    .replace("import { promisify } from 'node:util'", "const { promisify } = __util")
    .replace(/^export /gm, "");
  if (/^import /m.test(src)) throw new Error("executor_linux.js imports changed - update this splice");
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuKwinBridgeBin = "/res/kwin-portal-bridge";
  const mod = new Function("__cp", "__util", "setTimeout", "clearTimeout", src +
    "\nreturn { STOPPED_BY_USER_MESSAGE, createLinuxExecutor };")(cpStub, util, fakeSetTimeout, fakeClearTimeout);
  const ex = mod.createLinuxExecutor({ hostBundleId: "com.anthropic.claude" });

  async function advance(ms) {
    const target = clock.now + ms;
    for (;;) {
      const due = live().filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = due.at;
      due.fired = true;
      due.fn();
      await settle();
    }
    clock.now = target;
    await settle();
  }
  async function release(sub) {
    const i = heldReplies.findIndex(h => h.sub === sub);
    gates.delete(sub);
    if (i >= 0) heldReplies.splice(i, 1)[0].run();
    await settle();
  }
  const count = (c) => kw.filter(x => x === c).length;
  const fails = async (f) => { try { await f(); return "no error"; } catch (e) { return e.message; } };
  return { mod, ex, kw, argv, gates, gateAfter, state, diag, clock, live, advance, release, count, fails };
}

process.setMaxListeners(50);                         // one exit hook per loaded module
// The executor's debugLog (and its process-exit session-end hook) write to console.debug.
console.debug = () => {};

async function runCase(name, body) {
  console.log("\n" + name);
  caseFailed = false;
  try { await body(); }
  catch (e) { ok(false, "case threw", e && e.stack ? e.stack.split("\n").slice(0, 2).join(" | ") : String(e)); }
  if (caseFailed) failedCases.push(name);
}

await runCase("[1] idle end after 120 s with the session up; the lock is kept", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  ok(r.count("session-start") === 1, "the lock starts a session", r.kw.join(" "));
  ok(await r.fails(() => r.ex.key("a")) === "no error", "a key works");
  ok(r.live().some(t => t.at === r.clock.now + IDLE_MS && t.unrefed), "an unref'd 120 s idle timer is armed",
     JSON.stringify(r.live().map(t => ({ in: t.at - r.clock.now, unref: t.unrefed }))));
  await r.advance(IDLE_MS - 1000);
  ok(r.count("session-end") === 0, "no session-end before 120 s", r.kw.join(" "));
  await r.advance(2000);
  ok(r.count("session-end") === 1, "session-end after 120 s idle", r.kw.join(" "));
  ok(r.diag.some(l => l.includes("[linux-executor] idle for 120 s, ending the bridge session")), "the idle end is logged", r.diag.join(" / "));
  await r.advance(10 * IDLE_MS);
  ok(r.count("session-end") === 1 && r.count("session-start") === 1, "nothing more happens while idle", r.kw.join(" "));
});

await runCase("[2] activity re-arms the idle timer", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  await r.advance(100000);
  await r.ex.key("b");
  await r.advance(100000);
  ok(r.count("session-end") === 0, "no end 100 s after the last command (200 s after the first)", r.kw.join(" "));
  await r.advance(21000);
  ok(r.count("session-end") === 1, "ends 120 s after the last command", r.kw.join(" "));
});

await runCase("[3] the stop latch lifts after 120 s idle; refused commands do not re-arm", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  ok(await r.fails(() => r.ex.key("a")) === "no error", "a key works");
  r.state.stopped = true;                              // the user clicked "Stop sharing"
  let msg = await r.fails(() => r.ex.key("b"));
  ok(msg === NEW_MSG, "the model reads the new stop message", msg);
  ok(r.mod.STOPPED_BY_USER_MESSAGE === NEW_MSG, "STOPPED_BY_USER_MESSAGE is the new text");
  await r.advance(60000);
  const keys = r.count("key-sequence");
  msg = await r.fails(() => r.ex.key("c"));
  ok(msg === NEW_MSG && r.count("key-sequence") === keys, "a command 60 s later is refused without a bridge spawn", r.kw.join(" "));
  await r.advance(IDLE_MS - 60000 + 1000);
  ok(r.count("session-end") === 1, "session-end 120 s after the stop (the refused command did not re-arm)", r.kw.join(" "));
  ok(r.diag.some(l => l.includes("stopped-by-user latch cleared (idle)")), "the latch clear is logged", r.diag.join(" / "));
  msg = await r.fails(() => r.ex.key("d"));
  ok(msg === "no error" && r.count("session-start") === 2, "the next command starts a new session and works", `${msg} :: ${r.kw.join(" ")}`);
});

await runCase("[4] no idle end while a command or a session-start is in flight", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  r.gates.add("key-sequence");
  const p = r.ex.key("b");                            // stays in flight
  await settle();
  await r.advance(3 * IDLE_MS);
  ok(r.count("session-end") === 0, "no end while key-sequence is in flight", r.kw.join(" "));
  await r.release("key-sequence"); await p;
  await r.advance(IDLE_MS - 1000);
  ok(r.count("session-end") === 0, "the timer counts from the command's completion", r.kw.join(" "));
  await r.advance(2000);
  ok(r.count("session-end") === 1, "ends 120 s after the in-flight command finished", r.kw.join(" "));
  // An in-flight session-start: the daemon vanished (exit 4), the retry's start
  // waits on a consent dialog for longer than the idle timeout.
  const r2 = load();
  await r2.ex.__setLockHeld(true); await settle();
  r2.state.noSession = true;
  const msg = await r2.fails(() => r2.ex.key("a"));
  ok(/screen-sharing session was ended/.test(msg), "exit 4 drops the session", msg);
  r2.gates.add("session-start");
  const p2 = r2.ex.key("b");
  await settle();
  await r2.advance(IDLE_MS + 30000);
  ok(r2.count("session-end") === 0, "no end while session-start is in flight", r2.kw.join(" "));
  await r2.release("session-start"); await p2;
  ok(r2.count("session-end") === 0, "the start that outlived the idle timeout is not ended when it completes", r2.kw.join(" "));
  await r2.advance(IDLE_MS + 1000);
  ok(r2.count("session-end") === 1 && r2.count("session-start") === 2, "ends 120 s after the restarted session's command", r2.kw.join(" "));
});

await runCase("[5] no idle end while a mouse button or key is held", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.mouseDown();
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 0, "no end at the first expiry while left_mouse_down has no release", r.kw.join(" "));
  await r.ex.mouseUp();
  await r.advance(IDLE_MS - 1000);
  ok(r.count("session-end") === 0, "the timer counts from the release", r.kw.join(" "));
  await r.advance(2000);
  ok(r.count("session-end") === 1, "ends 120 s after left_mouse_up", r.kw.join(" "));
  const r2 = load();
  await r2.ex.__setLockHeld(true); await settle();
  r2.gates.add("hold-key");
  const p = r2.ex.holdKey(["shift"], 200000);         // hold_key for longer than the idle timeout
  await settle();
  await r2.advance(IDLE_MS + 60000);
  ok(r2.count("session-end") === 0, "no end during hold_key", r2.kw.join(" "));
  await r2.release("hold-key"); await p;
  await r2.advance(IDLE_MS + 1000);
  ok(r2.count("session-end") === 1, "ends 120 s after hold_key released", r2.kw.join(" "));
});

await runCase("[6] lock release cancels the idle timer; a new lock arms a fresh one", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  await r.advance(60000);
  await r.ex.__setLockHeld(false); await settle();
  ok(r.count("session-end") === 1, "the release ends the session", r.kw.join(" "));
  await r.advance(3 * IDLE_MS);
  ok(r.count("session-end") === 1, "no idle end after the release", r.kw.join(" "));
  await r.ex.__setLockHeld(true); await settle();
  ok(r.count("session-start") === 2, "the new lock starts a session", r.kw.join(" "));
  await r.advance(IDLE_MS - 1000);
  ok(r.count("session-end") === 1, "the new lock's session is not ended early", r.kw.join(" "));
  await r.advance(2000);
  ok(r.count("session-end") === 2, "the new lock's session ends 120 s after its last command", r.kw.join(" "));
});

await runCase("[7] the next command after an idle end restarts the session", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 1, "idle end", r.kw.join(" "));
  const msg = await r.fails(() => r.ex.key("b"));
  ok(msg === "no error", "the next key works", msg);
  ok(r.count("session-start") === 2 && r.kw.lastIndexOf("session-start") < r.kw.lastIndexOf("key-sequence"),
     "through a new session-start before the key", r.kw.join(" "));
  const shot = await r.fails(() => r.ex.mouseDown());
  ok(shot === "no error" && r.count("session-start") === 2, "later commands reuse it", r.kw.join(" "));
  await r.ex.mouseUp();
  // A command that arrives while the idle session-end is still running waits
  // for it: a session-start next to it would be taken down by that end.
  r.gates.add("session-end");
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 2, "second idle end in flight", r.kw.join(" "));
  const p = r.ex.key("c");
  await settle();
  ok(r.count("session-start") === 2, "no session-start while the session-end runs", r.kw.join(" "));
  await r.release("session-end");
  const msg2 = await r.fails(() => p);
  ok(msg2 === "no error" && r.count("session-start") === 3 && r.kw.lastIndexOf("session-end") < r.kw.lastIndexOf("session-start"),
     "the command starts its session after the end completes", `${msg2} :: ${r.kw.join(" ")}`);
});

await runCase("[8] __cuTaskBoundary: alias match acts, mismatch is ignored, undefined acts", async () => {
  const r = load();
  ok(typeof r.ex.__cuTaskBoundary === "function", "__cuTaskBoundary exists on the executor");
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  await r.ex.__cuTaskBoundary("session_ABC", "renderer", "cse_abc");
  ok(r.count("session-end") === 1, "session_ABC vs cse_abc: ends the session", r.kw.join(" "));
  ok(r.diag.some(l => l.includes("[linux-executor] task boundary (renderer): ending the bridge session")), "logged", r.diag.join(" / "));
  ok(r.live().length === 0, "no idle timer left behind", String(r.live().length));
  ok(await r.fails(() => r.ex.key("b")) === "no error" && r.count("session-start") === 2, "the next command restarts", r.kw.join(" "));
  await r.ex.__cuTaskBoundary("session_ABC", "renderer", "cse_xyz");
  ok(r.count("session-end") === 1, "a mismatched id is ignored", r.kw.join(" "));
  ok(r.diag.some(l => l.includes("task boundary (renderer)") && /ignor/i.test(l)), "the ignore is logged", r.diag.join(" / "));
  await r.ex.__cuTaskBoundary(undefined, "stop_click", "cse_abc");
  ok(r.count("session-end") === 2, "undefined id acts", r.kw.join(" "));
  await r.ex.key("c");
  await r.ex.__cuTaskBoundary("cse_ABC", "renderer", undefined);
  ok(r.count("session-end") === 3, "undefined holder acts", r.kw.join(" "));
  // The boundary also lifts the stop latch.
  await r.ex.key("d");
  r.state.stopped = true;
  ok(await r.fails(() => r.ex.key("e")) === NEW_MSG, "stop latched");
  await r.ex.__cuTaskBoundary("session_abc", "renderer", "session_ABC");
  ok(r.count("session-end") === 4 && r.diag.some(l => l.includes("stopped-by-user latch cleared")), "the boundary sends session-end and clears the latch", r.kw.join(" "));
  ok(await r.fails(() => r.ex.key("f")) === "no error", "and the next command works");
  // Safe without a session: nothing to end, no bridge spawn, no throw.
  const r2 = load();
  const before = r2.kw.length;
  ok(await r2.fails(() => r2.ex.__cuTaskBoundary(undefined, "renderer", undefined)) === "no error" && r2.kw.length === before,
     "no lock, no session: a no-op", r2.kw.join(" "));
});

await runCase("[9] the stop latch lifts on idle even with a mouse button held", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.mouseDown();
  r.state.stopped = true;
  ok(await r.fails(() => r.ex.key("x")) === NEW_MSG, "stop latched while the button is held");
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 1, "idle ends it 120 s after the stop (no mouse-up sent)", r.kw.join(" "));
  ok(await r.fails(() => r.ex.key("y")) === "no error", "the next command works");
  // Same, with the mouse-up refused by the latch before the bridge runs.
  const r2 = load();
  await r2.ex.__setLockHeld(true); await settle();
  await r2.ex.mouseDown();
  r2.state.stopped = true;
  ok(await r2.fails(() => r2.ex.key("x")) === NEW_MSG, "stop latched");
  const ups = r2.count("left-mouse-up");
  ok(await r2.fails(() => r2.ex.mouseUp()) === NEW_MSG && r2.count("left-mouse-up") === ups, "the mouse-up is refused without a bridge spawn");
  await r2.advance(IDLE_MS + 1000);
  ok(r2.count("session-end") === 1, "idle still ends it 120 s after the stop", r2.kw.join(" "));
});

await runCase("[10] a session-start that exits 5 arms the idle timer", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 1, "idle end");
  r.state.startStopped = true;                         // the new daemon is closed before it is ready
  ok(await r.fails(() => r.ex.key("b")) === NEW_MSG, "the lazy restart reports the stop");
  r.state.startStopped = false;
  ok(r.live().some(t => t.unrefed), "an idle timer is armed after the latch", String(r.live().length));
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 2 && r.diag.some(l => l.includes("stopped-by-user latch cleared (idle)")),
     "the latch lifts 120 s later with a session-end", r.kw.join(" "));
  ok(await r.fails(() => r.ex.key("c")) === "no error", "and the next command works", r.kw.join(" "));
  // On lock acquire too.
  const r2 = load();
  r2.state.startStopped = true;
  ok(await r2.fails(() => r2.ex.__setLockHeld(true)) === NEW_MSG, "lock acquire: session-start exits 5");
  r2.state.startStopped = false;
  await r2.advance(IDLE_MS + 1000);
  ok(r2.count("session-end") === 1, "lock acquire: the latch lifts 120 s later", r2.kw.join(" "));
});

await runCase("[11] exit-4 recovery forgets a held button", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.mouseDown();
  r.state.noSession = true;
  ok(/screen-sharing session was ended/.test(await r.fails(() => r.ex.key("x"))), "exit 4 drops the session");
  ok(await r.fails(() => r.ex.key("y")) === "no error", "the next command starts a new session");
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 1, "the new session ends at the first expiry (no stale held button)", r.kw.join(" "));
});

await runCase("[12] a held button defers the idle end once only", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.mouseDown();
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 0, "the first expiry defers", r.kw.join(" "));
  await r.advance(IDLE_MS);
  ok(r.count("session-end") === 1, "the second consecutive expiry ends anyway", r.kw.join(" "));
  ok(r.diag.some(l => l.includes("a mouse button has been held") && l.includes("ending the bridge session anyway")), "and logs it", r.diag.join(" / "));
  // A command between the expiries resets the deferral.
  const r2 = load();
  await r2.ex.__setLockHeld(true); await settle();
  await r2.ex.mouseDown();
  await r2.advance(IDLE_MS + 1000);
  await r2.ex.moveMouse(5, 5);
  await r2.advance(IDLE_MS + 1000);
  ok(r2.count("session-end") === 0, "a command in between gives the held button a fresh deferral", r2.kw.join(" "));
  await r2.advance(IDLE_MS);
  ok(r2.count("session-end") === 1, "then the second consecutive expiry ends it", r2.kw.join(" "));
});

await runCase("[13] the timer cannot fire between ensureBridgeSession and the command", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  await r.advance(IDLE_MS - 10);
  // executor.screenshot looks the display up (screens), then the backend runs
  // ensureBridgeSession, looks it up again (screens, untracked) and captures.
  // Hold that second lookup across the old deadline.
  r.gateAfter.screens = 1;
  const p = r.ex.screenshot({ displayId: 0 }); await settle();
  ok(r.count("screens") === 3 && r.kw.lastIndexOf("screenshot") < 0, "the backend's lookup is held", r.kw.join(" "));
  await r.advance(20);
  await r.release("screens");
  await r.fails(() => p);
  ok(r.count("session-end") === 0 && r.kw.lastIndexOf("screenshot") > 0, "no idle end while the screenshot was on its way", r.kw.join(" "));
});

await runCase("[14] lock release during an idle end, then a new lock", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  await r.ex.key("a");
  r.gates.add("session-end");
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 1, "idle end in flight", r.kw.join(" "));
  const rel = r.ex.__setLockHeld(false); await settle();
  ok(r.count("session-end") === 1, "the release joins it (no second session-end)", r.kw.join(" "));
  const acq = r.ex.__setLockHeld(true); await settle();
  ok(r.count("session-start") === 1, "the new lock waits for the end before starting", r.kw.join(" "));
  await r.release("session-end"); await rel; await acq; await settle();
  ok(r.count("session-start") === 2 && r.kw.lastIndexOf("session-end") < r.kw.lastIndexOf("session-start"),
     "then starts its session", r.kw.join(" "));
  ok(await r.fails(() => r.ex.key("z")) === "no error", "and commands work", r.kw.join(" "));
  await r.advance(IDLE_MS - 1000);
  ok(r.count("session-end") === 1, "the new lock's session is not ended early", r.kw.join(" "));
  await r.advance(2000);
  ok(r.count("session-end") === 2, "and ends 120 s after its last command", r.kw.join(" "));
  // Release without a new lock: the session stays ended, no timer is left.
  const r2 = load();
  await r2.ex.__setLockHeld(true); await settle();
  await r2.ex.key("a");
  r2.gates.add("session-end");
  await r2.advance(IDLE_MS + 1000);
  const rel2 = r2.ex.__setLockHeld(false); await settle();
  await r2.release("session-end"); await rel2; await settle();
  await r2.advance(3 * IDLE_MS);
  ok(r2.count("session-end") === 1 && r2.live().length === 0, "release only: one session-end, no timer left", r2.kw.join(" "));
  ok(/cuLock is not held/.test(await r2.fails(() => r2.ex.key("b"))), "and no session without the lock");
});

await runCase("[15] a restarted session gets the overlay display back", async () => {
  const r = load();
  const overlays = () => r.argv.filter(a => a === "set-overlay-display --display DP-1").length;
  await r.ex.__setLockHeld(true); await settle();
  ok(overlays() === 1, "the lock sets the overlay display", r.argv.join(" | "));
  await r.ex.key("a");
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 1, "idle end");
  ok(await r.fails(() => r.ex.key("b")) === "no error", "the next command works"); await settle();
  ok(overlays() === 2 && r.kw.lastIndexOf("session-start") < r.kw.lastIndexOf("set-overlay-display"),
     "the overlay display is re-applied after the idle restart", r.argv.join(" | "));
  await r.ex.key("c"); await settle();
  ok(overlays() === 2, "only once per restart", r.argv.join(" | "));
  await r.ex.__cuTaskBoundary(undefined, "renderer", undefined);
  r.state.overlayFails = true;                        // best effort: a failed re-apply never fails the command
  ok(await r.fails(() => r.ex.key("d")) === "no error", "the command after a boundary works even when the re-apply fails"); await settle();
  ok(r.argv.filter(a => a.startsWith("set-overlay-display")).length === 3, "the re-apply was attempted after the boundary restart", r.argv.join(" | "));
  // A lock acquire sets it itself: no second copy.
  await r.ex.__setLockHeld(false); await settle();
  await r.advance(1000);
  const before = r.argv.filter(a => a.startsWith("set-overlay-display")).length;
  await r.ex.__setLockHeld(true); await settle();
  ok(r.argv.filter(a => a.startsWith("set-overlay-display")).length === before + 1, "a new lock sends it once", r.argv.join(" | "));
});

await runCase("[16] no idle session-end after the daemon vanished (exit 4)", async () => {
  const r = load();
  await r.ex.__setLockHeld(true); await settle();
  r.state.noSession = true;
  ok(/screen-sharing session was ended/.test(await r.fails(() => r.ex.key("a"))), "exit 4 drops the session");
  await r.advance(3 * IDLE_MS);
  ok(r.count("session-end") === 0, "no session-end to a daemon that is gone", r.kw.join(" "));
  ok(await r.fails(() => r.ex.key("b")) === "no error" && r.count("session-start") === 2, "the next command starts a new session", r.kw.join(" "));
  await r.advance(IDLE_MS + 1000);
  ok(r.count("session-end") === 1, "which the idle timer ends as usual", r.kw.join(" "));
});

delete globalThis.__cuKwinBridgeBin;
console.log("\n" + (fail ? `${pass} passed, ${fail} FAILED (cases failed: ${failedCases.length}/16)` : `ALL ${pass} CHECKS PASSED (16 cases)`));
process.exit(fail ? 1 : 0);
