#!/usr/bin/env node
// Main-view renderer recovery: a clean-exit nobody asked for (issue #287) and
// a renderer the unresponsive watchdog could not kill (issue #299) must both
// reach upstream's reload path.
//
// WHY THIS EXISTS
// ---------------
// Upstream's main-webview render-process-gone handler runs every death
// through a reason filter. Without a pending "we crashed it ourselves" token
// it drops `clean-exit` unconditionally; on Linux the main view's renderer
// can exit with reason clean-exit / exitCode 0 on its own, and the window then
// stays blank (#287). With a token it drops EVERY reason. The unresponsive
// watchdog adds a token each time it calls forcefullyCrashRenderer(), which on
// Linux is an IPC asking the renderer to crash itself - a no-op for a hung
// renderer. The view stays frozen, the tokens pile up, and when the renderer
// finally dies the real `killed` is dropped: no reload, no overlay (#299).
//
// patches/linux/fix_renderer_clean_exit_reload:
//   A. the filter's clean-exit term asks __cdbCleanExitRecoverable
//   B. the 300 ms `killed` grace also covers clean-exit
//   C. the token branch returns __cdbWatchdogKillRecoverable instead of false
//   D. __cdbHungKillEscalate(e) runs before e.forcefullyCrashRenderer(): it
//      SIGKILLs the renderer pid 5 s later unless the view recovered (a
//      liveness probe at the deadline that answers also counts as recovered)
// (all three helpers in js/renderer_clean_exit.js). Everything after the
// filter is upstream's own path.
//
// This harness runs the compiled patch against the v3.6556.2 shapes it targets
// (filter, quitting predicate, reload helper, the unresponsive watchdog and
// the whole handler, verbatim) and then drives the PATCHED code with a stubbed
// WebContents:
//
//   [1]  apply on pristine, idempotent 2nd run (positive [OK] lines), node --check
//   [2]  clean-exit, app idle            -> reload
//   [3]  clean-exit while quitting        -> suppressed
//   [4]  clean-exit, view destroyed in grace -> suppressed
//   [5]  4th clean-exit within 10 min     -> suppressed (upstream behavior)
//   [6]  no token: crashed / killed keep upstream's verdicts
//   [7]  token pending + killed / crashed -> reload; + quitting -> suppressed;
//        + clean-exit -> the #287 verdict; non-Linux -> suppressed (upstream)
//   [8]  token pending, repeated kills -> upstream's cap and error overlay
//   [9]  watchdog: SIGKILL only while unresponsive with an unchanged pid
//   [9b] ...and only when a 2 s liveness probe at the deadline gets no answer
//   [10] watchdog -> SIGKILL -> `killed` -> reload, end to end
//   [11] refusals: absorbed filter, missing anchors, foreign end-state -> exit 1
//   [12] fix_renderer_gone_suppressed_log composes, in both orders
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_BIN = join(repo, "patches", "linux", "fix_renderer_clean_exit_reload");
const LOG_PATCH_BIN = join(repo, "patches", "linux", "fix_renderer_gone_suppressed_log");

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${actual}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`);
    failures.push(label);
  }
}

// Upstream shapes, copied verbatim from the v3.6556.2 bundle
// (index.chunk-Dq5Ox9te.js). Nothing inside the pieces is invented: STUBS only
// stubs the helpers they call (logger, Sentry, telemetry, overlay, print-call
// guard) so they can run outside Electron, and INSTALL wraps them in the
// locals of the function that registers them (I6n).
const FILTER_BLOCK =
  "var z3n=0,B3n=[],V3n=1e4,H3n=2e3,U3n=300,W3n=3,G3n=3e5,K3n=[1e3,5e3,2e4];function q3n(){z3n++}function J3n(){return z3n<=0?!1:(z3n--,!0)}function Y3n(){let e=Date.now();return B3n=B3n.filter((t=>t>e)),B3n}function X3n(){Y3n().push(Date.now()+V3n)}function Z3n(){return Y3n().shift()!==void 0}function Q3n(e){return J3n()?((e.reason===\"killed\"||e.reason===\"crashed\")&&X3n(),!1):!(e.reason===\"clean-exit\"||e.reason===\"killed\"&&CN())}";
const QUIT_DECL = "var _N=!1,vN=!1,yN=!1;var CN=()=>_N||vN||yN";
const F6N =
  "function F6n(e){setImmediate((()=>{e.isDestroyed()||e.reload()}))}";
const WATCHDOG =
  "let l=async t=>{SB(e),q3n();let n=BN(e.getURL()),r=CB(e),i=M6n(),a=A6n(),o=T6n(),s=performance.now(),l=c();if(await BB(Q(\"desktop_main_view_unresponsive\",{surface:n,web_commit_hash:r,main_rss_bytes:process.memoryUsage().rss,...i,...a,...o,print_call:t}).then(zM)),e.isDestroyed())return;let u={surface:n,web_commit_hash:r,print_call:t,window_visible:i.window_visible,window_minimized:i.window_minimized,wait_ms:Math.round(performance.now()-s),...l?.responsive??N6n,electron_version:process.versions.electron};e.forcefullyCrashRenderer(),F6n(e),Q(\"desktop_main_view_hang_kill_wait\",u)},u=!1,d=async()=>{if(!e.isDestroyed()){P.info(\"Main webview's print() call is still in progress %d minutes after it began and a kill was skipped for it, will kill and reload\",E3n/6e4),u=!0;try{await l(\"deadline\")}finally{u=!1}}};e.on(\"unresponsive\",(async()=>{if(u)return;let t=N3n(e,n,(()=>void d()));if(t.skipKill){P.info(\"Main webview is unresponsive during a print() call (started %d ms ago), not killing%s\",t.printCallAgeMs,t.firstSkip?\"; logging desktop_main_view_unresponsive_kill_skipped\":\"\"),t.firstSkip&&Q(\"desktop_main_view_unresponsive_kill_skipped\",{surface:BN(e.getURL()),web_commit_hash:CB(e),print_call_age_ms:t.printCallAgeMs});return}P.info(\"Main webview is unresponsive, will kill and reload\"),await l(t.printCall)})),";
const HANDLER =
  "e.on(\"render-process-gone\",(async(t,n)=>{if(SB(e),!Q3n(n))return;let r=s(),c=CB(e),l=M6n(),u=ZNn();if(n.reason===\"killed\"&&(await new Promise((e=>setTimeout(e,U3n))),e.isDestroyed()||CN())||e.isDestroyed())return;P.info(\"Main webview render process gone: %o\",n);let d=Date.now();if(d-a>G3n&&(i=0),a=d,Oe(\"Main webview render process gone\",{level:\"error\",tags:{event:\"webview-render-process-gone\",reason:n.reason,accessibility_support:AN(l.accessibility_support_enabled)},extra:{exitCode:n.exitCode}}),await BB(Promise.all([Q(\"desktop_main_view_render_process_gone\",{surface:BN(e.getURL()),web_commit_hash:c,reason:n.reason,exit_code:n.exitCode,reload_attempt:i,main_rss_bytes:process.memoryUsage().rss,...l},{mainViewHeap:u}).then(zM),ke(H3n)])),s()&&(r=!0),!r&&i>=W3n){P.info(\"Render process gone reload cap reached; not reloading again\"),Mo($4n(n));return}r||i++;let f=i-1;if(n.reason!==\"launch-failed\"){F6n(e);return}let p=K3n[Math.min(f,K3n.length-1)];P.info(\"Renderer failed to launch; reloading in %ds\",p/1e3),o=setTimeout((()=>{o=void 0,e.isDestroyed()||e.reload()}),p)}))";

const STUBS =
  "var __log=[],__overlay=[],P={info:(...a)=>__log.push(a[0]),debug(){}},Oe=()=>{},BB=p=>p,Q=async()=>{},zM=()=>{},ke=()=>{},Mo=x=>__overlay.push(x),$4n=n=>({reason:n.reason}),BN=()=>\"\",AN=()=>\"\",SB=()=>{},CB=()=>null,M6n=()=>({}),A6n=()=>({}),T6n=()=>({}),N6n={},ZNn=()=>null,E3n=6e5,N3n=()=>({skipKill:!1,printCall:\"none\"});";
const INSTALL =
  "function install(e){let n=()=>!1,r=0,i=0,a=0,o,s=()=>{let e=o!==void 0;return clearTimeout(o),o=void 0,e},c=()=>void 0;" +
  WATCHDOG +
  HANDLER +
  "}";
const FIXTURE = ['"use strict";', STUBS, QUIT_DECL, FILTER_BLOCK, F6N, INSTALL, ""].join("\n");

const UPSTREAM_FILTER =
  'function Q3n(e){return J3n()?((e.reason==="killed"||e.reason==="crashed")&&X3n(),!1):!(e.reason==="clean-exit"||e.reason==="killed"&&CN())}';
const PATCHED_FILTER =
  'function Q3n(e){return J3n()?((e.reason==="killed"||e.reason==="crashed")&&X3n(),globalThis.__cdbWatchdogKillRecoverable(e,CN)):!(e.reason==="clean-exit"&&!globalThis.__cdbCleanExitRecoverable(e,CN)||e.reason==="killed"&&CN())}';
const UPSTREAM_GRACE =
  'if(n.reason==="killed"&&(await new Promise((e=>setTimeout(e,U3n))),e.isDestroyed()||CN())||e.isDestroyed())return;';
const PATCHED_GRACE =
  'if((n.reason==="killed"||n.reason==="clean-exit")&&(await new Promise((e=>setTimeout(e,U3n))),e.isDestroyed()||CN())||e.isDestroyed())return;';
const UPSTREAM_KILL = "e.forcefullyCrashRenderer(),F6n(e),";
const PATCHED_KILL = "globalThis.__cdbHungKillEscalate(e),e.forcefullyCrashRenderer(),F6n(e),";
const MARKER = "__cdb_clean_exit_reload_v2__";

function runPatch(bin, file) {
  const r = spawnSync(bin, [file], { encoding: "utf8" });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

// The helper's SIGKILL fallback waits 5 s, then gives a liveness probe 2 s.
// Timers of exactly those lengths run after ESCALATE_TEST_MS / PROBE_TEST_MS
// instead (and are recorded), so the watchdog cases do not take 7 s each;
// every other timer (the 300 ms grace) keeps its length.
const ESCALATE_MS = 5000;
const ESCALATE_TEST_MS = 60;
const PROBE_MS = 2000;
const PROBE_TEST_MS = 40;
// Long enough for arm -> deadline -> probe timeout -> kill.
const SETTLE = ESCALATE_TEST_MS + PROBE_TEST_MS + 60;

// Load the (patched) fixture into a fresh context and return knobs to drive it.
function load(src, { platform = "linux", killThrows = false } = {}) {
  const diag = [];
  const kills = [];
  const escalateDelays = [];
  const probeDelays = [];
  const sandbox = {
    setImmediate,
    setTimeout: (fn, ms, ...a) => {
      if (ms === ESCALATE_MS) {
        escalateDelays.push(ms);
        return setTimeout(fn, ESCALATE_TEST_MS, ...a);
      }
      if (ms === PROBE_MS) {
        probeDelays.push(ms);
        return setTimeout(fn, PROBE_TEST_MS, ...a);
      }
      return setTimeout(fn, ms, ...a);
    },
    clearTimeout,
    Date,
    Promise,
    Math,
    WeakSet,
    WeakMap,
    console,
    performance,
    process: {
      platform,
      versions: { electron: "44.9.3" },
      memoryUsage: () => ({ rss: 0 }),
      kill: (pid, sig) => {
        if (killThrows) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        kills.push([pid, sig]);
      },
    },
    __cdbDiag: (s) => diag.push(s),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    sandbox,
    diag,
    kills,
    escalateDelays,
    probeDelays,
    install: (wc) => vm.runInContext("install", sandbox)(wc),
    setQuitting: (v) => vm.runInContext(`vN=${v ? "!0" : "!1"}`, sandbox),
    addToken: () => vm.runInContext("q3n()", sandbox),
    tokens: () => vm.runInContext("z3n", sandbox),
    expectedDumps: () => vm.runInContext("B3n.length", sandbox),
    log: () => vm.runInContext("__log", sandbox),
    overlays: () => vm.runInContext("__overlay.length", sandbox),
  };
}

function makeWc({ pid = 4242 } = {}) {
  const handlers = {};
  const wc = {
    destroyed: false,
    crashed: false,
    pid,
    reloads: 0,
    crashRequests: 0,
    on(name, fn) {
      (handlers[name] ||= []).push(fn);
      return wc;
    },
    listeners: (name) => (handlers[name] || []).length,
    isDestroyed() {
      return wc.destroyed;
    },
    isCrashed() {
      return wc.crashed;
    },
    getOSProcessId() {
      if (wc.pidThrows) throw new Error("no process");
      return wc.pid;
    },
    forcefullyCrashRenderer() {
      wc.crashRequests++; /* Linux: an IPC the hung renderer never reads */
    },
    // Liveness probe target. "hang" (default): a hung renderer never answers;
    // "answer": resolves; "reject": rejects like a disposed frame.
    probeMode: "hang",
    probes: [],
    onProbe: null,
    mainFrame: {
      executeJavaScript(code, gesture) {
        wc.probes.push([code, gesture, "mainFrame"]);
        if (wc.onProbe) wc.onProbe();
        if (wc.probeMode === "answer") return Promise.resolve(1);
        if (wc.probeMode === "reject")
          return Promise.reject(new Error("Render frame was disposed before WebFrameMain could be accessed"));
        return new Promise(() => {});
      },
    },
    executeJavaScript(code, gesture) {
      wc.probes.push([code, gesture, "webContents"]);
      return wc.probeMode === "answer" ? Promise.resolve(1) : new Promise(() => {});
    },
    reload() {
      wc.reloads++;
    },
    getURL: () => "https://claude.ai/new",
  };
  const fire = async (name, ...args) => {
    for (const fn of handlers[name] || []) await fn(...args);
  };
  wc.emit = async (details) => {
    await fire("render-process-gone", {}, details);
    // F6n reloads on setImmediate; give it one macrotask.
    await new Promise((r) => setImmediate(r));
  };
  wc.unresponsive = async () => {
    await fire("unresponsive");
    await new Promise((r) => setImmediate(r));
  };
  wc.responsive = () => fire("responsive");
  return wc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = join(tmpdir(), `cdb-renderer-clean-exit-${process.pid}`);
const rendererLines = (ctx) => ctx.diag.filter((l) => l.startsWith("[cdb-renderer] "));

try {
  mkdirSync(scratch, { recursive: true });
  let patchMissing = false;
  try {
    accessSync(PATCH_BIN, constants.X_OK);
  } catch {
    patchMissing = true;
    console.log(
      "  SKIP patches/linux/fix_renderer_clean_exit_reload is not compiled " +
        "(run: make -C patches linux/fix_renderer_clean_exit_reload)"
    );
  }
  if (patchMissing) {
    console.log(`${pass} checks passed; everything SKIPPED`);
    process.exit(SKIP_EXIT);
  }

  console.log("\n[1] the compiled patch applies to the v3.6556.2 shapes, idempotently");
  const pristineFile = join(scratch, "index-pristine.js");
  writeFileSync(pristineFile, FIXTURE);
  let pristineOk = true;
  try {
    execFileSync("node", ["--check", pristineFile], { stdio: "pipe" });
  } catch {
    pristineOk = false;
  }
  check("verbatim upstream fixture passes node --check", pristineOk, true);
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(PATCH_BIN, file);
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  check("no 'already' line on pristine input", /already/i.test(r1.out), false);
  check("A applied", r1.out.includes("[OK] A: clean-exit term of Q3n now consults __cdbCleanExitRecoverable (quitting=CN)"), true);
  check("B applied", r1.out.includes("[OK] B: 300 ms grace now covers clean-exit (details=n quitting=CN)"), true);
  check("C applied", r1.out.includes("[OK] C: token branch of Q3n now returns __cdbWatchdogKillRecoverable (quitting=CN)"), true);
  check("D applied", r1.out.includes("[OK] D: SIGKILL fallback armed before e.forcefullyCrashRenderer() (reload=F6n)"), true);
  check("4/4 reported", r1.out.includes("4/4 patches applied"), true);
  const patched = readFileSync(file, "utf8");
  check("filter rewritten (A + C, X3n kept)", patched.includes(PATCHED_FILTER), true);
  check("upstream filter gone", patched.includes(UPSTREAM_FILTER), false);
  check("grace widened", patched.includes(PATCHED_GRACE), true);
  check("upstream grace gone", patched.includes(UPSTREAM_GRACE), false);
  check("watchdog escalates before forcefullyCrashRenderer", patched.includes(PATCHED_KILL), true);
  check("forcefullyCrashRenderer still called once", patched.split(".forcefullyCrashRenderer(").length - 1, 1);
  check("helper inlined right in front of the filter", patched.includes("})();" + PATCHED_FILTER), true);
  check("marker injected once", patched.split(MARKER).length - 1, 1);
  check("v1 marker absent", patched.includes("__cdb_clean_exit_reload_v1__"), false);
  check("handler head untouched", patched.includes("(async(t,n)=>{if(SB(e),!Q3n(n))return;"), true);
  let syntaxOk = true;
  try {
    execFileSync("node", ["--check", file], { stdio: "pipe" });
  } catch {
    syntaxOk = false;
  }
  check("patched fixture passes node --check", syntaxOk, true);
  const r2 = runPatch(PATCH_BIN, file);
  check("second run exits 0", r2.status, 0);
  check("second run reports A already applied", r2.out.includes("[OK] A: clean-exit term already consults __cdbCleanExitRecoverable (" + MARKER + ")"), true);
  check("second run reports B already applied", r2.out.includes("[OK] B: 300 ms grace already covers clean-exit"), true);
  check("second run reports C already applied", r2.out.includes("[OK] C: token branch already returns __cdbWatchdogKillRecoverable (" + MARKER + ")"), true);
  check("second run reports D already applied", r2.out.includes("[OK] D: SIGKILL fallback already armed before forcefullyCrashRenderer (" + MARKER + ")"), true);
  check("second run leaves the file byte-identical", readFileSync(file, "utf8") === patched, true);

  console.log("\n[2] clean-exit while the app is idle -> the main view reloads");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("reload() called once", wc.reloads, 1);
    check("upstream's own log line follows", ctx.log().includes("Main webview render process gone: %o"), true);
    check("one [cdb-renderer] decision line", rendererLines(ctx).length, 1);
    check("...saying it was handed on", ctx.diag[0].includes("handing it to the reload path (1/3"), true);
  }

  console.log("\n[3] clean-exit while the app quits -> suppressed, as before");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.setQuitting(true);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("no reload", wc.reloads, 0);
    check("no upstream log line", ctx.log().includes("Main webview render process gone: %o"), false);
    check("decision logged as quitting", ctx.diag.some((l) => l.includes("app is quitting, leaving it suppressed")), true);
  }
  {
    // before-quit landing a moment after the renderer exit: the grace catches it.
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    const p = wc.emit({ reason: "clean-exit", exitCode: 0 });
    await sleep(50);
    ctx.setQuitting(true);
    await p;
    check("quit within the 300 ms grace: no reload", wc.reloads, 0);
  }

  console.log("\n[4] clean-exit of a view that is destroyed within the grace -> suppressed");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    const p = wc.emit({ reason: "clean-exit", exitCode: 0 });
    await sleep(50);
    wc.destroyed = true;
    await p;
    check("no reload", wc.reloads, 0);
    check("no upstream log line", ctx.log().includes("Main webview render process gone: %o"), false);
  }

  console.log("\n[5] a clean-exit loop falls back to upstream behavior after 3 reloads in 10 min");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    for (let k = 0; k < 3; k++) await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("three reloads handed on", wc.reloads, 3);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("4th within the window: still three", wc.reloads, 3);
    check("...and logged as capped", ctx.diag.some((l) => l.includes("3 reloads in the last 10 min, leaving it suppressed")), true);
    // Age our window out: timestamps older than 10 min are forgotten and the
    // next clean-exit is handed on again. Upstream's own cap (3 reloads per 5
    // minutes since the last event) then still holds in this run - the second
    // layer that bounds a loop even if ours let everything through.
    const arr = ctx.sandbox.__cdbCleanExitReloads;
    for (let k = 0; k < arr.length; k++) arr[k] -= 11 * 60 * 1000;
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check(
      "after our window passed: handed on again (1/3)",
      ctx.diag[ctx.diag.length - 1].includes("handing it to the reload path (1/3"),
      true
    );
    check("...and upstream's own 5-minute cap takes over", ctx.log().includes("Render process gone reload cap reached; not reloading again"), true);
    check("...so still three reloads", wc.reloads, 3);
  }
  {
    const ctx = load(patched, { platform: "darwin" });
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("non-Linux platform keeps upstream's verdict (no reload)", wc.reloads, 0);
  }

  console.log("\n[6] no token pending: other reasons keep upstream's verdicts");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "crashed", exitCode: 132 });
    check("crashed -> reload (unchanged)", wc.reloads, 1);
    check("no [cdb-renderer] line for crashed", ctx.diag.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.setQuitting(true);
    await wc.emit({ reason: "killed", exitCode: 15 });
    check("killed while quitting -> suppressed (unchanged)", wc.reloads, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "killed", exitCode: 9 });
    check("killed while idle -> reload (unchanged)", wc.reloads, 1);
    check("no [cdb-renderer] line for an untokened kill", ctx.diag.length, 0);
  }

  console.log("\n[7] a watchdog token pending (the Linux no-op kill) no longer swallows the death");
  for (const reason of ["killed", "crashed"]) {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.addToken();
    await wc.emit({ reason, exitCode: reason === "killed" ? 9 : 11 });
    check(`token + ${reason} -> reload`, wc.reloads, 1);
    check(`token + ${reason}: token consumed`, ctx.tokens(), 0);
    check(`token + ${reason}: X3n still notes the expected crash dump`, ctx.expectedDumps(), 1);
    check(`token + ${reason}: upstream's own log line follows`, ctx.log().includes("Main webview render process gone: %o"), true);
    check(
      `token + ${reason}: one [cdb-renderer] line`,
      rendererLines(ctx).length === 1 && rendererLines(ctx)[0].includes(`main view ${reason} (exitCode`) &&
        rendererLines(ctx)[0].includes("handing it to upstream's reload path"),
      true
    );
  }
  {
    // The `killed` still gets upstream's 300 ms grace: a view torn down in it stays dropped.
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.addToken();
    const p = wc.emit({ reason: "killed", exitCode: 9 });
    await sleep(50);
    wc.destroyed = true;
    await p;
    check("token + killed, view destroyed in the grace -> no reload", wc.reloads, 0);
  }
  for (const reason of ["killed", "crashed"]) {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.addToken();
    ctx.setQuitting(true);
    await wc.emit({ reason, exitCode: 9 });
    check(`token + ${reason} while quitting -> suppressed`, wc.reloads, 0);
    check(`...logged as quitting`, ctx.diag.some((l) => l.includes("app is quitting, leaving it suppressed")), true);
    check(`...token consumed all the same`, ctx.tokens(), 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.addToken();
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("token + clean-exit -> the #287 verdict (reload)", wc.reloads, 1);
    check("...through the clean-exit helper and its cap", ctx.diag.some((l) => l.includes("handing it to the reload path (1/3")), true);
    check("...no crash dump noted for a clean-exit", ctx.expectedDumps(), 0);
  }
  {
    const ctx = load(patched, { platform: "darwin" });
    const wc = makeWc();
    ctx.install(wc);
    ctx.addToken();
    await wc.emit({ reason: "crashed", exitCode: 11 });
    check("non-Linux: token + crashed -> suppressed by the latch (upstream)", wc.reloads, 0);
    check("non-Linux: no [cdb-renderer] line", ctx.diag.length, 0);
  }

  console.log("\n[8] stale tokens + repeated kills -> upstream's reload cap and error overlay");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    for (let k = 0; k < 4; k++) ctx.addToken();
    for (let k = 0; k < 4; k++) await wc.emit({ reason: "killed", exitCode: 9 });
    check("three reloads", wc.reloads, 3);
    check("4th: upstream's cap line", ctx.log().includes("Render process gone reload cap reached; not reloading again"), true);
    check("4th: upstream's error overlay shown once", ctx.overlays(), 1);
    check("all four tokens consumed", ctx.tokens(), 0);
    check("no rate limit of ours: four hand-on lines", rendererLines(ctx).filter((l) => l.includes("handing it to upstream's reload path")).length, 4);
  }

  console.log("\n[9] watchdog: SIGKILL fallback only while the renderer stays hung");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 5151 });
    ctx.install(wc);
    await wc.unresponsive();
    check("upstream asked forcefullyCrashRenderer()", wc.crashRequests, 1);
    check("token added by upstream", ctx.tokens(), 1);
    check("armed with a 5 s delay", ctx.escalateDelays.join(","), "5000");
    check("arm logged", ctx.diag.some((l) => l.includes("renderer 5151 hung, forcefullyCrashRenderer() requested; SIGKILL in 5 s")), true);
    check("one responsive listener", wc.listeners("responsive"), 1);
    await wc.unresponsive();
    await wc.unresponsive();
    check("repeated unresponsive: still one responsive listener", wc.listeners("responsive"), 1);
    check("repeated unresponsive: first deadline kept (one timer)", ctx.escalateDelays.length, 1);
    check("not killed before the deadline", ctx.kills.length, 0);
    await sleep(SETTLE);
    check("killed once after the deadline", ctx.kills.length, 1);
    check("...with SIGKILL to the recorded pid", JSON.stringify(ctx.kills[0]), JSON.stringify([5151, "SIGKILL"]));
    check("one liveness probe, main frame, evaluating 1, no user gesture", JSON.stringify(wc.probes), JSON.stringify([["1", false, "mainFrame"]]));
    check("probe raced against a 2 s timeout", ctx.probeDelays.join(","), "2000");
    check(
      "escalation logged",
      ctx.diag.some((l) =>
        l.includes("renderer 5151 still hung after forcefullyCrashRenderer() (5 s, then liveness probe: no answer in 2 s), escalating to SIGKILL")
      ),
      true
    );
    check("three tokens left by the three attempts", ctx.tokens(), 3);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    await wc.responsive();
    await sleep(SETTLE);
    check("responsive in time -> no kill", ctx.kills.length, 0);
    check("cancel logged", ctx.diag.some((l) => l.includes("is responsive again, SIGKILL fallback cancelled")), true);
    // A later hang arms again.
    await wc.unresponsive();
    await sleep(SETTLE);
    check("a later hang arms and kills again", ctx.kills.length, 1);
    check("...still one responsive listener", wc.listeners("responsive"), 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    wc.destroyed = true;
    await sleep(SETTLE);
    check("destroyed before the deadline -> no kill", ctx.kills.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    wc.crashed = true;
    await sleep(SETTLE);
    check("crashed before the deadline -> no kill", ctx.kills.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 100 });
    ctx.install(wc);
    await wc.unresponsive();
    wc.pid = 101;
    await sleep(SETTLE);
    check("pid changed before the deadline -> no kill", ctx.kills.length, 0);
    check("...logged", ctx.diag.some((l) => l.includes("renderer changed (100 -> 101)")), true);
  }
  {
    // The user (or the OOM killer) kills the hung renderer first; the reloaded
    // renderer reports responsive and cancels the pending fallback.
    const ctx = load(patched);
    const wc = makeWc({ pid: 200 });
    ctx.install(wc);
    await wc.unresponsive();
    wc.pid = 201;
    await wc.responsive();
    await sleep(SETTLE);
    check("new renderer responsive -> no kill", ctx.kills.length, 0);
    check("...logged with the pid change", ctx.diag.some((l) => l.includes("responsive on a new renderer (200 -> 201), SIGKILL fallback cancelled")), true);
  }
  {
    // Seen live: Electron emits `responsive` as the killed renderer goes away,
    // before a new one exists (getOSProcessId() is 0 then).
    const ctx = load(patched);
    const wc = makeWc({ pid: 300 });
    ctx.install(wc);
    await wc.unresponsive();
    wc.pid = 0;
    await wc.responsive();
    await sleep(SETTLE);
    check("renderer gone, responsive -> no kill", ctx.kills.length, 0);
    check("...logged as gone", ctx.diag.some((l) => l.includes("renderer 300 is gone (hang monitor reset), SIGKILL fallback cancelled")), true);
  }
  {
    const ctx = load(patched, { platform: "darwin" });
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("non-Linux: upstream still asks forcefullyCrashRenderer()", wc.crashRequests, 1);
    check("non-Linux: not armed, no kill", ctx.kills.length + ctx.escalateDelays.length, 0);
    check("non-Linux: no responsive listener of ours", wc.listeners("responsive"), 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc();
    wc.pidThrows = true;
    ctx.install(wc);
    let threw = false;
    try {
      await wc.unresponsive();
    } catch {
      threw = true;
    }
    check("getOSProcessId throwing never breaks the watchdog", threw, false);
    check("...forcefullyCrashRenderer still requested", wc.crashRequests, 1);
    check("...logged as not armed", ctx.diag.some((l) => l.includes("SIGKILL fallback not armed")), true);
  }
  {
    const ctx = load(patched, { killThrows: true });
    const wc = makeWc();
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("process.kill throwing is caught and logged", ctx.diag.some((l) => l.includes("SIGKILL fallback failed: kill ESRCH")), true);
  }

  console.log("\n[9b] watchdog: the liveness probe decides at the deadline");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 610 });
    wc.probeMode = "answer";
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("probe answers -> no kill", ctx.kills.length, 0);
    check("...one probe", wc.probes.length, 1);
    check("...cancel logged", ctx.diag.some((l) => l.includes("renderer 610 answered a liveness probe 5 s after forcefullyCrashRenderer(), SIGKILL cancelled")), true);
    // The slot is free again: a later hang arms and probes anew.
    wc.probeMode = "hang";
    await wc.unresponsive();
    await sleep(SETTLE);
    check("...a later real hang still gets killed", ctx.kills.length, 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 620 });
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(ESCALATE_TEST_MS + 10);
    check("probe in flight: not killed yet", ctx.kills.length, 0);
    check("probe in flight: one probe", wc.probes.length, 1);
    await wc.unresponsive();
    check("probe in flight: another unresponsive arms nothing", ctx.escalateDelays.length, 1);
    await sleep(SETTLE);
    check("probe times out -> kill", JSON.stringify(ctx.kills), JSON.stringify([[620, "SIGKILL"]]));
    check("...still one probe in total", wc.probes.length, 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 630 });
    wc.probeMode = "reject";
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("probe rejects -> kill", JSON.stringify(ctx.kills), JSON.stringify([[630, "SIGKILL"]]));
    check("...reason logged", ctx.diag.some((l) => l.includes("liveness probe: probe rejected: Render frame was disposed")), true);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 640 });
    wc.onProbe = () => {
      wc.pid = 641;
    };
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("pid changes during the probe -> no kill", ctx.kills.length, 0);
    check("...logged", ctx.diag.some((l) => l.includes("renderer changed (640 -> 641), SIGKILL fallback skipped")), true);
  }
  for (const [label, act] of [
    ["crashed", (wc) => (wc.crashed = true)],
    ["destroyed", (wc) => (wc.destroyed = true)],
  ]) {
    const ctx = load(patched);
    const wc = makeWc();
    wc.onProbe = () => act(wc);
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check(`${label} during the probe -> no kill`, ctx.kills.length, 0);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 650 });
    let fired = null;
    wc.onProbe = () => {
      fired = wc.responsive();
    };
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    await fired;
    check("responsive during the probe -> no kill", ctx.kills.length, 0);
    check("...one cancel line", ctx.diag.filter((l) => l.includes("SIGKILL fallback cancelled")).length, 1);
  }
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 660 });
    wc.mainFrame = null;
    wc.probeMode = "answer";
    ctx.install(wc);
    await wc.unresponsive();
    await sleep(SETTLE);
    check("no mainFrame: falls back to webContents.executeJavaScript", JSON.stringify(wc.probes), JSON.stringify([["1", false, "webContents"]]));
    check("...and its answer cancels", ctx.kills.length, 0);
  }

  console.log("\n[10] end to end: hang -> watchdog -> SIGKILL -> `killed` -> reload");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 7000 });
    ctx.install(wc);
    for (let k = 0; k < 4; k++) await wc.unresponsive(); // the 4 attempts seen in the repro
    const afterWatchdog = wc.reloads; // F6n after each no-op crash request
    await sleep(SETTLE);
    check("one SIGKILL", ctx.kills.length, 1);
    // Electron reports the SIGKILLed renderer:
    wc.crashed = true;
    await wc.emit({ reason: "killed", exitCode: 9 });
    check("the `killed` is not suppressed: one more reload", wc.reloads - afterWatchdog, 1);
    check("upstream logged the death", ctx.log().includes("Main webview render process gone: %o"), true);
    check("no suppression", ctx.log().some((l) => String(l).includes("(suppressed)")), false);
  }

  console.log("\n[11] refusals: exit 1, file untouched");
  const refusal = (label, src, needle) => {
    const f = join(scratch, `index-${label.replace(/\W+/g, "-")}.js`);
    writeFileSync(f, src);
    const r = runPatch(PATCH_BIN, f);
    check(`${label}: exit 1`, r.status, 1);
    if (needle) check(`${label}: names the problem`, r.out.includes(needle), true);
    check(`${label}: file untouched`, readFileSync(f, "utf8") === src, true);
  };
  // D counts `.forcefullyCrashRenderer(` after the helper is inlined, so the helper must never carry it.
  check(
    "helper js/renderer_clean_exit.js never contains the literal `.forcefullyCrashRenderer(`",
    readFileSync(join(repo, "js", "renderer_clean_exit.js"), "utf8").includes(".forcefullyCrashRenderer("),
    false
  );
  refusal(
    "upstream already reloads after clean-exit (absorbed)",
    FIXTURE.replace('!(e.reason==="clean-exit"||e.reason==="killed"&&CN())}', '!(e.reason==="killed"&&CN())}'),
    "re-audit which sub-patch is absorbed and drop it (Rule 4)"
  );
  refusal(
    "token branch no longer returns !1",
    FIXTURE.replace("&&X3n(),!1):", "&&X3n(),!0):"),
    "[FAIL] A/C: reason filter"
  );
  refusal(
    "watchdog pair missing",
    FIXTURE.replace(UPSTREAM_KILL, "e.forcefullyCrashRenderer(),"),
    "[FAIL] D: the watchdog's"
  );
  refusal(
    "watchdog pair duplicated",
    FIXTURE.replace(UPSTREAM_KILL, UPSTREAM_KILL + UPSTREAM_KILL),
    "[FAIL] D: the watchdog's"
  );
  refusal("grace missing", FIXTURE.replace(UPSTREAM_GRACE, "if(e.isDestroyed())return;"), "[FAIL] B:");
  refusal(
    "patched calls present but the v2 helper missing (no false [OK])",
    patched.replace(MARKER, "__cdb_clean_exit_reload_v1__"),
    "[FAIL] A/C"
  );
  refusal(
    "applied, plus a stray __cdbHungKillEscalate call elsewhere (no false [OK])",
    patched.replace(PATCHED_FILTER, "globalThis.__cdbHungKillEscalate(x);" + PATCHED_FILTER),
    "[FAIL] D: 1 __cdbHungKillEscalate call(s) in front of the watchdog pair, 2 in total"
  );
  refusal(
    "filter patched but the watchdog call missing (no false [OK])",
    patched.replace(PATCHED_KILL, UPSTREAM_KILL).replace(UPSTREAM_KILL, "e.forcefullyCrashRenderer(),"),
    "[FAIL] D:"
  );

  console.log("\n[12] fix_renderer_gone_suppressed_log composes with this patch, in both orders");
  let logMissing = false;
  try {
    accessSync(LOG_PATCH_BIN, constants.X_OK);
  } catch {
    logMissing = true;
    console.log("  SKIP patches/linux/fix_renderer_gone_suppressed_log is not compiled");
  }
  if (!logMissing) {
    // Basename order (what scripts/apply_patches.py runs): ours, then the log patch.
    const r = runPatch(LOG_PATCH_BIN, file);
    check("suppressed-log patch applies after ours", r.status, 0);
    check("...with its one match", r.out.includes("[OK] suppressed renderer-gone log: 1 match"), true);
    const both = readFileSync(file, "utf8");
    check("our grace survives its rewrite", both.includes('if((n.reason==="killed"||n.reason==="clean-exit")&&(await new Promise('), true);
    check("our filter survives its rewrite", both.includes(PATCHED_FILTER), true);
    check("our watchdog call survives its rewrite", both.includes(PATCHED_KILL), true);
    const r3 = runPatch(PATCH_BIN, file);
    check("ours is still idempotent on the combined output", r3.status, 0);
    check("combined output byte-identical after our re-run", readFileSync(file, "utf8") === both, true);
    // Reverse order: the log patch first, then ours.
    const rev = join(scratch, "index-reverse.js");
    writeFileSync(rev, FIXTURE);
    check("reverse order: log patch first", runPatch(LOG_PATCH_BIN, rev).status, 0);
    const rr = runPatch(PATCH_BIN, rev);
    check("reverse order: ours applies 4/4", rr.status === 0 && rr.out.includes("4/4 patches applied"), true);
    check("reverse order: byte-identical to basename order", readFileSync(rev, "utf8") === both, true);
    let bothOk = true;
    try {
      execFileSync("node", ["--check", file], { stdio: "pipe" });
    } catch {
      bothOk = false;
    }
    check("combined output passes node --check", bothOk, true);
    {
      const ctx = load(both);
      const wc = makeWc();
      ctx.install(wc);
      await wc.emit({ reason: "clean-exit", exitCode: 0 });
      check("combined: clean-exit while idle still reloads", wc.reloads, 1);
      ctx.setQuitting(true);
      await wc.emit({ reason: "clean-exit", exitCode: 0 });
      check("combined: clean-exit while quitting is logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), true);
      check("combined: ...and not reloaded", wc.reloads, 1);
    }
    {
      const ctx = load(both);
      const wc = makeWc({ pid: 9000 });
      ctx.install(wc);
      await wc.unresponsive();
      const base = wc.reloads;
      await sleep(SETTLE);
      check("combined: watchdog escalates to SIGKILL", ctx.kills.length, 1);
      wc.crashed = true;
      await wc.emit({ reason: "killed", exitCode: 9 });
      check("combined: the `killed` with a token pending reloads", wc.reloads - base, 1);
      check("combined: ...and is not logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), false);
      ctx.addToken();
      ctx.setQuitting(true);
      await wc.emit({ reason: "killed", exitCode: 9 });
      check("combined: token + killed while quitting is logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), true);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
