#!/usr/bin/env node
// Quick Entry hotkey on KDE Plasma 6.7.4+: the portal re-bind session (#281).
//
// WHY THIS EXISTS
// ---------------
// Chromium 152 (Electron 44) skips the GlobalShortcuts portal's BindShortcuts
// when every id it wants is already listed, and xdg-desktop-portal-kde 6.7.4+
// no longer arms listed shortcuts at CreateSession. patches/linux/
// fix_quick_entry_kde_portal_rebind.nim injects js/kde_global_shortcuts_rebind.js
// at the bundle head: a second portal session from the main process that
// binds the stored ids on every launch, through a minimal D-Bus client.
//
// This harness runs the compiled patch on a bundle-head fixture (marker,
// idempotency, syntax), checks the D-Bus wire codec on the exact signatures
// the portal uses, then drives the module against a FAKE portal: a unix
// socket server speaking enough of the D-Bus protocol (EXTERNAL auth, Hello,
// AddMatch, Properties.Get, CreateSession / ListShortcuts / BindShortcuts
// with Request/Response signals) to observe the controller: no bind while
// nothing is listed, exactly one bind with the returning ids once something
// is, a ShortcutsChanged re-list, and session close on unregisterAll.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_BIN = join(ROOT, "patches", "linux", "fix_quick_entry_kde_portal_rebind");
const MODULE_JS = readFileSync(join(ROOT, "js", "kde_global_shortcuts_rebind.js"), "utf8");
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
async function waitFor(pred, ms = 5000, step = 25) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(step); }
  return pred();
}

try {
  accessSync(PATCH_BIN, constants.X_OK);
} catch {
  console.log(`SKIP: patch binary not compiled: ${PATCH_BIN} (cd patches && make)`);
  process.exit(SKIP_EXIT);
}

const work = mkdtempSync(join(tmpdir(), "cdb-kde-rebind-"));
const logLines = [];
let server = null;
try {
  section("patch application");
  const fixture = join(work, "index.js");
  writeFileSync(fixture, `"use strict";var upstream=1;`);
  const run = () => spawnSync(PATCH_BIN, [fixture], { encoding: "utf8" });
  let r = run();
  check("first run exits 0", r.status, 0);
  let patched = readFileSync(fixture, "utf8");
  check("marker present once", patched.split("__CDB_KDE_GS_REBIND__").length - 1, 1);
  check("module lands after the directive", patched.startsWith(`"use strict";\n// __CDB_KDE_GS_REBIND__`), true);
  check("upstream code kept", patched.endsWith("var upstream=1;"), true);
  r = run();
  check("second run exits 0", r.status, 0);
  check("second run is a no-op", readFileSync(fixture, "utf8") === patched, true);
  check("second run reports idempotent", r.stdout.includes("already present (idempotent)"), true);
  check("patched fixture passes node --check", spawnSync(process.execPath, ["--check", fixture]).status, 0);
  const prepended = join(work, "index2.js");
  writeFileSync(prepended, `var first=1;`);
  check("no directive: prepended, exits 0", spawnSync(PATCH_BIN, [prepended]).status, 0);
  check("no directive: marker first", readFileSync(prepended, "utf8").startsWith("\n// __CDB_KDE_GS_REBIND__"), true);

  // -------------------------------------------------------------- module
  // A realm with a fake electron.globalShortcut and the node builtins the
  // module needs. The hook is installed explicitly to keep ordering visible.
  const nodeRequire = createRequire(import.meta.url);
  const gsCalls = [];
  const fakeGlobalShortcut = {
    register(acc) { gsCalls.push("register:" + acc); return true; },
    unregister(acc) { gsCalls.push("unregister:" + acc); },
    unregisterAll() { gsCalls.push("unregisterAll"); },
  };
  const sockPath = join(work, "bus");
  const env = Object.assign({}, process.env, {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + sockPath,
    XDG_SESSION_TYPE: "wayland",
    XDG_CURRENT_DESKTOP: "KDE",
    CDB_KDE_GS_REBIND: "1",
    CDB_KDE_GS_REBIND_NO_HOOK: "1",
  });
  delete env.CDB_KDE_GS_REBIND_DISABLED;
  const ctx = {
    Buffer, setTimeout, clearTimeout, Promise, console,
    process: { platform: "linux", env, pid: process.pid, versions: { chrome: "152.0.7977.149" } },
    require: (name) => (name === "electron" ? { globalShortcut: fakeGlobalShortcut } : nodeRequire(name)),
  };
  ctx.globalThis = ctx;
  ctx.__cdbDiag = (line) => { logLines.push(String(line)); };
  vm.runInNewContext(MODULE_JS, ctx);
  const api = ctx.__cdbKdeGsRebind;
  check("module exports its api", typeof api?.hook, "function");

  section("wire codec");
  const { Writer, Reader, sigNodes, buildMessage, parseMessage, parseAddress } = api._wire;
  check("parseAddress unix:path", parseAddress("unix:path=/run/user/1000/bus"), "/run/user/1000/bus");
  check("parseAddress abstract", parseAddress("unix:abstract=/tmp/dbus-abc,guid=1"), "\0/tmp/dbus-abc");
  check("parseAddress tcp rejected", parseAddress("tcp:host=127.0.0.1,port=1"), null);
  const sig = "oa(sa{sv})sa{sv}";
  const body = ["/sess", [["id1", { description: ["s", "Claude shortcut"], preferred_trigger: ["s", "CTRL+ALT+space"] }], ["id2", {}]], "", { handle_token: ["s", "tok"], n: ["u", 42], b: ["b", true], big: ["t", 7] }];
  const msg = buildMessage({ type: 1, serial: 9, path: "/p", iface: "a.b", member: "M", dest: "d", signature: sig, body });
  const headerLen = (16 + msg.readUInt32LE(12) + 7) & ~7;
  const parsed = parseMessage(msg, headerLen);
  check("header round trip", [parsed.type, parsed.serial, parsed.path, parsed.iface, parsed.member, parsed.dest, parsed.signature].join("|"), "1|9|/p|a.b|M|d|" + sig);
  check("body round trip", JSON.stringify(parsed.body, (k, v) => (typeof v === "bigint" ? "big:" + v : v)),
    JSON.stringify(["/sess", [["id1", { description: "Claude shortcut", preferred_trigger: "CTRL+ALT+space" }], ["id2", {}]], "", { handle_token: "tok", n: 42, b: true, big: "big:7" }]));
  check("body length header matches", msg.readUInt32LE(4), msg.length - headerLen);
  check("header padded to 8", headerLen % 8, 0);
  const w = new Writer(); w.value(sigNodes("(yqiuxd)")[0], [255, 65535, -5, 4294967295, -9007199254740991n, 1.5]);
  const rd = new Reader(w.bytes(), 0);
  check("numeric types", JSON.stringify(rd.value(sigNodes("(yqiuxd)")[0]), (k, v) => (typeof v === "bigint" ? String(v) : v)), JSON.stringify([255, 65535, -5, 4294967295, "-9007199254740991", 1.5]));

  // --------------------------------------------------------- fake portal
  // One D-Bus peer: the daemon (Hello/AddMatch) and the portal
  // (org.freedesktop.portal.Desktop) answer on the same connection.
  const portal = { listed: [], bindCalls: [], createCalls: 0, listCalls: 0, versionCalls: 0, conns: 0, open: 0, lastSession: null, emitChanged: null, noKeyIds: [] };
  const PORTAL_PATH = "/org/freedesktop/portal/desktop";
  server = createServer((sock) => {
    portal.conns++; portal.open++;
    sock.on("close", () => { portal.open--; });
    let authed = false, authBuf = "", rx = Buffer.alloc(0), serial = 1, unique = ":1." + (40 + portal.conns);
    const send = (m) => sock.write(buildMessage(Object.assign({ serial: serial++ }, m)));
    const reply = (req, signature, body) => send({ type: 2, replySerial: req.serial, dest: unique, signature, body });
    const signal = (path, iface, member, signature, body) => send({ type: 4, path, iface, member, dest: unique, signature, body });
    const respond = (req, results) => {
      const token = req.body[req.body.length - 1].handle_token;
      const reqPath = PORTAL_PATH + "/request/" + unique.replace(/^:/, "").replace(/\./g, "_") + "/" + token;
      reply(req, "o", [reqPath]);
      setTimeout(() => signal(reqPath, "org.freedesktop.portal.Request", "Response", "ua{sv}", [0, results]), 5);
    };
    portal.emitChanged = () => { if (portal.lastSession) signal(PORTAL_PATH, "org.freedesktop.portal.GlobalShortcuts", "ShortcutsChanged", "oa(sa{sv})", [portal.lastSession, []]); };
    sock.on("data", (chunk) => {
      if (!authed) {
        authBuf += chunk.toString("latin1");
        if (authBuf.includes("AUTH EXTERNAL") && !authBuf.includes("BEGIN")) { if (!authBuf.includes("\r\n")) return; sock.write("OK 0123456789abcdef0123456789abcdef\r\n"); }
        const b = authBuf.indexOf("BEGIN\r\n");
        if (b < 0) return;
        authed = true;
        chunk = Buffer.from(authBuf.slice(b + 7), "latin1");
        if (!chunk.length) return;
      }
      rx = Buffer.concat([rx, chunk]);
      for (;;) {
        if (rx.length < 16) return;
        const bodyLen = rx.readUInt32LE(4), hl = (16 + rx.readUInt32LE(12) + 7) & ~7;
        if (rx.length < hl + bodyLen) return;
        const m = parseMessage(rx.subarray(0, hl + bodyLen), hl);
        rx = rx.subarray(hl + bodyLen);
        if (m.member === "Hello") reply(m, "s", [unique]);
        else if (m.member === "AddMatch") reply(m, "", []);
        else if (m.member === "Get" && m.body[0] === "org.freedesktop.portal.GlobalShortcuts") { portal.versionCalls++; reply(m, "v", [["u", 2]]); }
        else if (m.member === "CreateSession") {
          portal.createCalls++;
          const sess = PORTAL_PATH + "/session/" + unique.replace(/^:/, "").replace(/\./g, "_") + "/" + m.body[0].session_handle_token;
          portal.lastSession = sess;
          respond(m, { session_handle: ["s", sess] });
        } else if (m.member === "ListShortcuts") {
          portal.listCalls++;
          respond(m, { shortcuts: ["a(sa{sv})", portal.listed.map(([id, d]) => [id, { description: ["s", d], trigger_description: ["s", "Ctrl+Alt+Space"] }])] });
        } else if (m.member === "BindShortcuts") {
          portal.bindCalls.push({ session: m.body[0], shortcuts: m.body[1], parent: m.body[2] });
          // KDE omits trigger_description for an id it stores without a key.
          respond(m, { shortcuts: ["a(sa{sv})", m.body[1].map(([id, p]) => [id, Object.assign({ description: ["s", p.description || ""] }, portal.noKeyIds.includes(id) ? {} : { trigger_description: ["s", "Ctrl+Alt+Space"] })])] });
        } else send({ type: 3, replySerial: m.serial, dest: unique, errorName: "org.freedesktop.DBus.Error.UnknownMethod", signature: "s", body: ["no " + m.member] });
      }
    });
  });
  await new Promise((res) => server.listen(sockPath, res));

  section("controller against the fake portal");
  // Fast backoff for the test: the controller reads these constants once.
  api.state.accelerators = {};
  check("hook installs", api.hook(), true);
  check("register passes through", fakeGlobalShortcut.register("Ctrl+Alt+Space", () => {}), true);
  check("register reached upstream", gsCalls.includes("register:Ctrl+Alt+Space"), true);
  check("accelerator tracked", api.state.accelerators["Ctrl+Alt+Space"], true);
  // The gate probes kwin_wayland; replace it with a passing gate for the harness.
  api.state.gate = Promise.resolve(null);
  api.attempt("test");
  check("session opened + listed once", await waitFor(() => portal.listCalls >= 1 && portal.createCalls === 1, 4000), true);
  await sleep(100);
  check("nothing listed -> no bind", portal.bindCalls.length, 0);
  check("retry scheduled while nothing is listed", api.state.attempt >= 1, true);
  check("version read", portal.versionCalls, 1);

  // KDE's dialog was accepted "later": the stored id now shows up.
  portal.listed = [["58B0DA136EB2D18BF43E4B840B70C859-Ctrl+Alt+Space", "Claude shortcut: Ctrl+Alt+Space"]];
  check("listed id gets bound", await waitFor(() => portal.bindCalls.length === 1, 8000), true);
  const bind = portal.bindCalls[0];
  check("bind uses the same session", bind.session, portal.lastSession);
  check("bind sends the returning id", bind.shortcuts.map((s) => s[0]).join(), "58B0DA136EB2D18BF43E4B840B70C859-Ctrl+Alt+Space");
  check("bind passes the description through", bind.shortcuts[0][1].description, "Claude shortcut: Ctrl+Alt+Space");
  check("bind has no preferred trigger", "preferred_trigger" in bind.shortcuts[0][1], false);
  check("bind sends an empty parent window", bind.parent, "");
  // The line is written after the BindShortcuts reply resolves, so it can land a tick
  // after the bind call itself: wait for it instead of reading the log synchronously.
  check("armed line logged", await waitFor(() => logLines.some((l) => /kde-rebind: armed 1 stored shortcut/.test(l)), 4000), true);
  check("connection stays open after the bind", portal.open, 1);
  check("one portal connection in total", portal.conns, 1);

  // Same id set again (e.g. a second register call): list, but no second bind.
  const listsBefore = portal.listCalls;
  fakeGlobalShortcut.register("Ctrl+Alt+Space", () => {});
  check("re-register re-lists", await waitFor(() => portal.listCalls > listsBefore, 4000), true);
  await sleep(150);
  check("unchanged id set -> still one bind", portal.bindCalls.length, 1);

  // ShortcutsChanged with a new stored id (the user changed the hotkey in Settings).
  portal.listed.push(["AAAA-Ctrl+Shift+Space", "Claude shortcut: Ctrl+Shift+Space"]);
  portal.emitChanged();
  check("ShortcutsChanged -> bind with both ids", await waitFor(() => portal.bindCalls.length === 2, 4000), true);
  check("second bind carries both ids", portal.bindCalls[1].shortcuts.length, 2);

  // An id KDE stores WITHOUT a key (bind dialog dismissed): the bind succeeds
  // but the log must say the hotkey cannot fire, naming the id.
  portal.noKeyIds = ["BBBB-Ctrl+Alt+Space"];
  portal.listed.push(["BBBB-Ctrl+Alt+Space", "Claude shortcut: Ctrl+Alt+Space"]);
  portal.emitChanged();
  check("ShortcutsChanged -> third bind", await waitFor(() => portal.bindCalls.length === 3, 4000), true);
  check("no-key id named in the log", await waitFor(() => logLines.some((l) => /armed 3 stored shortcut\(s\).*BBBB-Ctrl\+Alt\+Space \(no key assigned - set one in System Settings > Shortcuts > Claude\)/.test(l)), 2000), true);
  check("keyed ids still logged by their key", logLines.some((l) => /armed 3 stored shortcut\(s\) for this session: Ctrl\+Alt\+Space, Ctrl\+Alt\+Space, BBBB/.test(l)), true);

  // Upstream drops its shortcuts: our session must go away with them.
  fakeGlobalShortcut.unregisterAll();
  check("unregisterAll reached upstream", gsCalls.includes("unregisterAll"), true);
  check("session closed after unregisterAll", await waitFor(() => portal.open === 0 && api.state.session === null, 4000), true);
  check("close logged", logLines.some((l) => /closing the re-bind session/.test(l)), true);

  section("gates");
  const gates = [
    [{ XDG_SESSION_TYPE: "x11" }, "not a Wayland session"],
    [{ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" }, "not KDE (XDG_CURRENT_DESKTOP=GNOME)"],
    [{ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE", CDB_KDE_GS_REBIND: "0" }, "disabled by CDB_KDE_GS_REBIND=0"],
  ];
  for (const [vars, expected] of gates) {
    const c2 = { Buffer, setTimeout, clearTimeout, Promise, console, require: ctx.require,
      process: { platform: "linux", env: Object.assign({}, env, vars), pid: 1, versions: { chrome: "152.0.0.0" } } };
    c2.globalThis = c2;
    vm.runInNewContext(MODULE_JS, c2);
    check("gate: " + expected, await c2.__cdbKdeGsRebind.gate(), expected);
  }
  const c4 = { Buffer, setTimeout, clearTimeout, Promise, console, require: ctx.require,
    process: { platform: "linux", env: Object.assign({}, env), pid: 1, argv: ["claude", "--ozone-platform=x11"], versions: { chrome: "152.0.0.0" } } };
  c4.globalThis = c4;
  vm.runInNewContext(MODULE_JS, c4);
  check("gate: XWayland launch", await c4.__cdbKdeGsRebind.gate(), "XWayland launch (X11 key grabs, no portal)");
  const c3 = { Buffer, setTimeout, clearTimeout, Promise, console, require: ctx.require,
    process: { platform: "linux", env: Object.assign({}, env), pid: 1, versions: { chrome: "159.0.1.2" } } };
  c3.globalThis = c3;
  vm.runInNewContext(MODULE_JS, c3);
  check("gate: Chromium 159 binds itself", await c3.__cdbKdeGsRebind.gate(), "Chromium 159 binds per session itself");
} finally {
  if (server) await new Promise((res) => server.close(res));
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed: " + failures.join(", "));
  console.log("Log lines:\n  " + logLines.join("\n  "));
  process.exit(1);
}
