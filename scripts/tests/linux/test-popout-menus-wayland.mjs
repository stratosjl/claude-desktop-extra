#!/usr/bin/env node
// Popped-out session windows: menus keep working while the main window gets no frames.
//
// WHY THIS EXISTS
// ---------------
// A popped-out Code session is a window.open() child whose React tree runs in
// the main view's realm. Its menus step through open/close with the main
// view's requestAnimationFrame. On native Wayland a main window on a hidden
// workspace gets no frames at all, so the popout's menus stop (#280).
//
// patches/linux/fix_popout_menus_wayland.nim injects js/popout_frames_main.js
// into the bundle head, which executes js/popout_frames_page.js in the main
// view. This harness runs the compiled patch on a bundle-head fixture (markers,
// idempotency, syntax), then drives the page script in a vm with a
// requestAnimationFrame the test controls: frames that never come (hidden on
// Wayland), frames that do come (visible), and a page Chromium reports hidden.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_popout_menus_wayland");
const PAGE_JS = readFileSync(join(ROOT, "js", "popout_frames_page.js"), "utf8");
const SKIP_EXIT = 3;

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${JSON.stringify(actual)}`);
    pass++;
    return;
  }
  console.log(`  FAIL ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  failures.push(label);
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.log(`SKIP: patch binary not compiled: ${PATCH_BIN} (cd patches && make)`);
  process.exit(SKIP_EXIT);
}

// A realm with a requestAnimationFrame the test controls.
function loadPage(visibility = "visible") {
  const frames = [];
  const ctx = {
    performance,
    setTimeout,
    clearTimeout,
    document: { visibilityState: visibility },
    requestAnimationFrame: (cb) => (frames.push(cb), frames.length),
    cancelAnimationFrame: (h) => { frames[h - 1] = null; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const result = vm.runInNewContext(PAGE_JS, ctx);
  return {
    result,
    W: ctx,
    flushFrame: (ts) => frames.splice(0).forEach((cb) => cb && cb(ts)),
    pendingFrames: () => frames.filter(Boolean).length,
  };
}

const work = mkdtempSync(join(tmpdir(), "cdb-popout-frames-"));
try {
  section("patch application");
  const fixture = join(work, "index.js");
  writeFileSync(fixture, `"use strict";var upstream=1;`);
  const run = () => spawnSync(PATCH_BIN, [fixture], { encoding: "utf8" });
  check("first run exits 0", run().status, 0);
  const patched = readFileSync(fixture, "utf8");
  check("bundle still starts with the strict directive", patched.startsWith(`"use strict";`), true);
  check("main marker present once", patched.split("__CDB_POPOUT_FRAMES__").length - 1, 1);
  check("page marker present once", patched.split("__CDB_PF_PAGE__").length - 1, 1);
  check("patched bundle passes node --check", spawnSync(process.execPath, ["--check", fixture]).status, 0);
  check("second run (idempotent) exits 0", run().status, 0);
  check("idempotent run leaves the file unchanged", readFileSync(fixture, "utf8") === patched, true);
  const half = join(work, "half.js");
  writeFileSync(half, `"use strict";/* __CDB_POPOUT_FRAMES__ */var upstream=1;`);
  check("half-patched bundle fails the patch", spawnSync(PATCH_BIN, [half], { encoding: "utf8" }).status, 1);

  section("page script: frames never arrive, page believes it is visible (hidden Wayland workspace)");
  {
    const { result, W } = loadPage("visible");
    check("script returns ok", result, "ok");
    let ran = 0;
    let stamp = -1;
    W.requestAnimationFrame((ts) => { ran++; stamp = ts; });
    await sleep(40);
    check("not run before the fallback", ran, 0);
    await sleep(150);
    check("fallback timer runs the callback", ran, 1);
    check("fallback passes a numeric timestamp", typeof stamp === "number" && stamp > 0, true);
    W.requestAnimationFrame(() => ran++);
    await sleep(200);
    check("a later batch runs too (no queue stall)", ran, 2);
    check("fallbacks counted", W.__cdbPopoutRaf.fallbacks, 2);
    check("installing twice is a no-op", vm.runInNewContext(PAGE_JS, W), "already");
  }

  section("page script: frames arrive (visible main window)");
  {
    const { W, flushFrame, pendingFrames } = loadPage("visible");
    let ran = 0;
    let stamp;
    W.requestAnimationFrame((ts) => { ran++; stamp = ts; });
    W.requestAnimationFrame(() => ran++);
    check("one real frame request per batch", pendingFrames(), 1);
    flushFrame(12345);
    check("the frame runs both callbacks", ran, 2);
    check("callbacks get the frame timestamp", stamp, 12345);
    await sleep(200);
    check("the timer does not run them again", ran, 2);
    check("frames counted, no fallback", `${W.__cdbPopoutRaf.frames}/${W.__cdbPopoutRaf.fallbacks}`, "1/0");

    // Semantics kept from the native API.
    let cancelled = 0;
    const h = W.requestAnimationFrame(() => cancelled++);
    W.cancelAnimationFrame(h);
    let nested = 0;
    W.requestAnimationFrame(() => { W.requestAnimationFrame(() => nested++); });
    let after = 0;
    W.requestAnimationFrame(() => { throw new Error("boom"); });
    W.requestAnimationFrame(() => after++);
    const errors = [];
    const onUncaught = (e) => errors.push(e.message);
    process.on("uncaughtException", onUncaught);
    flushFrame(1);
    check("cancelled callback does not run", cancelled, 0);
    check("callback registered during a frame waits for the next one", nested, 0);
    check("a throwing callback does not stop the others", after, 1);
    flushFrame(2);
    check("nested callback runs on the next frame", nested, 1);
    await sleep(20);
    process.off("uncaughtException", onUncaught);
    check("the thrown error is reported asynchronously", errors.join(","), "boom");
  }

  section("page script: Chromium reports the page hidden (minimized) - native pause kept");
  {
    const { W, flushFrame } = loadPage("hidden");
    let ran = 0;
    W.requestAnimationFrame(() => ran++);
    await sleep(350);
    check("no fallback while the page is hidden", ran, 0);
    W.document.visibilityState = "visible";
    await sleep(150);
    check("fallback resumes once the page is visible again", ran, 1);
    W.requestAnimationFrame(() => ran++);
    flushFrame(3);
    check("a real frame still runs callbacks while hidden", ran, 2);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
