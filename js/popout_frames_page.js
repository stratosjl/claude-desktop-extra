/* __CDB_PF_PAGE__
 * Main-view page script for patches/linux/fix_popout_menus_wayland.nim (#280).
 * Injected with webContents.executeJavaScript() on every main-view dom-ready by
 * js/popout_frames_main.js, on native Wayland only.
 *
 * A popped-out Code session ("Open in new window") is a window.open() child
 * whose React tree runs in THIS realm, the main view's, and is portaled into
 * the child document. Its menus and popovers step through open/close with the
 * main view's requestAnimationFrame. A Wayland compositor sends no frame
 * callbacks to a window on a hidden workspace, and Chromium then produces no
 * frames for it at all (measured: 0 rAF, ResizeObserver stuck, while
 * document.visibilityState stays "visible"), so every popout menu waits on a
 * frame that never comes until the main window is shown again.
 *
 * This wraps requestAnimationFrame so each batch of callbacks runs on the next
 * real frame or, if none arrives within FALLBACK_MS, on a timer. One frame
 * request and one timer per batch, whichever fires first runs the batch once
 * and cancels the other. With frames flowing (~16 ms) the timer never wins, so
 * a visible window behaves exactly as before. A page Chromium knows to be
 * hidden (visibilityState "hidden", e.g. minimized) keeps its native pause:
 * the fallback only stands in for frames withheld from a page that believes it
 * is visible, which is precisely the Wayland case.
 */
(function () {
  var W = window;
  if (W.__cdbPopoutRaf) return "already";
  var FALLBACK_MS = 100;
  var rawRaf = W.requestAnimationFrame.bind(W);
  var rawCaf = W.cancelAnimationFrame.bind(W);
  var pending = new Map(); // id -> callback, the batch waiting for a frame
  var nextId = 1;
  var scheduled = false;
  var frameHandle = 0;
  var timerHandle = 0;
  var stats = (W.__cdbPopoutRaf = { frames: 0, fallbacks: 0 });

  function flush(ts, viaTimer) {
    scheduled = false;
    if (viaTimer) {
      rawCaf(frameHandle);
      stats.fallbacks++;
    } else {
      clearTimeout(timerHandle);
      stats.frames++;
    }
    var batch = pending;
    pending = new Map();
    batch.forEach(function (cb) {
      try {
        cb(ts);
      } catch (err) {
        // Like a native frame: one throwing callback reports and does not
        // stop the others.
        setTimeout(function () { throw err; }, 0);
      }
    });
  }

  function armTimer() {
    timerHandle = setTimeout(function () {
      if (!scheduled) return;
      if (document.visibilityState !== "visible") {
        // Native pause for a page Chromium knows is hidden; keep checking so a
        // frame-starved page that becomes visible again still advances.
        armTimer();
        return;
      }
      flush(performance.now(), true);
    }, FALLBACK_MS);
  }

  W.requestAnimationFrame = function (cb) {
    if (typeof cb !== "function") return rawRaf(cb);
    var id = nextId++;
    pending.set(id, cb);
    if (!scheduled) {
      scheduled = true;
      frameHandle = rawRaf(function (ts) { flush(ts, false); });
      armTimer();
    }
    return id;
  };
  W.cancelAnimationFrame = function (id) {
    pending.delete(id);
  };
  return "ok";
})();
