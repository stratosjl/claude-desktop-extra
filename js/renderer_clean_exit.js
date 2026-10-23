/* Let an uninitiated renderer clean-exit of the main view reach the reload path.
 *
 * Upstream's main-webview render-process-gone handler runs every death through
 * a reason filter that drops `clean-exit` unconditionally (and `killed` while
 * the app quits). On Linux the main view's renderer can exit with reason
 * clean-exit / exitCode 0 on its own (issue #287: niri Wayland, 10-16 Code
 * sessions open, every day or two). The handler then returns before the reload
 * path, the window stays blank, Ctrl+R and F5 have no renderer left to receive
 * them, and only a full restart - which ends every Code session - recovers.
 *
 * fix_renderer_clean_exit_reload.nim inlines this expression in front of
 * upstream's filter as
 *   globalThis.__cdbCleanExitRecoverable ||= (<this>)
 * and asks it only in the filter's clean-exit term:
 *   !(details.reason==="clean-exit" && !__cdbCleanExitRecoverable(details, isQuitting) || ...)
 * A `true` lets the event continue into upstream's own path: the 300 ms grace
 * it gives a `killed` renderer (the patch widens it to clean-exit, so a view
 * destroyed or an app quitting within that time is still dropped), its log
 * line, its telemetry, its 3-reloads-per-5-minutes cap and its setImmediate
 * reload.
 *
 * Arguments: details = Electron's RenderProcessGoneDetails, isQuitting =
 * upstream's own quitting predicate (true from before-quit on, so app quit,
 * relaunch, Reset App Data and the 1P/3P switch all count as app-initiated).
 *
 * Returns true only when ALL of these hold:
 *   - details.reason === "clean-exit" (every other reason keeps upstream's verdict),
 *   - process.platform is linux,
 *   - the app is not quitting,
 *   - fewer than 3 clean-exit reloads were handed on in the last 10 minutes
 *     (a renderer that exits cleanly in a loop falls back to upstream behavior:
 *     suppressed, no reload spin).
 * One [cdb-renderer] line per decision goes to claude-patches.log via __cdbDiag.
 * The timestamps live in globalThis.__cdbCleanExitReloads so DevTools can
 * inspect or reset them.
 * Comments are block comments only: the expression is inlined into a minified
 * line, where a // comment would swallow the code after it.
 */
(function () {
  /*__cdb_clean_exit_reload_v1__*/
  var MAX_RELOADS = 3;
  var WINDOW_MS = 10 * 60 * 1000;
  function log(msg) {
    try {
      (globalThis.__cdbDiag || console.log)("[cdb-renderer] " + msg);
    } catch (_) {}
  }
  return function (details, isQuitting) {
    if (!details || details.reason !== "clean-exit") return false;
    if (process.platform !== "linux") return false;
    var tag = "main view clean-exit (exitCode " + details.exitCode + ")";
    var quitting = false;
    try {
      quitting = typeof isQuitting === "function" && !!isQuitting();
    } catch (_) {}
    if (quitting) {
      log(tag + ": app is quitting, leaving it suppressed");
      return false;
    }
    var reloads = (globalThis.__cdbCleanExitReloads = globalThis.__cdbCleanExitReloads || []);
    var now = Date.now();
    while (reloads.length && now - reloads[0] > WINDOW_MS) reloads.shift();
    if (reloads.length >= MAX_RELOADS) {
      log(
        tag + ": " + reloads.length + " reloads in the last " + WINDOW_MS / 60000 +
          " min, leaving it suppressed (upstream behavior)"
      );
      return false;
    }
    reloads.push(now);
    log(
      tag + ": not app-initiated, handing it to the reload path (" + reloads.length + "/" +
        MAX_RELOADS + " in " + WINDOW_MS / 60000 + " min)"
    );
    return true;
  };
})()
