#!/usr/bin/env node
/*
 * test-windows-update-notice.mjs - js/windows_update_notice_main.js, the
 * Windows build's "a newer build is out" notice
 * (patches/windows/add_windows_update_notice.nim).
 *
 * Runs the real module with electron shimmed (app.whenReady, getVersion,
 * net.fetch answering a canned GitHub release list, dialog, shell) and
 * process.platform "win32", in a temporary userData. Timers are captured, not
 * run: each check is started through globalThis.__cdbWinUpdate.check().
 */
import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = readFileSync(join(ROOT, "js/windows_update_notice_main.js"), "utf8");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

const PAGE = "https://github.com/stratosjl/claude-desktop-extra/releases/tag/";
const rel = (tag, extra) => Object.assign({ tag_name: tag, html_url: PAGE + tag, draft: false, prerelease: false }, extra || {});

// One module instance. `answer` is what net.fetch resolves with (or an Error
// to reject); `response` is the dialog button chosen.
function load(opts) {
  const o = Object.assign({ platform: "win32", version: "4.4212.0", env: {}, response: 0 }, opts);
  const calls = { fetch: [], dialog: [], opened: [], logs: [], timeouts: [], intervals: [] };
  let answer = o.answer;
  const electron = {
    app: {
      whenReady: () => Promise.resolve(),
      getVersion: () => o.version,
      getPath: (n) => (n === "userData" ? o.userData : undefined)
    },
    net: {
      fetch: (url, init) => {
        calls.fetch.push({ url, init });
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer);
      }
    },
    dialog: { showMessageBox: (box) => { calls.dialog.push(box); return Promise.resolve({ response: o.response }); } },
    shell: { openExternal: (url) => { calls.opened.push(url); return Promise.resolve(); } }
  };
  const sandbox = {
    require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: o.platform, env: o.env },
    console, JSON, String, Number, Array, Promise, Error, AbortController,
    setTimeout: (fn, ms) => { calls.timeouts.push(ms); return { unref() {} }; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { calls.intervals.push(ms); return { unref() {} }; },
    __cdbDiag: (m) => calls.logs.push(String(m))
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SRC, vm.createContext(sandbox));
  return {
    calls, g: sandbox,
    setAnswer: (a) => { answer = a; },
    check: () => sandbox.__cdbWinUpdate.check()
  };
}
const releases = (list) => ({ ok: true, status: 200, json: () => Promise.resolve(list) });
const tick = () => new Promise((r) => setImmediate(r));
const freshUserData = () => mkdtempSync(join(tmpdir(), "cdb-winupd-"));

// --- inert off Windows ----------------------------------------------------------
for (const platform of ["linux", "darwin"]) {
  const m = load({ platform, userData: freshUserData() });
  await tick();
  ok(m.g.__cdbWinUpdate === undefined && m.calls.timeouts.length === 0 && m.calls.logs.length === 0,
     platform + ": the module does nothing");
}

// --- armed once the app is ready --------------------------------------------------
{
  const m = load({ userData: freshUserData(), answer: releases([]) });
  await tick();
  ok(m.calls.logs.some((l) => l.startsWith("[win-update] armed")), "logs the armed line the smoke test waits for");
  ok(m.calls.timeouts.includes(60000), "first check 60 s after ready");
  ok(m.calls.fetch.length === 0, "nothing fetched at startup itself");
}

// --- CDB_UPDATE_NOTICE=0 ----------------------------------------------------------------
{
  const m = load({ userData: freshUserData(), env: { CDB_UPDATE_NOTICE: "0" } });
  await tick();
  ok(m.calls.logs.some((l) => l.includes("off (CDB_UPDATE_NOTICE=0)")) && m.calls.timeouts.length === 0,
     "CDB_UPDATE_NOTICE=0: off, no check scheduled");
}

// --- a newer build: one dialog, the release page on "Open download page" -------------
{
  const ud = freshUserData();
  const list = [rel("windows-v4.4212.0"), rel("windows-v4.5100.2"), rel("v4.5100.2"), rel("windows-v4.900.0")];
  const m = load({ userData: ud, answer: releases(list) });
  await tick();
  await m.check();
  ok(m.calls.fetch.length === 1 && m.calls.fetch[0].url === "https://api.github.com/repos/stratosjl/claude-desktop-extra/releases?per_page=30",
     "reads this fork's release list");
  ok(m.calls.dialog.length === 1 && m.calls.dialog[0].message.includes("4.5100.2") && m.calls.dialog[0].detail.includes("4.4212.0"),
     "newer windows-v release: one dialog naming the new and the installed version");
  ok(m.calls.opened.length === 1 && m.calls.opened[0] === PAGE + "windows-v4.5100.2",
     "Open download page opens that release's page");
  ok(existsSync(join(ud, "claude-desktop-extra-update.json")) &&
     JSON.parse(readFileSync(join(ud, "claude-desktop-extra-update.json"), "utf8")).notified === "4.5100.2",
     "the notified version is recorded in userData");
  await m.check();
  ok(m.calls.dialog.length === 1, "the next check does not ask again for the same version");
  const again = load({ userData: ud, answer: releases(list) });
  await tick();
  await again.check();
  ok(again.calls.dialog.length === 0, "a restart does not ask again for the same version either");
  again.setAnswer(releases(list.concat([rel("windows-v4.6000.0")])));
  await again.check();
  ok(again.calls.dialog.length === 1 && again.calls.dialog[0].message.includes("4.6000.0"),
     "a later version asks again");
  rmSync(ud, { recursive: true, force: true });
}

// --- versions compare as numbers, not strings -------------------------------------------
{
  const m = load({ version: "4.999.0", userData: freshUserData(), answer: releases([rel("windows-v4.1000.0")]) });
  await tick();
  await m.check();
  ok(m.calls.dialog.length === 1, "4.1000.0 is newer than 4.999.0");
}

// --- nothing to say ---------------------------------------------------------------------------
for (const [label, list] of [
  ["same version", [rel("windows-v4.4212.0")]],
  ["older version", [rel("windows-v4.29.0")]],
  ["only drafts and prereleases are newer", [rel("windows-v4.4212.0"), rel("windows-v5.0.0", { draft: true }), rel("windows-v5.1.0", { prerelease: true })]],
  ["only Linux tags are newer", [rel("v5.0.0"), rel("v5.0.0-2")]],
  ["a newer release whose page is not on this repo", [rel("windows-v5.0.0", { html_url: "https://example.com/windows-v5.0.0" })]],
  ["an empty list", []],
  ["not a list", { message: "Not Found" }]
]) {
  const m = load({ userData: freshUserData(), answer: releases(list) });
  await tick();
  await m.check();
  ok(m.calls.dialog.length === 0 && m.calls.opened.length === 0, label + ": no dialog");
}

// --- "Later" ---------------------------------------------------------------------------------------
{
  const ud = freshUserData();
  const m = load({ userData: ud, response: 1, answer: releases([rel("windows-v4.5100.2")]) });
  await tick();
  await m.check();
  ok(m.calls.dialog.length === 1 && m.calls.opened.length === 0, "Later: nothing opened");
  await m.check();
  ok(m.calls.dialog.length === 1, "Later: not asked again for that version");
}

// --- failures are logged and the next check still runs ------------------------------------------
{
  const m = load({ userData: freshUserData(), answer: { ok: false, status: 403, json: () => Promise.resolve({}) } });
  await tick();
  await m.check();
  ok(m.calls.dialog.length === 0 && m.calls.logs.some((l) => l.includes("check failed: HTTP 403")), "HTTP 403: logged, no dialog");
  m.setAnswer(new Error("getaddrinfo ENOTFOUND api.github.com"));
  await m.check();
  ok(m.calls.fetch.length === 2 && m.calls.logs.some((l) => l.includes("ENOTFOUND")), "network error: logged, and the check ran again");
  m.setAnswer(releases([rel("windows-v4.5100.2")]));
  await m.check();
  ok(m.calls.dialog.length === 1, "after failures a later check still works");
}

// --- an installed version that is not X.Y.Z -------------------------------------------------------
{
  const m = load({ version: "4.4212.0-beta", userData: freshUserData(), answer: releases([rel("windows-v9.0.0")]) });
  await tick();
  await m.check();
  ok(m.calls.dialog.length === 0 && m.calls.logs.some((l) => l.includes("not X.Y.Z")), "unparsable installed version: no dialog, logged");
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
