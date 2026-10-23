#!/usr/bin/env node
// A main-view renderer clean-exit the app did not ask for must reach the
// reload path (issue #287).
//
// WHY THIS EXISTS
// ---------------
// Upstream's main-webview render-process-gone handler runs every death
// through a reason filter that drops `clean-exit` unconditionally. On Linux
// the main view's renderer can exit with reason clean-exit / exitCode 0 on its
// own (niri Wayland, 10-16 Code sessions open, every day or two); the window
// then stays blank, Ctrl+R and F5 have no renderer left to receive them, and
// only a full restart - ending every Code session - recovers. A real crash
// (`crashed`) takes the reload path and recovers on its own.
//
// patches/linux/fix_renderer_clean_exit_reload makes the filter ask
// js/renderer_clean_exit.js about a clean-exit (sub-patch A) and widens the
// 300 ms `killed` grace - "is the view destroyed or the app quitting by now?" -
// to clean-exit (sub-patch B). Everything after that is upstream's own path.
//
// This harness runs the compiled patch against the v3.1623.0 shapes it targets
// (filter, quitting predicate, reload helper and the whole handler, verbatim)
// and then drives the PATCHED handler with a stubbed WebContents:
//
//   [1] apply on pristine, idempotent 2nd run, node --check
//   [2] clean-exit, app idle            -> reload
//   [3] clean-exit while quitting        -> suppressed
//   [4] clean-exit, view destroyed in grace -> suppressed
//   [5] 4th clean-exit within 10 min     -> suppressed (upstream behavior)
//   [6] crashed / killed keep upstream's verdicts
//   [7] a filter that already reloads clean-exit is refused (absorbed, Rule 4)
//   [8] fix_renderer_gone_suppressed_log still applies after this patch
//       (both patches rewrite the same handler; they must compose)
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

// Upstream shapes, copied verbatim from the v3.1623.0 bundle
// (index.chunk-6Ku8p4x3.js). Nothing between the pieces is invented: the
// first line only stubs the helpers the handler calls (logger, Sentry,
// telemetry, overlay) so it can run outside Electron.
const FILTER_BLOCK =
  "var D$n=0,O$n=[],k$n=1e4,A$n=2e3,j$n=300,M$n=3,N$n=3e5,P$n=[1e3,5e3,2e4];function F$n(){D$n++}function I$n(){return D$n<=0?!1:(D$n--,!0)}function L$n(){let e=Date.now();return O$n=O$n.filter((t=>t>e)),O$n}function R$n(){L$n().push(Date.now()+k$n)}function z$n(){return L$n().shift()!==void 0}function B$n(e){return I$n()?((e.reason===\"killed\"||e.reason===\"crashed\")&&R$n(),!1):!(e.reason===\"clean-exit\"||e.reason===\"killed\"&&Nj())}";
const QUIT_DECL = "var Oj=!1,kj=!1,Aj=!1;var Nj=()=>Oj||kj||Aj";
const M1N = "function M1n(e){setImmediate((()=>{e.isDestroyed()||e.reload()}))}";
const HANDLER =
  "e.on(\"render-process-gone\",(async(t,n)=>{if(h$n(e),!B$n(n))return;let r=s(),c=w$n(e),l=j1n(),u=KEn();if(n.reason===\"killed\"&&(await new Promise((e=>setTimeout(e,j$n))),e.isDestroyed()||Nj())||e.isDestroyed())return;P.info(\"Main webview render process gone: %o\",n);let d=Date.now();if(d-a>N$n&&(i=0),a=d,Oe(\"Main webview render process gone\",{level:\"error\",tags:{event:\"webview-render-process-gone\",reason:n.reason,accessibility_support:Ij(l.accessibility_support_enabled)},extra:{exitCode:n.exitCode}}),await C1n(Promise.all([Q(\"desktop_main_view_render_process_gone\",{surface:Uj(e.getURL()),web_commit_hash:c,reason:n.reason,exit_code:n.exitCode,reload_attempt:i,main_rss_bytes:process.memoryUsage().rss,...l},{mainViewHeap:u}).then(ij),ke(A$n)])),s()&&(r=!0),!r&&i>=M$n){P.info(\"Render process gone reload cap reached; not reloading again\"),Eo(LQn(n));return}r||i++;let f=i-1;if(n.reason!==\"launch-failed\"){M1n(e);return}let p=P$n[Math.min(f,P$n.length-1)];P.info(\"Renderer failed to launch; reloading in %ds\",p/1e3),o=setTimeout((()=>{o=void 0,e.isDestroyed()||e.reload()}),p)}))";

const STUBS =
  "var __log=[],P={info:(...a)=>__log.push(a[0]),debug(){}},Oe=()=>{},C1n=p=>p,Q=async()=>{},ij=()=>{},ke=()=>{},Eo=()=>{},LQn=()=>({}),Uj=()=>\"\",Ij=()=>\"\",h$n=()=>{},w$n=()=>null,j1n=()=>({}),KEn=()=>null;";
const INSTALL =
  "function install(e){var i=0,a=0,o,s=()=>{let e=o!==void 0;return clearTimeout(o),o=void 0,e};" +
  HANDLER +
  "}";
const FIXTURE = ['"use strict";', STUBS, QUIT_DECL, FILTER_BLOCK, M1N, INSTALL, ""].join("\n");

const UPSTREAM_FILTER_TAIL = ':!(e.reason==="clean-exit"||e.reason==="killed"&&Nj())}';
const PATCHED_FILTER_TAIL =
  ':!(e.reason==="clean-exit"&&!globalThis.__cdbCleanExitRecoverable(e,Nj)||e.reason==="killed"&&Nj())}';
const UPSTREAM_GRACE = 'if(n.reason==="killed"&&(await new Promise((e=>setTimeout(e,j$n))),e.isDestroyed()||Nj())||e.isDestroyed())return;';
const PATCHED_GRACE =
  'if((n.reason==="killed"||n.reason==="clean-exit")&&(await new Promise((e=>setTimeout(e,j$n))),e.isDestroyed()||Nj())||e.isDestroyed())return;';

function runPatch(bin, file) {
  const r = spawnSync(bin, [file], { encoding: "utf8" });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

// Load the (patched) fixture into a fresh context and return knobs to drive it.
function load(src, { platform = "linux" } = {}) {
  const diag = [];
  const sandbox = {
    setImmediate,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Math,
    console,
    process: { platform, memoryUsage: () => ({ rss: 0 }) },
    __cdbDiag: (s) => diag.push(s),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    sandbox,
    diag,
    install: (wc) => vm.runInContext("install", sandbox)(wc),
    setQuitting: (v) => vm.runInContext(`kj=${v ? "!0" : "!1"}`, sandbox),
    log: () => vm.runInContext("__log", sandbox),
  };
}

function makeWc() {
  const handlers = {};
  const wc = {
    destroyed: false,
    reloads: 0,
    on(name, fn) {
      handlers[name] = fn;
      return wc;
    },
    isDestroyed() {
      return wc.destroyed;
    },
    reload() {
      wc.reloads++;
    },
    getURL: () => "https://claude.ai/new",
  };
  wc.emit = async (details) => {
    await handlers["render-process-gone"]({}, details);
    // M1n reloads on setImmediate; give it one macrotask.
    await new Promise((r) => setImmediate(r));
  };
  return wc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = join(tmpdir(), `cdb-renderer-clean-exit-${process.pid}`);

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

  console.log("\n[1] the compiled patch applies to the v3.1623.0 shapes, idempotently");
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(PATCH_BIN, file);
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  check("A applied", r1.out.includes("[OK] A: clean-exit term of B$n now consults __cdbCleanExitRecoverable (quitting=Nj)"), true);
  check("B applied", r1.out.includes("[OK] B: 300 ms grace now covers clean-exit (details=n quitting=Nj)"), true);
  const patched = readFileSync(file, "utf8");
  check("filter term rewritten", patched.includes(PATCHED_FILTER_TAIL), true);
  check("upstream filter term gone", patched.includes(UPSTREAM_FILTER_TAIL), false);
  check("grace widened", patched.includes(PATCHED_GRACE), true);
  check("upstream grace gone", patched.includes(UPSTREAM_GRACE), false);
  check("helper defined once", patched.split("globalThis.__cdbCleanExitRecoverable||=(").length - 1, 1);
  check("marker injected once", patched.split("__cdb_clean_exit_reload_v1__").length - 1, 1);
  check("handler head untouched", patched.includes('(async(t,n)=>{if(h$n(e),!B$n(n))return;'), true);
  let syntaxOk = true;
  try {
    execFileSync("node", ["--check", file], { stdio: "pipe" });
  } catch {
    syntaxOk = false;
  }
  check("patched fixture passes node --check", syntaxOk, true);
  const r2 = runPatch(PATCH_BIN, file);
  check("second run exits 0", r2.status, 0);
  check("second run reports A already applied", r2.out.includes("[OK] A: clean-exit term already consults __cdbCleanExitRecoverable"), true);
  check("second run reports B already applied", r2.out.includes("[OK] B: 300 ms grace already covers clean-exit"), true);
  check("second run leaves the file byte-identical", readFileSync(file, "utf8") === patched, true);

  console.log("\n[2] clean-exit while the app is idle -> the main view reloads");
  {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    await wc.emit({ reason: "clean-exit", exitCode: 0 });
    check("reload() called once", wc.reloads, 1);
    check("upstream's own log line follows", ctx.log().includes("Main webview render process gone: %o"), true);
    check("one [cdb-renderer] decision line", ctx.diag.filter((l) => l.startsWith("[cdb-renderer] ")).length, 1);
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

  console.log("\n[6] other reasons keep upstream's verdicts");
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
  }
  {
    // The intentional-kill latch (forcefullyCrashRenderer after unresponsive).
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    vm.runInContext("F$n()", ctx.sandbox);
    await wc.emit({ reason: "crashed", exitCode: 11 });
    check("expected kill -> suppressed by the latch (unchanged)", wc.reloads, 0);
  }

  console.log("\n[7] an upstream that already reloads after clean-exit is refused (absorbed)");
  {
    const absorbed = join(scratch, "index-absorbed.js");
    writeFileSync(
      absorbed,
      FIXTURE.replace(UPSTREAM_FILTER_TAIL, ':!(e.reason==="killed"&&Nj())}')
    );
    const r = runPatch(PATCH_BIN, absorbed);
    check("exit 1", r.status, 1);
    check("names the absorption", r.out.includes("this patch is absorbed: remove it (Rule 4)"), true);
    check("file left untouched", readFileSync(absorbed, "utf8").includes('(e.reason==="killed"&&Nj())}'), true);
  }

  console.log("\n[8] fix_renderer_gone_suppressed_log composes with this patch");
  let logMissing = false;
  try {
    accessSync(LOG_PATCH_BIN, constants.X_OK);
  } catch {
    logMissing = true;
    console.log("  SKIP patches/linux/fix_renderer_gone_suppressed_log is not compiled");
  }
  if (!logMissing) {
    const r = runPatch(LOG_PATCH_BIN, file);
    check("suppressed-log patch applies after ours", r.status, 0);
    check("...with its one match", r.out.includes("[OK] suppressed renderer-gone log: 1 match"), true);
    const both = readFileSync(file, "utf8");
    check("our grace survives its rewrite", both.includes('if((n.reason==="killed"||n.reason==="clean-exit")&&(await new Promise('), true);
    const r3 = runPatch(PATCH_BIN, file);
    check("ours is still idempotent on the combined output", r3.status, 0);
    check("combined output byte-identical after our re-run", readFileSync(file, "utf8") === both, true);
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

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
