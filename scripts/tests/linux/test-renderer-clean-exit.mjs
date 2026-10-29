#!/usr/bin/env node
// Main-view renderer recovery: a clean-exit nobody asked for (issue #287) must
// reach upstream's reload path, and a renderer whose whole process is stalled,
// so the unresponsive watchdog's crash request never runs (issue #299), must
// still die and be reloaded.
//
// WHY THIS EXISTS
// ---------------
// Upstream's main-webview render-process-gone handler runs every death
// through a reason filter. Without a pending "we crashed it ourselves" token
// it drops `clean-exit` unconditionally; on Linux the main view's renderer
// can exit with reason clean-exit / exitCode 0 on its own, and the window then
// stays blank (#287). With a token it drops EVERY reason. The unresponsive
// watchdog adds a token per kill attempt and arms a 30 s re-check that reloads
// the view when no page committed. On Linux its forcefullyCrashRenderer() asks
// the renderer to crash itself on its IO thread: that works while only the
// main thread is hung, and does nothing when the whole renderer process is
// stalled; upstream's re-check reloads then go to the same stalled renderer
// and end on its Restart-only error card (#299).
//
// patches/linux/fix_renderer_clean_exit_reload:
//   A. the filter's clean-exit term asks __cdbCleanExitRecoverable
//   B. the 300 ms `killed` grace also covers clean-exit
//   D. __cdbHungKillEscalate(e) runs before e.forcefullyCrashRenderer(): it
//      SIGKILLs the renderer pid 5 s later unless the view recovered (a
//      liveness probe at the deadline that answers also counts as recovered).
//      The `killed` that follows is dropped by upstream's token and upstream's
//      own re-check reloads.
// (both helpers in js/renderer_clean_exit.js; sub-patch C, which handed a
// tokened death straight to the reload path, is retired). Everything after
// the filter is upstream's own path.
//
// This harness runs the compiled patch against the v4.29.0 shapes it targets
// (filter and its expiring tokens, quitting predicate, reload helper, and the
// whole function holding the unresponsive watchdog and the handler, verbatim) and then drives the PATCHED code with a stubbed
// WebContents:
//
//   [1]  apply on pristine, idempotent 2nd run (positive [OK] lines), node --check,
//        retired C helper absent
//   [2]  clean-exit, app idle            -> reload
//   [3]  clean-exit while quitting        -> suppressed
//   [4]  clean-exit, view destroyed in grace -> suppressed
//   [5]  4th clean-exit within 10 min     -> suppressed (upstream behavior)
//   [6]  no token: crashed / killed keep upstream's verdicts
//   [7]  token pending + killed / crashed / clean-exit -> dropped (upstream)
//   [8]  a death from elsewhere in the token window -> dropped, D stands down,
//        upstream's re-check reloads
//   [9]  watchdog: SIGKILL only while unresponsive with an unchanged pid
//   [9b] ...and only when a 2 s liveness probe at the deadline gets no answer
//   [9c] upstream's own spare check runs first: a spared renderer never arms it
//   [10] watchdog -> SIGKILL -> `killed` dropped -> upstream's re-check reloads
//   [11] refusals: absorbed filter, missing anchors, foreign or stale end-state -> exit 1
//   [12] fix_renderer_gone_suppressed_log composes, in both orders

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

// Upstream shapes, copied verbatim from the v4.29.0 bundle
// (index.chunk-Sq9qOqtc.js). Nothing inside the pieces is invented: STUBS only
// stubs the helpers they call (logger, Sentry, telemetry, overlay, print-call
// guard, navigation bookkeeping) so they can run outside Electron. KRR is the
// whole function that registers the main view's watchdog and handlers; Drr
// (the responsive tracker) is stubbed to return __hang so a case can feed
// upstream's hang-kill spare check.
const FILTER_BLOCK =
  "var rV=[],wnr=[],Tnr=1e4,Enr=1e4,Dnr=2e3,Onr=300,knr=3,Anr=3e5,jnr=[1e3,5e3,2e4],Mnr=3e4,Nnr=1e3,Pnr=500,Fnr=3e5;function Inr(){Bnr().push(1/0)}function Lnr(){let e=rV.indexOf(1/0);e!==-1&&rV.splice(e,1)}function Rnr(){let e=Date.now()+Enr;rV=rV.map((t=>Math.min(t,e)))}function znr(){return Bnr().shift()!==void 0}function Bnr(){let e=aV===void 0?0:Anr,t=Date.now();return rV=rV.filter((n=>n+e>t)),rV}function Vnr(){let e=Date.now();return wnr=wnr.filter((t=>t>e)),wnr}function Hnr(){Vnr().push(Date.now()+Tnr)}function Unr(){return Vnr().shift()!==void 0}function Wnr(e){return znr()?((e.reason===\"killed\"||e.reason===\"crashed\")&&Hnr(),!1):!(e.reason===\"clean-exit\"||e.reason===\"killed\"&&XN())}var iV=!1;function Gnr(){return iV}var aV,oV,Knr=18e4,qnr=[0,15e3,3e4],Jnr=.2,Ynr=1e3,Xnr=1e4,Znr=6e4,Qnr=3,sV,cV=0,lV=0,$nr=0,uV=0,err=\"load_failed\",trr=0,dV=!1,fV,pV,mV=!1;";
const QUIT_DECL = "var WN=!1,GN=!1,KN=!1;var XN=()=>WN||GN||KN";
const YB_FN = "function YB(e){return e.isDestroyed()||e.isCrashed()||e.getOSProcessId()===0}";
const ORR =
  "function Orr(e){setImmediate((()=>{e.isDestroyed()||e.reload()}))}";
const KRR =
  "function krr(e,t={}){iV=!1,aV=void 0,oV=void 0,sV=e,drr=t.offersOfflineGame??(()=>!1),frr=t.offersOrganizationSignIn??(()=>!1),prr=t.offersClaudeApiSignIn??(()=>!1);let n=t.printCallGuardEnabled??(()=>!1),r=t.hangKillSpareEnabled??(()=>!1);nnr(e),irr();let i=0,a=0,o=0,s=0,c,l=()=>{let e=c!==void 0;return clearTimeout(c),c=void 0,e},u,d=()=>{clearTimeout(u),u=void 0},f,p=t=>{d(),aV===e&&(aV=void 0),oV?.view===e&&(oV=void 0);let n=f;if(f=void 0,!n)return;let r=Date.now()-n.startedAt;P.info(\"Main webview's recovery from the hang kill ended: %s after %d load(s) in %d ms\",t,n.loads,r),Q(\"desktop_main_view_hang_recovery\",{recovery_outcome:t,surface:n.surface,loads:n.loads,loads_hidden:n.loadsHidden,elapsed_ms:r,window_visible:wV().window_visible,window_visible_at_kill:n.visibleAtKill,network_service_gone:p0e()}).then(dN)},m=()=>{let e=Date.now();e-s>Anr&&(a=0,o=0),s=e},h=0,g=()=>{f&&(f.loads++,wV().window_visible===!1&&f.loadsHidden++),aV=e,oV?.view===e&&(oV=void 0),h=performance.now(),_(Mnr)},_=t=>{clearTimeout(u),u=setTimeout((()=>{if(u=void 0,e.isDestroyed()||XN()){p(\"abandoned\");return}if(jo){p(\"error_card\");return}let t=e.isLoading(),n=t&&e.isWaitingForResponse();if(P.info(\"Main webview committed no page within %d s of its recovery reload (%s)\",Math.round((performance.now()-h)/1e3),n?\"no response yet\":t?\"loading\":\"not loading\"),t&&e.stop(),n){bV(\"load_failed\",{errorCode:-7,errorDescription:\"ERR_TIMED_OUT\"}),p(\"error_card\");return}m(),v(void 0,!1)}),t)},v=(t,n)=>{if(!n&&a>=knr){P.info(\"Recovery reload cap reached; not reloading again\"),p(\"gave_up\");let n=t&&o>1?Ctr(t):wtr(),r=wV().window_visible===!1;Mo(r?void 0:n),r&&(oV={view:e,card:n});return}n||a++;let r=a-1;if(t?.reason!==\"launch-failed\"){g(),Orr(e);return}let i=jnr[Math.min(r,jnr.length-1)];P.info(\"Renderer failed to launch; reloading in %ds\",i/1e3),c=setTimeout((()=>{if(c=void 0,e.isDestroyed()){p(\"abandoned\");return}g(),e.reload()}),i)};Ke(iqn(\"crash-dump-filter\",\"keep\",(e=>Ltr(e,Unr))));let y=Drr(e);e.on(\"did-start-navigation\",(t=>{if(t.isMainFrame&&!t.isSameDocument){if(l())g();else if(u!==void 0){let e=h+2*Mnr-performance.now();_(Math.max(0,Math.min(Mnr,e)))}rnr(e)}})),e.on(\"did-fail-load\",((e,t,n,r,i)=>{i&&t!==-3&&(P.info(`Failed to load URL: ${r} %o`,{errorCode:t,errorDescription:n}),bV(\"load_failed\",{errorCode:t,errorDescription:n}),Q(\"desktop_main_view_load_failed\",{error_code:t,error_description:n,is_claude_host:pP(fP(r)?.host??\"\")}))})),e.on(\"did-navigate\",((t,n,r,a)=>{if(l()&&g(),$B(e),r>=400&&r<600){P.info(`Navigation to ${n} failed with status code ${r}: ${a}`),bV(\"http_error\",{errorCode:r,errorDescription:a}),p(\"error_card\");let t=pP(new URL(n).host);Q(\"desktop_main_view_http_error\",{http_status:r,http_status_text:a,is_claude_host:t}),!t&&i<3&&(i++,P.info(`Navigating back to ${NA()}`),e.loadURL(NA()))}else r<400&&n!==\"about:blank\"?(iV||e.navigationHistory.getEntryAtIndex(0)?.url===\"about:blank\"&&e.navigationHistory.removeEntryAtIndex(0),iV=!0,p(\"loaded\"),i=0,cV>0&&(P.info(\"Main view load recovered after %d failed attempt(s)\",cV),Q(\"desktop_main_view_load_recovered\",arr())),irr(),Mo(void 0)):n!==\"about:blank\"&&p(\"loaded\")})),e.on(\"did-frame-navigate\",(async(t,n,r,i,a)=>{if(!(a||!jo)&&await Cnr(e)){P.info(\"Turnstile iframe detected. Removing error overlay.\"),Mo(void 0);return}}));let b=-1/0,x=async(t,n)=>{let i=null,a=e=>({outcome:e,pageAnswerMs:i});try{if(t!==\"none\")return a(\"print_call\");if(!n?.responsive)return a(\"no_responsive_event\");if(aV===e)return a(\"reload_pending\");if(performance.now()-b<Fnr)return a(\"spared_recently\");if(!r())return a(\"spare_switch_off\");await $h(Nnr);let o=performance.now(),s=await hg(e.executeJavaScript(\"true\"),Pnr,!1);return i=Math.round(performance.now()-o),s===!0?YB(e)?a(\"renderer_gone\"):y()===n?a(\"spared\"):a(\"hung_again\"):a(\"no_answer\")}catch{return a(\"error\")}},S=!1,C=async e=>{S=!0;try{await w(e)}finally{S=!1,Rnr()}},w=async t=>{$B(e),Inr(),d();let n=aP(e.getURL()),r=nV(e),i=wV(),a=wrr(),o=yrr(),s=performance.now(),c=y();await SV(Q(\"desktop_main_view_unresponsive\",{surface:n,web_commit_hash:r,main_rss_bytes:process.memoryUsage().rss,...i,...a,...o,print_call:t}).then(dN));let l=Math.round(performance.now()-s),{outcome:u,pageAnswerMs:m}=await x(t,c);if(e.isDestroyed()){p(\"abandoned\");return}let h={surface:n,web_commit_hash:r,print_call:t,window_visible:i.window_visible,window_minimized:i.window_minimized,wait_ms:l,...c?.responsive??Err,electron_version:process.versions.electron,page_answer_ms:m,kill_outcome:u};if(u===\"spared\"){b=performance.now(),Lnr(),P.info(\"Main webview is responsive again (answered a script in %d ms), hang kill called off\",m),Q(\"desktop_main_view_hang_kill_wait\",h);return}e.forcefullyCrashRenderer(),f??={startedAt:Date.now(),surface:n,visibleAtKill:i.window_visible,loads:0,loadsHidden:0},g(),Orr(e),Q(\"desktop_main_view_hang_kill_wait\",h)},T=async()=>{e.isDestroyed()||(P.info(\"Main webview's print() call is still in progress %d minutes after it began and a kill was skipped for it, will kill and reload\",enr/6e4),await C(\"deadline\"))};e.on(\"unresponsive\",(async()=>{if(S)return;let t=snr(e,n,(()=>void T()));if(t.skipKill){P.info(\"Main webview is unresponsive during a print() call (started %d ms ago), not killing%s\",t.printCallAgeMs,t.firstSkip?\"; logging desktop_main_view_unresponsive_kill_skipped\":\"\"),t.firstSkip&&Q(\"desktop_main_view_unresponsive_kill_skipped\",{surface:aP(e.getURL()),web_commit_hash:nV(e),print_call_age_ms:t.printCallAgeMs});return}P.info(\"Main webview is unresponsive, will kill and reload\"),await C(t.printCall)})),e.on(\"render-process-gone\",(async(t,n)=>{if($B(e),!Wnr(n))return;d();let r=l(),i=nV(e),s=wV(),c=kVn();if(n.reason===\"killed\"&&(await new Promise((e=>setTimeout(e,Onr))),e.isDestroyed()||XN())){p(\"abandoned\");return}if(e.isDestroyed()){p(\"abandoned\");return}P.info(\"Main webview render process gone: %o\",n),m(),o++,Je(\"Main webview render process gone\",{level:\"error\",tags:{event:\"webview-render-process-gone\",reason:n.reason,accessibility_support:rP(s.accessibility_support_enabled)},extra:{exitCode:n.exitCode}}),await SV(Promise.all([Q(\"desktop_main_view_render_process_gone\",{surface:aP(e.getURL()),web_commit_hash:i,reason:n.reason,exit_code:n.exitCode,reload_attempt:a,main_rss_bytes:process.memoryUsage().rss,...s},{mainViewHeap:c}).then(dN),Ye(Dnr)])),l()&&(r=!0),v(n,r)}))}";

const STUBS =
  "var __log=[],__overlay=[],__hang=void 0,P={info:(...a)=>__log.push(a[0]),debug(){},warn(){}},Je=()=>{},SV=p=>p,Q=async()=>{},dN=()=>{},Ye=()=>{},Mo=x=>__overlay.push(x),Ctr=n=>({reason:n.reason}),wtr=()=>({}),aP=()=>\"\",rP=()=>\"\",$B=()=>{},nV=()=>null,wV=()=>({}),wrr=()=>({}),yrr=()=>({}),Err={},kVn=()=>null,enr=6e5,snr=()=>({skipKill:!1,printCall:\"none\"}),Drr=()=>()=>__hang,$h=async()=>{},hg=(p,ms,d)=>Promise.race([p,new Promise(r=>setTimeout(()=>r(d),ms))]),p0e=()=>!1,nnr=()=>{},irr=()=>{},Ke=()=>{},iqn=()=>{},Ltr=()=>{},rnr=()=>{},bV=()=>{},pP=()=>!1,fP=()=>null,NA=()=>\"\",arr=()=>({}),Cnr=async()=>!1,jo,drr,frr,prr;";
const INSTALL = KRR + "function install(e,t){krr(e,t)}";
const FIXTURE = ['"use strict";', STUBS, QUIT_DECL, FILTER_BLOCK, YB_FN, ORR, INSTALL, ""].join("\n");

const UPSTREAM_FILTER =
  "function Wnr(e){return znr()?((e.reason===\"killed\"||e.reason===\"crashed\")&&Hnr(),!1):!(e.reason===\"clean-exit\"||e.reason===\"killed\"&&XN())}";
const PATCHED_FILTER =
  "function Wnr(e){return znr()?((e.reason===\"killed\"||e.reason===\"crashed\")&&Hnr(),!1):!(e.reason===\"clean-exit\"&&!globalThis.__cdbCleanExitRecoverable(e,XN)||e.reason===\"killed\"&&XN())}";
// The v2 end-state with retired sub-patch C, which the patch must refuse.
const RETIRED = "__cdbWatchdogKillRecoverable";
const PATCHED_FILTER_V2 =
  "function Wnr(e){return znr()?((e.reason===\"killed\"||e.reason===\"crashed\")&&Hnr(),globalThis.__cdbWatchdogKillRecoverable(e,XN)):!(e.reason===\"clean-exit\"&&!globalThis.__cdbCleanExitRecoverable(e,XN)||e.reason===\"killed\"&&XN())}";
const UPSTREAM_GRACE =
  "if(n.reason===\"killed\"&&(await new Promise((e=>setTimeout(e,Onr))),e.isDestroyed()||XN())){p(\"abandoned\");return}";
const PATCHED_GRACE =
  "if((n.reason===\"killed\"||n.reason===\"clean-exit\")&&(await new Promise((e=>setTimeout(e,Onr))),e.isDestroyed()||XN())){p(\"abandoned\");return}";
const UPSTREAM_KILL = "e.forcefullyCrashRenderer(),f??=";
const PATCHED_KILL = "globalThis.__cdbHungKillEscalate(e),e.forcefullyCrashRenderer(),f??=";
// The reload that follows the crash request in the same expression.
const KILL_RELOAD = "g(),Orr(e),Q(\"desktop_main_view_hang_kill_wait\",h)}";
const MARKER = "__cdb_clean_exit_reload_v3__";

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
// Upstream's own recovery timer (Mnr): 30 s after each recovery reload it
// checks that a page committed and reloads again if not. No case here lasts
// that long; it is recorded and unref'd so it never holds the process open,
// and fireRecovery() runs the armed one on demand.
const RECOVERY_COMMIT_MS = 30000;

// Load the (patched) fixture into a fresh context and return knobs to drive it.
function load(src, { platform = "linux", killThrows = false } = {}) {
  const diag = [];
  const kills = [];
  const escalateDelays = [];
  const probeDelays = [];
  const recoveryTimers = [];
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
      if (ms === RECOVERY_COMMIT_MS) {
        const r = { fn, args: a, t: null, done: false };
        r.t = setTimeout(() => {
          r.done = true;
          fn(...a);
        }, ms);
        r.t.unref();
        recoveryTimers.push(r);
        return r.t;
      }
      return setTimeout(fn, ms, ...a);
    },
    clearTimeout: (t) => {
      for (const r of recoveryTimers) if (r.t === t) r.done = true;
      clearTimeout(t);
    },
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
    recoveryTimers,
    install: (wc, opts) => vm.runInContext("install", sandbox)(wc, opts),
    setQuitting: (v) => vm.runInContext(`GN=${v ? "!0" : "!1"}`, sandbox),
    // A token as the watchdog leaves it once its kill attempt is over (Inr, then Rnr).
    addToken: () => vm.runInContext("rV.push(Date.now()+Enr)", sandbox),
    tokens: () => vm.runInContext("rV.length", sandbox),
    expectedDumps: () => vm.runInContext("wnr.length", sandbox),
    setHang: (v) => vm.runInContext(`__hang=${JSON.stringify(v)}`, sandbox),
    log: () => vm.runInContext("__log", sandbox),
    // Upstream's 30 s "committed no page" re-checks still armed.
    pendingRecovery: () => recoveryTimers.filter((r) => !r.done).length,
    // Run the latest armed re-check now (as if its 30 s had passed).
    fireRecovery: async () => {
      const r = [...recoveryTimers].reverse().find((x) => !x.done);
      if (!r) return false;
      r.done = true;
      clearTimeout(r.t);
      r.fn(...r.args);
      await new Promise((res) => setImmediate(res));
      return true;
    },
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
      wc.crashRequests++; /* Linux: served on the renderer IO thread, which a whole-process stall never runs */
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
      /* upstream's hang-kill spare check evaluates `true` */
      return wc.probeMode === "answer" ? Promise.resolve(code === "true" ? true : 1) : new Promise(() => {});
    },
    reload() {
      wc.reloads++;
    },
    // Upstream's re-check asks these; a killed renderer has no load in flight.
    loading: false,
    isLoading: () => wc.loading,
    isWaitingForResponse: () => false,
    stop() {},
    getURL: () => "https://claude.ai/new",
  };
  const fire = async (name, ...args) => {
    for (const fn of handlers[name] || []) await fn(...args);
  };
  wc.emit = async (details) => {
    await fire("render-process-gone", {}, details);
    // Orr reloads on setImmediate; give it one macrotask.
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

  console.log("\n[1] the compiled patch applies to the v4.29.0 shapes, idempotently");
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
  check("A applied", r1.out.includes("[OK] A: clean-exit term of Wnr now consults __cdbCleanExitRecoverable (quitting=XN)"), true);
  check("B applied", r1.out.includes("[OK] B: 300 ms grace now covers clean-exit (details=n quitting=XN)"), true);
  check("no C line (sub-patch C retired)", /\bC:/.test(r1.out), false);
  check("D applied", r1.out.includes("[OK] D: SIGKILL fallback armed before e.forcefullyCrashRenderer() (reload=Orr)"), true);
  check("3/3 reported", r1.out.includes("3/3 patches applied"), true);
  const patched = readFileSync(file, "utf8");
  check("filter rewritten (A only, token branch still upstream's !1)", patched.includes(PATCHED_FILTER), true);
  check(`retired ${RETIRED} absent from the patched output`, patched.includes(RETIRED), false);
  check("upstream filter gone", patched.includes(UPSTREAM_FILTER), false);
  check("grace widened", patched.includes(PATCHED_GRACE), true);
  check("upstream grace gone", patched.includes(UPSTREAM_GRACE), false);
  check("watchdog escalates before forcefullyCrashRenderer", patched.includes(PATCHED_KILL), true);
  check("forcefullyCrashRenderer still called once", patched.split(".forcefullyCrashRenderer(").length - 1, 1);
  check("helper inlined right in front of the filter", patched.includes("})();" + PATCHED_FILTER), true);
  check("marker injected once", patched.split(MARKER).length - 1, 1);
  check("v1/v2 markers absent", /__cdb_clean_exit_reload_v[12]__/.test(patched), false);
  check("handler head untouched", patched.includes("(async(t,n)=>{if($B(e),!Wnr(n))return;"), true);
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
  check("second run: no C line", /\bC:/.test(r2.out), false);
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
    check("...and upstream's own 5-minute cap takes over", ctx.log().includes("Recovery reload cap reached; not reloading again"), true);
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

  console.log("\n[7] a watchdog token pending: the death is dropped, as upstream does (C retired)");
  for (const reason of ["killed", "crashed", "clean-exit"]) {
    const ctx = load(patched);
    const wc = makeWc();
    ctx.install(wc);
    ctx.addToken();
    await wc.emit({ reason, exitCode: reason === "killed" ? 9 : reason === "crashed" ? 11 : 0 });
    check(`token + ${reason} -> dropped, no reload`, wc.reloads, 0);
    check(`token + ${reason}: token consumed`, ctx.tokens(), 0);
    check(`token + ${reason}: Hnr notes an expected crash dump only for killed/crashed`, ctx.expectedDumps(), reason === "clean-exit" ? 0 : 1);
    check(`token + ${reason}: no upstream death line`, ctx.log().includes("Main webview render process gone: %o"), false);
    check(`token + ${reason}: no [cdb-renderer] line`, ctx.diag.length, 0);
  }

  console.log("\n[8] a death from elsewhere in the token window: dropped, D stands down, upstream's re-check reloads");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 800 });
    ctx.install(wc);
    await wc.unresponsive();
    const base = wc.reloads; // upstream's Orr right after its crash request
    check("upstream armed its 30 s re-check", ctx.pendingRecovery(), 1);
    // The OOM killer (or the user) kills the stalled renderer before our deadline.
    wc.crashed = true;
    await wc.emit({ reason: "killed", exitCode: 9 });
    check("the `killed` is dropped by the token: no reload", wc.reloads - base, 0);
    check("...token consumed", ctx.tokens(), 0);
    check("...no upstream death line", ctx.log().includes("Main webview render process gone: %o"), false);
    check("...the re-check stays armed", ctx.pendingRecovery(), 1);
    await sleep(SETTLE);
    check("D stands down: no SIGKILL", ctx.kills.length, 0);
    check("...logged", ctx.diag.some((l) => l.includes("renderer 800 already gone, SIGKILL fallback not needed")), true);
    check("the re-check fires", await ctx.fireRecovery(), true);
    check("...and reloads", wc.reloads - base, 1);
    check(
      "...with upstream's own log line",
      ctx.log().includes("Main webview committed no page within %d s of its recovery reload (%s)"),
      true
    );
    check("...no error card", ctx.overlays(), 0);
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

  console.log("\n[9c] upstream's hang-kill spare check runs first; a spared renderer never arms the fallback");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 710 });
    wc.probeMode = "answer";
    ctx.install(wc, { hangKillSpareEnabled: () => true });
    ctx.setHang({ responsive: { responsive_arrived: true } });
    await wc.unresponsive();
    await sleep(SETTLE);
    check("spared: no crash request", wc.crashRequests, 0);
    check("spared: fallback never armed", ctx.escalateDelays.length, 0);
    check("spared: no kill", ctx.kills.length, 0);
    check("spared: no reload", wc.reloads, 0);
    check("spared: upstream dropped its pending token", ctx.tokens(), 0);
    check("spared: upstream logged the call-off", ctx.log().some((l) => String(l).includes("hang kill called off")), true);
  }
  {
    // Spare check on, but the page does not answer within upstream's 500 ms.
    const ctx = load(patched);
    const wc = makeWc({ pid: 720 });
    ctx.install(wc, { hangKillSpareEnabled: () => true });
    ctx.setHang({ responsive: { responsive_arrived: true } });
    await wc.unresponsive();
    check("no answer: upstream asks forcefullyCrashRenderer()", wc.crashRequests, 1);
    check("...the fallback is armed", ctx.escalateDelays.join(","), "5000");
    check("...upstream started its 30 s recovery check", ctx.recoveryTimers.length, 1);
    await sleep(SETTLE);
    check("...and fires", JSON.stringify(ctx.kills), JSON.stringify([[720, "SIGKILL"]]));
  }

  console.log("\n[10] end to end: stalled renderer -> watchdog -> SIGKILL -> `killed` dropped -> upstream's re-check reloads");
  {
    const ctx = load(patched);
    const wc = makeWc({ pid: 7000 });
    ctx.install(wc);
    for (let k = 0; k < 4; k++) await wc.unresponsive(); // the 4 attempts seen in the repro
    const afterWatchdog = wc.reloads; // Orr after each crash request the stalled renderer never served
    await sleep(SETTLE);
    check("one SIGKILL", ctx.kills.length, 1);
    // Electron reports the SIGKILLed renderer:
    wc.crashed = true;
    await wc.emit({ reason: "killed", exitCode: 9 });
    check("the `killed` is dropped by upstream's token: no reload from the handler", wc.reloads - afterWatchdog, 0);
    check("...one of the four tokens consumed", ctx.tokens(), 3);
    check("...upstream did not log a death", ctx.log().includes("Main webview render process gone: %o"), false);
    check("...no hand-on decision of ours", ctx.diag.some((l) => l.includes("handing it to")), false);
    check("upstream's re-check is still armed", ctx.pendingRecovery(), 1);
    check("the re-check fires", await ctx.fireRecovery(), true);
    check("...and reloads into a new renderer", wc.reloads - afterWatchdog, 1);
    check(
      "...with upstream's own log line",
      ctx.log().includes("Main webview committed no page within %d s of its recovery reload (%s)"),
      true
    );
    check("...no error card", ctx.overlays(), 0);
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
    FIXTURE.replace('!(e.reason==="clean-exit"||e.reason==="killed"&&XN())}', '!(e.reason==="killed"&&XN())}'),
    "re-audit whether sub-patch A is absorbed and drop it (Rule 4)"
  );
  refusal(
    "token branch no longer returns !1",
    FIXTURE.replace("&&Hnr(),!1):", "&&Hnr(),!0):"),
    "[FAIL] A: reason filter"
  );
  const NO_RELOAD = 'g(),Q("desktop_main_view_hang_kill_wait",h)}';
  refusal(
    "watchdog pair missing (no reload after the crash request)",
    FIXTURE.replace(KILL_RELOAD, NO_RELOAD),
    "[FAIL] D: the watchdog's"
  );
  refusal(
    "watchdog crash request duplicated",
    FIXTURE.replace(UPSTREAM_KILL, "e.forcefullyCrashRenderer()," + UPSTREAM_KILL),
    "[FAIL] D: the watchdog's"
  );
  refusal(
    "reload helper no longer a plain setImmediate reload",
    FIXTURE.replace(ORR, ORR.replace("e.reload()", 'e.loadURL("about:blank")')),
    "[FAIL] D: the watchdog's"
  );
  refusal("grace missing", FIXTURE.replace(UPSTREAM_GRACE, "if(e.isDestroyed())return;"), "[FAIL] B:");
  refusal(
    "patched calls present but the v3 helper missing (no false [OK])",
    patched.replace(MARKER, "__cdb_clean_exit_reload_v2__"),
    "[FAIL] A: reason filter"
  );
  refusal(
    "stale v2 output with retired sub-patch C (no false [OK])",
    patched.replace(PATCHED_FILTER, PATCHED_FILTER_V2).replace(MARKER, "__cdb_clean_exit_reload_v2__"),
    "[FAIL] A: reason filter"
  );
  refusal(
    `v3 output plus the retired ${RETIRED} helper (no false [OK])`,
    patched.replace(PATCHED_FILTER, `globalThis.${RETIRED} ||= function(){return !0};` + PATCHED_FILTER),
    `retired ${RETIRED} 1`
  );
  refusal(
    "applied, plus a stray __cdbHungKillEscalate call elsewhere (no false [OK])",
    patched.replace(PATCHED_FILTER, "globalThis.__cdbHungKillEscalate(x);" + PATCHED_FILTER),
    "[FAIL] D: 1 __cdbHungKillEscalate call(s) in front of the watchdog pair, 2 in total"
  );
  refusal(
    "filter patched but the watchdog call missing (no false [OK])",
    patched.replace(PATCHED_KILL, UPSTREAM_KILL).replace(KILL_RELOAD, NO_RELOAD),
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
    check("reverse order: ours applies 3/3", rr.status === 0 && rr.out.includes("3/3 patches applied"), true);
    check("reverse order: byte-identical to basename order", readFileSync(rev, "utf8") === both, true);
    let bothOk = true;
    try {
      execFileSync("node", ["--check", file], { stdio: "pipe" });
    } catch {
      bothOk = false;
    }
    check("combined output passes node --check", bothOk, true);
    check("combined: all three early returns of the handler log", both.split("Main webview render process gone (suppressed): %o").length - 1, 3);
    {
      const ctx = load(both);
      const wc = makeWc();
      ctx.install(wc);
      const p = wc.emit({ reason: "killed", exitCode: 9 });
      await sleep(50);
      wc.destroyed = true;
      await p;
      check("combined: killed, view destroyed within the grace -> logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), true);
      check("combined: ...and not reloaded", wc.reloads, 0);
    }
    {
      const ctx = load(both);
      const wc = makeWc();
      ctx.install(wc);
      wc.destroyed = true;
      await wc.emit({ reason: "crashed", exitCode: 11 });
      check("combined: crashed on a destroyed view -> logged as suppressed", ctx.log().includes("Main webview render process gone (suppressed): %o"), true);
      check("combined: ...and not reloaded", wc.reloads, 0);
    }
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
      const suppressed = () => ctx.log().filter((l) => l === "Main webview render process gone (suppressed): %o").length;
      await wc.emit({ reason: "killed", exitCode: 9 });
      check("combined: the `killed` with a token pending is logged as suppressed", suppressed(), 1);
      check("combined: ...and not reloaded by the handler", wc.reloads - base, 0);
      check("combined: upstream's re-check fires", await ctx.fireRecovery(), true);
      check("combined: ...and reloads", wc.reloads - base, 1);
      ctx.addToken();
      ctx.setQuitting(true);
      await wc.emit({ reason: "killed", exitCode: 9 });
      check("combined: token + killed while quitting is logged as suppressed", suppressed(), 2);
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
