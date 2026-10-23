#!/usr/bin/env node
// "Update available" must follow claude-desktop-extra's releases, and its
// click must open the README section for the installed package format.
//
// WHY THIS EXISTS
// ---------------
// Upstream's Linux updater polls Anthropic's apt repo and shows "Update
// available" whenever that repo has a newer claude-desktop than
// app.getVersion(). Our users update from our own packages, which trail
// Anthropic's apt, so the button showed while nothing was installable; our
// patch releases (v3.1623.1-2) never showed, since app.getVersion() only knows
// 3.1623.1; and the click (the claude.ai SPA does window.open of
// https://code.claude.com/docs/<locale>/desktop-linux#update) led to
// Anthropic's apt instructions.
//
// patches/linux/fix_update_check_own_releases rewires the poll to
// js/update_check_own_releases.js: A the apt Packages fetcher returns our
// latest GitHub release tag, B the compare runs on (X.Y.Z, N) against the
// build-time stamp resources/cdb-release.json, C the updater init wraps
// shell.openExternal so the docs URL becomes our README #install-<format>.
//
// This harness runs the compiled patch against the v3.1623.3 shapes it targets
// (Dti, Sti, the fetcher pair and the cap helper, verbatim) and drives the
// PATCHED poll with a stubbed electron (net.fetch, app.getVersion,
// shell.openExternal), a stamp file and a recording NY.emulateState:
//
//   [1] apply on pristine, idempotent 2nd run, node --check
//   [2] remote v3.1623.1, installed v3.1623.1   -> idle (no apt fetch at all)
//   [3] remote v3.1623.1-2, installed v3.1623.1 -> available "3.1623.1-2"
//   [4] remote v3.1623.3, installed v3.1623.1-2 -> available; cap on X.Y.Z
//   [5] older / malformed / HTTP 403 / fetch throw / timeout -> no change
//   [6] no stamp -> installed from app.getVersion(), link #quick-install
//   [7] the docs URL opens README #install-<format>; other URLs unchanged;
//       composes with fix_profile_url_routing's wrapper
//   [8] a fetcher that already targets our repo is refused (absorbed)
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SKIP_EXIT = 3;
const PATCH_BIN = join(repo, "patches", "linux", "fix_update_check_own_releases");
const PROFILE_PATCH_BIN = join(repo, "patches", "core", "fix_profile_url_routing");
const nodeRequire = createRequire(import.meta.url);

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

// Upstream shapes, copied verbatim from the v3.1623.3 bundle
// (index.chunk-DzV1Jbrw.js; identical shapes, other names, in v3.1623.0).
const DTI =
  "async function Dti(){xti(),oti(),await pti(),P.info(\"[updater] Linux: in-app updater off (updates via apt)\"),Q(\"desktop_update_disabled\",{reason:\"managed_by_package_manager\"}),Sti()}";
const STI =
  "function Sti(){let e=a.app.getVersion();Gd([\"focus\",\"unlock\",\"resume\"],(()=>{K().autoUpdate.disabled||Eti()}));let t=async()=>{if(setTimeout((()=>void t()),Gei),K().autoUpdate.disabled){NY.state.state!==\"idle\"&&NY.emulateState({state:\"idle\"});return}let n=await yti(FY());if(n!==null&&Ll.default.valid(n)&&Ll.default.gt(n,e)&&(e=n,Q(\"desktop_update_available\",{current_version:a.app.getVersion(),update_channel:kY(),target_version:n})),await Eti())return;let r=await wti(),{state:i}=NY;if(r===null||i.state===\"replaced\")return;let o=K().autoUpdate.dangerousMaxVersion,s=Ll.default.gt(r,a.app.getVersion())&&!(o&&a5t(r,o))?r:null;s!==(i.state===\"available\"?i.version:null)&&NY.emulateState(s===null?{state:\"idle\"}:{state:\"available\",version:s})};setTimeout((()=>void t()),Kei)}";
const FETCHER =
  "var Cti=`https://${jo}/claude-desktop/apt/stable`;function wti(){return bh(Tti().catch((()=>null)),5e3,null)}async function Tti(){let e=process.arch===\"arm64\"?\"arm64\":\"amd64\",t=await a.net.fetch(`${Cti}/dists/stable/main/binary-${e}/Packages`);if(!t.ok)return null;let n=null;for(let e of(await t.text()).split(`\\n\\n`)){if(!/^Package: claude-desktop$/m.test(e))continue;let t=Ll.default.valid(/^Version: (\\S+)$/m.exec(e)?.[1]);t!==null&&(n===null||Ll.default.gt(t,n))&&(n=t)}return n}";
const A5T =
  "function a5t(e,t){return Ll.default.valid(t)!==null&&!(Ll.default.valid(e)&&Ll.default.lte(e,t))}";
// The head of upstream's external-link opener (Uy), which the main view's
// window-open handler reaches for an https docs URL via J9: it looks
// a.shell.openExternal up at call time. Only its error branch is trimmed.
const UY = "var nzt=e=>e;function Uy(e,t){let n=nzt(e);a.shell.openExternal(n).catch((e=>{}))}";

// Stubs for what the pieces call. Nothing upstream-specific is invented: the
// telemetry/focus/startup helpers are no-ops, bh is upstream's timeout race
// (scaled 1/100 so the 5 s timeout costs 50 ms), Eti is the "binary replaced"
// probe reduced to the state check, NY records every emulateState.
const STUBS = [
  "var a=globalThis.__electron,Ll={default:globalThis.__semver},jo=\"downloads.claude.ai\",Kei=3e4,Gei=36e5;",
  "var __cfg={autoUpdate:{disabled:!1,dangerousMaxVersion:void 0}};function K(){return __cfg}",
  "var P={info(){}};function Gd(){}function Q(){}function kY(){return\"stable\"}function FY(){return null}async function yti(){return null}",
  "function xti(){}function oti(){}async function pti(){}",
  "async function Eti(){return NY.state.state===\"replaced\"}",
  "var NY={state:{state:\"idle\"},calls:[],emulateState(e){this.state=e,this.calls.push(e)}};",
  "function bh(e,t,n){return Promise.race([e,new Promise((r=>{let i=__realSetTimeout((()=>r(n)),t/100);i&&i.unref&&i.unref()}))])}",
].join("\n");
const FIXTURE = ['"use strict";', STUBS, A5T, STI, FETCHER, DTI, UY, ""].join("\n");

const API = "https://api.github.com/repos/patrickjaja/claude-desktop-extra/releases/latest";
const README = "https://github.com/patrickjaja/claude-desktop-extra";
const DOCS_DE = "https://code.claude.com/docs/de/desktop-linux#update";

// Minimal semver for the pieces' Ll.default.{valid,gt,lte} (prerelease-aware,
// as upstream's semver: 3.1623.1-2 < 3.1623.1).
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const semver = {
  valid(v) {
    if (typeof v !== "string") return null;
    const m = SEMVER_RE.exec(v.trim());
    return m ? `${m[1]}.${m[2]}.${m[3]}${m[4] ? "-" + m[4] : ""}` : null;
  },
  cmp(x, y) {
    const a = SEMVER_RE.exec(x), b = SEMVER_RE.exec(y);
    for (let i = 1; i <= 3; i++) if (+a[i] !== +b[i]) return +a[i] > +b[i] ? 1 : -1;
    if (!a[4] && !b[4]) return 0;
    if (!a[4]) return 1;
    if (!b[4]) return -1;
    const pa = a[4].split("."), pb = b[4].split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
      if (na && nb && +pa[i] !== +pb[i]) return +pa[i] > +pb[i] ? 1 : -1;
      if (na !== nb) return na ? -1 : 1;
      if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
    }
    return 0;
  },
  gt(x, y) {
    return semver.cmp(x, y) > 0;
  },
  lte(x, y) {
    return semver.cmp(x, y) <= 0;
  },
};

function runPatch(bin, file) {
  const r = spawnSync(bin, [file], { encoding: "utf8" });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = join(tmpdir(), `cdb-update-own-releases-${process.pid}`);
let ctxN = 0;

// Load the (patched) fixture with a stubbed electron. `remote` decides what
// net.fetch answers: a tag string, {status}, "throw", "hang", or a function.
function load(src, { appVersion = "3.1623.1", stamp, remote, cap } = {}) {
  const res = join(scratch, `res-${ctxN++}`);
  mkdirSync(res, { recursive: true });
  if (stamp !== undefined) {
    writeFileSync(join(res, "cdb-release.json"), typeof stamp === "string" ? stamp : JSON.stringify(stamp));
  }
  const diag = [];
  const fetches = [];
  const opened = [];
  const timers = [];
  const electron = {
    app: { getVersion: () => appVersion },
    net: {
      fetch: async (url, opts) => {
        fetches.push({ url, opts });
        const r = typeof ctl.remote === "function" ? ctl.remote(url) : ctl.remote;
        if (r === "throw") throw new Error("net::ERR_INTERNET_DISCONNECTED");
        if (r === "hang") return new Promise(() => {});
        if (r && typeof r === "object") {
          return { ok: false, status: r.status, json: async () => ({}), text: async () => "" };
        }
        return { ok: true, status: 200, json: async () => ({ tag_name: r }), text: async () => "" };
      },
    },
    shell: {
      openExternal: async (u) => {
        opened.push(u);
      },
    },
  };
  const ctl = { remote, diag, fetches, opened, electron };
  const sandbox = {
    __electron: electron,
    __semver: semver,
    __realSetTimeout: setTimeout,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    Promise,
    JSON,
    Date,
    Math,
    console,
    require: (m) => (m === "electron" ? electron : nodeRequire(m)),
    process: {
      platform: "linux",
      arch: "x64",
      resourcesPath: res,
      env: { XDG_RUNTIME_DIR: res },
      getuid: () => 1000,
    },
    __cdbDiag: (s) => diag.push(s),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (cap !== undefined) vm.runInContext(`__cfg.autoUpdate.dangerousMaxVersion=${JSON.stringify(cap)}`, sandbox);
  ctl.sandbox = sandbox;
  ctl.start = async () => {
    await vm.runInContext("Dti()", sandbox);
  };
  // Run the next scheduled poll and let it settle (bh's scaled timeout is 50 ms).
  ctl.poll = async () => {
    const t = timers.shift();
    if (!t) throw new Error("no poll scheduled");
    t.fn();
    await sleep(120);
  };
  ctl.calls = () => vm.runInContext("NY.calls", sandbox);
  ctl.state = () => vm.runInContext("NY.state", sandbox);
  ctl.click = async (url) => {
    vm.runInContext(`Uy(${JSON.stringify(url)})`, sandbox);
    await sleep(5);
  };
  ctl.updateLines = () => diag.filter((l) => l.startsWith("[cdb-update] "));
  return ctl;
}

try {
  mkdirSync(scratch, { recursive: true });
  try {
    accessSync(PATCH_BIN, constants.X_OK);
  } catch {
    console.log(
      "  SKIP patches/linux/fix_update_check_own_releases is not compiled " +
        "(run: make -C patches linux/fix_update_check_own_releases)"
    );
    console.log(`${pass} checks passed; everything SKIPPED`);
    process.exit(SKIP_EXIT);
  }

  console.log("\n[1] the compiled patch applies to the v3.1623.3 shapes, idempotently");
  const file = join(scratch, "index.js");
  writeFileSync(file, FIXTURE);
  const r1 = runPatch(PATCH_BIN, file);
  check("first run exits 0", r1.status, 0);
  check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
  check("no 'already' on a pristine run", /\balready\b/i.test(r1.out), false);
  check("A applied", r1.out.includes("[OK] A: Tti now returns our latest release tag (electron=a, timeout wrapper wti)"), true);
  check("B applied", r1.out.includes("[OK] B: poll compare now asks __cdbUpdateOwn.isNewer (cap a5t on X.Y.Z)"), true);
  check("C applied", r1.out.includes("[OK] C: updater init now hooks the update link before starting the poll Sti"), true);
  const patched = readFileSync(file, "utf8");
  check("apt Packages fetch gone", patched.includes("/dists/stable/main/binary-"), false);
  check("fetcher body replaced", patched.includes("async function Tti(){return globalThis.__cdbUpdateOwn.latestTag(a)}"), true);
  check("5 s timeout wrapper kept", patched.includes("function wti(){return bh(Tti().catch((()=>null)),5e3,null)}"), true);
  check(
    "compare rewritten",
    patched.includes(
      "s=globalThis.__cdbUpdateOwn.isNewer(r,a.app.getVersion())&&!(o&&a5t(globalThis.__cdbUpdateOwn.xyz(r),o))?r:null;"
    ),
    true
  );
  check("upstream compare gone", patched.includes("Ll.default.gt(r,a.app.getVersion())"), false);
  check("hook call in Dti", patched.includes("globalThis.__cdbUpdateOwn.hookLinks(a),Sti()}"), true);
  check("helper defined once", patched.split("globalThis.__cdbUpdateOwn||=(").length - 1, 1);
  check("marker injected once", patched.split("__cdb_update_own_releases_v1__").length - 1, 1);
  let syntaxOk = true;
  try {
    execFileSync("node", ["--check", file], { stdio: "pipe" });
  } catch {
    syntaxOk = false;
  }
  check("patched fixture passes node --check", syntaxOk, true);
  const r2 = runPatch(PATCH_BIN, file);
  check("second run exits 0", r2.status, 0);
  check("second run: A already applied", r2.out.includes("[OK] A: fetcher already returns __cdbUpdateOwn.latestTag"), true);
  check("second run: B already applied", r2.out.includes("[OK] B: poll compare already asks __cdbUpdateOwn.isNewer"), true);
  check("second run: C already applied", r2.out.includes("[OK] C: updater init already hooks the update link"), true);
  check("second run leaves the file byte-identical", readFileSync(file, "utf8") === patched, true);

  console.log("\n[2] remote v3.1623.1, installed v3.1623.1 -> idle (Anthropic's apt is never asked)");
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "pacman" }, remote: "v3.1623.1" });
    await c.start();
    await c.poll();
    check("one fetch", c.fetches.length, 1);
    check("...of our releases/latest", c.fetches[0].url, API);
    check("no state change", c.calls().length, 0);
    check("state idle", c.state().state, "idle");
    check("one [cdb-update] decision line", c.updateLines().length, 1);
    check("...saying up to date", (c.updateLines()[0] || "").includes("installed v3.1623.1 (cdb-release.json, format pacman), latest release v3.1623.1 -> up to date"), true);
    await c.poll();
    check("second identical poll: still one line", c.updateLines().length, 1);
  }

  console.log("\n[3] remote v3.1623.1-2, installed v3.1623.1 -> available 3.1623.1-2");
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "deb" }, remote: "v3.1623.1-2" });
    await c.start();
    await c.poll();
    check("state available", c.state().state, "available");
    check("version without v", c.state().version, "3.1623.1-2");
    check("one emulateState", c.calls().length, 1);
    await c.poll();
    check("unchanged on the next poll", c.calls().length, 1);
    check("decision logged once", c.updateLines().filter((l) => l.includes("update available")).length, 1);
    c.remote = "v3.1623.1-1";
    await c.poll();
    check("remote -1 == installed: back to idle", c.state().state, "idle");
  }
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1-1", format: "rpm" }, remote: "v3.1623.1" });
    await c.start();
    await c.poll();
    check("installed -1 vs remote without suffix: idle (N defaults to 1)", c.calls().length, 0);
  }

  console.log("\n[4] remote v3.1623.3, installed v3.1623.1-2 -> available; the cap compares X.Y.Z");
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1-2", format: "nix" }, remote: "v3.1623.3" });
    await c.start();
    await c.poll();
    check("state available", c.state().state, "available");
    check("version", c.state().version, "3.1623.3");
  }
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "pacman" }, remote: "v3.1623.1-2", cap: "3.1623.1" });
    await c.start();
    await c.poll();
    check("cap 3.1623.1, remote 3.1623.1-2: available (X.Y.Z within the cap)", c.state().state, "available");
  }
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "pacman" }, remote: "v3.1623.3", cap: "3.1623.1" });
    await c.start();
    await c.poll();
    check("cap 3.1623.1, remote 3.1623.3: capped, stays idle", c.calls().length, 0);
  }
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "pacman" }, remote: "v3.1623.3" });
    await c.start();
    vm.runInContext("__cfg.autoUpdate.disabled=!0", c.sandbox);
    await c.poll();
    check("autoUpdate.disabled: no fetch", c.fetches.length, 0);
    check("...and no available state", c.state().state, "idle");
  }

  console.log("\n[5] older / malformed / HTTP 403 / fetch throw / timeout -> no change, no throw");
  for (const [label, remote] of [
    ["older v3.1623.0", "v3.1623.0"],
    ["malformed 3.1623.3 (no v)", "3.1623.3"],
    ["malformed v3.1623.3-beta", "v3.1623.3-beta"],
    ["tag_name missing", undefined],
    ["HTTP 403", { status: 403 }],
    ["fetch throws", "throw"],
    ["timeout", "hang"],
  ]) {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "pacman" }, remote });
    await c.start();
    let threw = false;
    try {
      await c.poll();
    } catch {
      threw = true;
    }
    check(`${label}: no throw`, threw, false);
    check(`${label}: no state change`, c.calls().length, 0);
  }
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "pacman" }, remote: "v3.1623.3" });
    await c.start();
    await c.poll();
    check("available before the failures", c.state().state, "available");
    c.remote = { status: 403 };
    await c.poll();
    await c.poll();
    check("HTTP 403 keeps the available state", c.state().state, "available");
    check("...one failure line for two failing polls", c.updateLines().filter((l) => l.includes("check failed: HTTP 403")).length, 1);
  }

  console.log("\n[6] no stamp -> installed from app.getVersion(), link #quick-install");
  {
    const c = load(patched, { appVersion: "3.1623.1", remote: "v3.1623.1" });
    await c.start();
    await c.poll();
    check("same version: idle", c.calls().length, 0);
    check("logged as from app.getVersion()", (c.updateLines()[0] || "").includes("installed v3.1623.1 (app.getVersion(), format unknown)"), true);
    c.remote = "v3.1623.1-2";
    await c.poll();
    check("patch release: available", c.state().version, "3.1623.1-2");
    await c.click(DOCS_DE);
    check("click opens #quick-install", c.opened[0], README + "#quick-install");
  }
  for (const [label, stamp] of [
    ["malformed JSON stamp", "{not json"],
    ["stamp with a bad tag", { tag: "3.1623.1", format: "pacman" }],
  ]) {
    const c = load(patched, { appVersion: "3.1623.1", stamp, remote: "v3.1623.1-2" });
    await c.start();
    await c.poll();
    check(`${label}: falls back to app.getVersion() -> available`, c.state().version, "3.1623.1-2");
    await c.click(DOCS_DE);
    check(`${label}: link #quick-install`, c.opened[0], README + "#quick-install");
  }
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "flatpak" }, remote: "v3.1623.1-2" });
    await c.start();
    await c.poll();
    await c.click(DOCS_DE);
    check("unknown format keeps the tag but links #quick-install", c.opened[0], README + "#quick-install");
    check("...and still compares against the stamp tag", c.state().version, "3.1623.1-2");
  }

  console.log("\n[7] the docs URL opens README #install-<format>; other URLs pass through");
  for (const format of ["pacman", "deb", "rpm", "appimage", "nix"]) {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format }, remote: "v3.1623.1-2" });
    await c.start();
    // Before any poll: the hook is installed by the updater init (sub-patch C).
    await c.click(DOCS_DE);
    check(`${format}: opens exactly #install-${format}`, c.opened[0], `${README}#install-${format}`);
  }
  {
    const c = load(patched, { stamp: { tag: "v3.1623.1", format: "pacman" }, remote: "v3.1623.1-2" });
    await c.start();
    for (const u of [
      "https://code.claude.com/docs/en/desktop-linux#update",
      "https://code.claude.com/docs/zh-CN/desktop-linux#update",
      "https://code.claude.com/docs/desktop-linux#update",
    ]) {
      c.opened.length = 0;
      await c.click(u);
      check(`rewritten: ${u}`, c.opened[0], `${README}#install-pacman`);
    }
    for (const u of [
      "https://code.claude.com/docs/de/desktop-linux",
      "https://code.claude.com/docs/de/desktop-linux#install",
      "https://code.claude.com/docs/de/desktop-linux#update?x=1",
      "https://evil.example/docs/de/desktop-linux#update",
      "https://code.claude.com/docs/de/desktop-linux#update/../x",
      "https://claude.ai/settings",
    ]) {
      c.opened.length = 0;
      await c.click(u);
      check(`unchanged: ${u}`, c.opened[0], u);
    }
    const rewrites = c.updateLines().filter((l) => l.includes("update link "));
    check("one [cdb-update] line per rewrite", rewrites.length, 3);
    // A wrapper installed AFTER ours (another patch, or upstream's hidden
    // launch) still sees the rewritten URL or passes the docs URL on to ours.
    const inner = c.electron.shell.openExternal;
    const seen = [];
    c.electron.shell.openExternal = function (u, o) {
      seen.push(u);
      return inner.call(this, u, o);
    };
    c.opened.length = 0;
    await c.click(DOCS_DE);
    check("outer wrapper sees the docs URL", seen[0], DOCS_DE);
    check("...and ours still rewrites it", c.opened[0], `${README}#install-pacman`);
    await c.poll();
    c.opened.length = 0;
    await c.click(DOCS_DE);
    check("poll does not wrap a second time (one rewrite line per click)", c.updateLines().filter((l) => l.includes("update link ")).length, 5);
  }
  let profileMissing = false;
  try {
    accessSync(PROFILE_PATCH_BIN, constants.X_OK);
  } catch {
    profileMissing = true;
    console.log("  SKIP patches/core/fix_profile_url_routing is not compiled");
  }
  if (!profileMissing) {
    const both = join(scratch, "index-both.js");
    writeFileSync(both, patched);
    const rp = runPatch(PROFILE_PATCH_BIN, both);
    check("fix_profile_url_routing applies on top", rp.status, 0);
    const src = readFileSync(both, "utf8");
    const c = load(src, { stamp: { tag: "v3.1623.1", format: "appimage" }, remote: "v3.1623.1-2" });
    check("profile wrapper installed at load", c.diag.some((l) => l.includes("[claude-profile-route] shell.openExternal hooked")), true);
    await c.start();
    await c.click(DOCS_DE);
    check("combined: docs URL -> #install-appimage", c.opened[0], `${README}#install-appimage`);
    const r3 = runPatch(PATCH_BIN, both);
    check("ours still idempotent on the combined output", r3.status, 0);
    check("combined output byte-identical after our re-run", readFileSync(both, "utf8") === src, true);
  }

  console.log("\n[8] a fetcher that already targets our repo is refused (absorbed)");
  {
    const absorbed = join(scratch, "index-absorbed.js");
    const abs = FIXTURE.replace(
      "var Cti=`https://${jo}/claude-desktop/apt/stable`;",
      "var Cti=`https://api.github.com/repos/patrickjaja/claude-desktop-extra/releases/latest`;"
    ).replace("`${Cti}/dists/stable/main/binary-${e}/Packages`", "Cti");
    check("absorbed fixture differs", abs !== FIXTURE, true);
    writeFileSync(absorbed, abs);
    const r = runPatch(PATCH_BIN, absorbed);
    check("exit 1", r.status, 1);
    check("names the absorption", r.out.includes("this patch is absorbed: remove it (Rule 4)"), true);
    check("file left untouched", readFileSync(absorbed, "utf8") === abs, true);
  }
  {
    const gone = join(scratch, "index-gone.js");
    const g = FIXTURE.replace("Ll.default.gt(r,a.app.getVersion())", "Ll.default.gte(r,a.app.getVersion())");
    writeFileSync(gone, g);
    const r = runPatch(PATCH_BIN, gone);
    check("changed compare shape: exit 1", r.status, 1);
    check("...with a [FAIL] line", /\[FAIL\] B:/.test(r.out), true);
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
