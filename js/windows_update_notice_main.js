/*
 * windows_update_notice_main.js - "a newer Windows build is out" for the
 * Windows build. Appended to .vite/build/index.pre.js by
 * patches/windows/add_windows_update_notice.nim, which only the Windows build
 * applies (scripts/windows/build-windows.sh).
 *
 * The Windows build is portable: build-windows.sh drops Anthropic's Squirrel
 * updater, so nothing tells a user that a newer windows-v<version> release of
 * this build exists. This module does that, and only that:
 *
 *   - 60 s after the app is ready, then every 12 hours, it reads this fork's
 *     GitHub releases (RELEASES_URL) and takes the highest windows-vX.Y.Z tag
 *     that is neither a draft nor a prerelease.
 *   - When that version is above app.getVersion() (the Anthropic version the
 *     build is made from, which is also its tag), it shows one dialog; "Open
 *     download page" opens the release page in the browser. It asks once per
 *     version: the version is recorded in
 *     <userData>\claude-desktop-extra-update.json whatever the answer.
 *   - It never downloads or installs anything.
 *
 * A dialog, not a toast: Windows shows an app's toasts only when its Start
 * Menu shortcut carries the app's AppUserModelID, and Install-ClaudeExtra.ps1's
 * shortcuts carry none.
 *
 * Off: CDB_UPDATE_NOTICE=0 in the environment. Logs go to claude-patches.log
 * with the [win-update] tag (__cdbDiag, from windows_profiles_main.js).
 */
;/*__CDB_WIN_UPDATE__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "win32") return;
  if (globalThis.__cdbWinUpdate) return;

  var _electron = require("electron");
  var _app = _electron.app;
  var _fs = require("fs");
  var _path = require("path");

  var REPO = "stratosjl/claude-desktop-extra";
  var RELEASES_URL = "https://api.github.com/repos/" + REPO + "/releases?per_page=30";
  var PAGE_PREFIX = "https://github.com/" + REPO + "/releases/";
  var FIRST_CHECK_MS = 60 * 1000;
  var INTERVAL_MS = 12 * 60 * 60 * 1000;
  var TIMEOUT_MS = 15 * 1000;
  var TAG_RE = /^windows-v(\d+)\.(\d+)\.(\d+)$/;

  function log(m) { (globalThis.__cdbDiag || function () {})("[win-update] " + m); }

  function parseVersion(v) {
    var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function compare(a, b) {
    for (var i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  // The newest published windows-v release as {v, tag, url}, or null. A release
  // whose page is not on this repo is skipped: its URL is what "Open download
  // page" opens.
  function newestRelease(list) {
    var best = null;
    (Array.isArray(list) ? list : []).forEach(function (r) {
      if (!r || r.draft || r.prerelease || typeof r.tag_name !== "string") return;
      var m = TAG_RE.exec(r.tag_name);
      if (!m) return;
      if (typeof r.html_url !== "string" || r.html_url.indexOf(PAGE_PREFIX) !== 0) return;
      var v = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!best || compare(v, best.v) > 0) best = { v: v, tag: r.tag_name, url: r.html_url };
    });
    return best;
  }

  function statePath() { return _path.join(_app.getPath("userData"), "claude-desktop-extra-update.json"); }
  function notifiedVersion() {
    try {
      var s = JSON.parse(_fs.readFileSync(statePath(), "utf8").replace(/^﻿/, ""));
      return s && typeof s.notified === "string" ? s.notified : "";
    } catch (e) { return ""; }
  }
  function recordNotified(v) {
    try { _fs.writeFileSync(statePath(), JSON.stringify({ notified: v }) + "\n"); }
    catch (e) { log("could not record the notice: " + (e && e.message ? e.message : String(e))); }
  }

  function fetchReleases() {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    return _electron.net.fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  var busy = false;
  function check() {
    if (busy) return Promise.resolve();
    busy = true;
    var installed = String(_app.getVersion());
    return fetchReleases().then(function (list) {
      var cur = parseVersion(installed);
      var n = newestRelease(list);
      if (!cur) { log("installed version " + installed + " is not X.Y.Z; not comparing"); return; }
      if (!n) { log("no windows-v release found"); return; }
      if (compare(n.v, cur) <= 0) { log("up to date (" + installed + "; newest release " + n.tag + ")"); return; }
      var ver = n.v.join(".");
      if (notifiedVersion() === ver) { log(n.tag + " is available; already shown once"); return; }
      recordNotified(ver);
      log(n.tag + " is available (installed " + installed + "): asking");
      return _electron.dialog.showMessageBox({
        type: "info",
        title: "Claude Desktop Extra",
        message: "Claude Desktop Extra " + ver + " for Windows is available",
        detail: "You have " + installed + ". Download the new build from its release page, unzip it and " +
          "run Install.cmd: it replaces the app and keeps your profiles and settings.",
        buttons: ["Open download page", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }).then(function (res) {
        if (res && res.response === 0) return _electron.shell.openExternal(n.url);
      });
    }).catch(function (e) {
      log("check failed: " + (e && e.message ? e.message : String(e)));
    }).then(function () { busy = false; });
  }

  globalThis.__cdbWinUpdate = { check: check };

  _app.whenReady().then(function () {
    if (process.env.CDB_UPDATE_NOTICE === "0") { log("off (CDB_UPDATE_NOTICE=0)"); return; }
    log("armed: checks " + REPO + " releases 60 s after start, then every 12 h");
    var first = setTimeout(function () {
      check();
      var every = setInterval(check, INTERVAL_MS);
      if (every && every.unref) every.unref();
    }, FIRST_CHECK_MS);
    if (first && first.unref) first.unref();
  });
})();
