/* __CDB_POPOUT_FRAMES__
 * Main-process half of patches/linux/fix_popout_menus_wayland.nim (#280).
 *
 * On native Wayland (the launcher's --ozone-platform=wayland), injects
 * js/popout_frames_page.js (embedded as a string in place of the PAGE_SRC
 * placeholder) into the main view on every dom-ready, so the main view's
 * requestAnimationFrame keeps advancing the popped-out session windows' menus
 * while the main window sits on a hidden workspace. See the page script for
 * the mechanism. X11 and XWayland sessions are left untouched: there the
 * compositor does not withhold frames this way.
 *
 * CDB_POPOUT_RAF_SHIM=0 disables the injection (triage escape hatch).
 * Diagnostics go to claude-patches.log via globalThis.__cdbDiag.
 */
(function () {
  var _electron = require("electron");
  var PAGE_SRC = "__CDB_PF_PAGE_SRC__";
  var queued = [];
  var log = function (m) {
    var d = globalThis.__cdbDiag;
    if (typeof d === "function") d("[popout-frames] " + m);
    else queued.push(m);
  };
  // __cdbDiag only exists once upstream's "ready" handler has run.
  _electron.app.whenReady().then(function () {
    setTimeout(function () {
      var d = globalThis.__cdbDiag;
      if (typeof d !== "function") return;
      queued.splice(0).forEach(function (m) { d("[popout-frames] " + m); });
    }, 3000);
  });

  if (process.env.CDB_POPOUT_RAF_SHIM === "0") {
    log("disabled by CDB_POPOUT_RAF_SHIM=0");
    return;
  }
  if (_electron.app.commandLine.getSwitchValue("ozone-platform") !== "wayland") {
    log("not a native Wayland session - frame fallback not installed");
    return;
  }

  var isMainView = function (url) {
    if (/^https:\/\/claude\.ai\//.test(url)) return true;
    // 3P mode serves the same app from app://localhost; the setup wizard on
    // that origin is a different page and opens no session windows.
    if (/^app:\/\/localhost\//.test(url) && !/^app:\/\/localhost\/setup-desktop-3p(?:[\/?#]|$)/.test(url)) return true;
    return false;
  };
  var announced = Object.create(null);

  _electron.app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        var url = wc.getURL() || "";
        if (!isMainView(url)) return;
        wc.executeJavaScript(PAGE_SRC).then(
          function (r) {
            if (announced[url]) return;
            announced[url] = true;
            log("frame fallback installed in " + url + " (" + r + ")");
          },
          function (e) { log("injection failed in " + url + ": " + (e && e.message)); }
        );
      } catch (e) {
        log("dom-ready error: " + e.message);
      }
    });
  });
})();
