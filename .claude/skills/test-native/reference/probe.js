/* Renderer probe template for /test-native (inject via executeJavaScript or
 * paste into DevTools). Logs one `[cdb-probe]` line every 5 s to
 * claude.ai-web.log: real frame cadence, ResizeObserver latency, visibility,
 * focus. Add counters for the shim under test to the line.
 */
(function () {
  var W = window;
  if (W.__cdbProbe) return "already";
  var P = (W.__cdbProbe = { rafGaps: [], lastRaf: performance.now(), roLat: [], roPending: null });
  var rawRaf = W.requestAnimationFrame.bind(W); // bind BEFORE any shim replaces it
  var tick = function () {
    var n = performance.now();
    P.rafGaps.push(Math.round(n - P.lastRaf));
    P.lastRaf = n;
    rawRaf(tick);
  };
  rawRaf(tick);
  var d = document.createElement("div");
  d.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  (document.body || document.documentElement).appendChild(d);
  var w = 1;
  new ResizeObserver(function () {
    if (P.roPending != null) { P.roLat.push(Math.round(performance.now() - P.roPending)); P.roPending = null; }
  }).observe(d);
  setInterval(function () {
    if (P.roPending == null) { w = w === 1 ? 2 : 1; d.style.width = w + "px"; P.roPending = performance.now(); }
  }, 2000);
  setInterval(function () {
    var g = P.rafGaps.splice(0);
    console.warn("[cdb-probe] t=" + Math.round(performance.now() / 1000) +
      " rafN=" + g.length + " rafMax=" + (g.length ? Math.max.apply(null, g) : 0) +
      " sinceLastRaf=" + Math.round(performance.now() - P.lastRaf) +
      " roLat=" + JSON.stringify(P.roLat.splice(0)) +
      " roStuck=" + (P.roPending != null ? Math.round(performance.now() - P.roPending) : 0) +
      " vis=" + document.visibilityState + " focus=" + document.hasFocus());
  }, 5000);
  console.warn("[cdb-probe] installed origin=" + location.origin);
  return "ok";
})();
