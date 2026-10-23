#!/usr/bin/env node
/*
 * test-theme-dom-ready-scope.mjs - which pages does the theme engine paint? (GitHub #284)
 *
 * patches/core/add_feature_custom_themes.nim hooks app "web-contents-created" and, on
 * every "dom-ready", injects the active theme's sheet. It used to do that for EVERY
 * webContents except devtools, localhost dev servers and the picker page, so the Code
 * tab's browser pane (an arbitrary third-party site) came up wearing the user's theme.
 * The hook now themes a page only when its URL is one of the app's own documents:
 *   - origin https://claude.ai, https://preview.claude.ai, https://claude.com,
 *     https://preview.claude.com (the 1P main view)
 *   - app://localhost (3P; its opaque origin "null" is normalised to protocol + host)
 *   - a file: URL inside app.asar/.vite/renderer/ (Quick Entry, find-in-page, buddy, ...)
 *
 * The engine really runs (electron shimmed, fake webContents recording insertCSS and
 * executeJavaScript). For each URL the suite fires web-contents-created + dom-ready with
 * a theme active and checks two independent signals: insertCSS was called, and the
 * engine logged "Injected CSS+JS into <url>". It then switches the theme live through
 * __cdbThemes.apply() and checks that the switch reaches exactly the themed pages.
 *
 * Control: the same engine with the hook's guard swapped back to the old skip list
 * (string substitution on the built module, the two lines quoted from git history).
 * It must theme https://github.com/ - proof that the fixture reproduces #284 and that
 * the guard, not something incidental, is what fixes it.
 *
 * Usage: node scripts/tests/core/test-theme-dom-ready-scope.mjs   (exit 3 = SKIP, 1 = FAIL)
 */
import { installEngine, mkWc, settle, reporter, runSuite } from "../lib/theme-engine-harness.mjs";

const V = (bg) => ({ "--bg-000": bg, "--accent-brand": "0 100% 50%" });
const CONFIG = {
  activeTheme: "harness-a",
  themeWatch: false,
  themes: {
    "harness-a": { name: "Harness A", light: V("0 0% 99%"), dark: V("0 0% 3%") },
    "harness-b": { name: "Harness B", light: V("0 0% 95%"), dark: V("0 0% 7%") },
  },
};

const ASAR = "file:///usr/lib/claude-desktop/resources/app.asar/.vite/renderer/";
const THEMED = [
  "https://claude.ai/new",
  "https://preview.claude.ai/x",
  "https://claude.com/",
  "https://preview.claude.com/",
  "app://localhost/new",
  "app://localhost/setup-desktop-3p",
  ASAR + "main_window/index.html",
  ASAR + "quick_window/quick-window.html",
  ASAR + "find_in_page/find-in-page.html",
  ASAR + "buddy_window/buddy.html",
  // AppImage: the same tree under a FUSE mount point
  "file:///tmp/.mount_X/usr/lib/claude-desktop/resources/app.asar/.vite/renderer/main_window/index.html",
];
const NOT_THEMED = [
  "https://github.com/",
  "https://sso.example.com/realms/x/protocol/openid-connect/auth",
  "http://localhost:3000/",
  "http://127.0.0.1:5173/",
  "https://localhost/",
  "devtools://devtools/bundled/x.html",
  "cowork-file://preview/test.pdf",
  "about:blank",
  "data:text/html,hi",
  "file:///home/x/page.html",
  "file:///home/x/.config/Claude/cdb-theme-picker/picker.html",
  "https://claude.ai.evil.com/",
  "https://support.claude.com/",
  "app://localhost:1234/",
  "",
];

// The hook's guard before #284, quoted from git history (add_feature_custom_themes.nim).
const NEW_GUARD = "if(!__cdb_themable(url)){__cdb_wcKeys.delete(wc);return}";
const OLD_GUARD =
  'if(url.indexOf("devtools://")===0)return;\n' +
  'if(url.indexOf("http://localhost")===0||url.indexOf("http://127.0.0.1")===0||url.indexOf("https://localhost")===0)return;';

const injectedLog = (diag, url) => diag.some((m) => m === "[CustomThemes] Injected CSS+JS into " + url);

/** A fake webContents whose URL can change, so navigation away can be simulated. */
function mkNavWc(url) {
  const wc = mkWc(url);
  wc.url = url;
  wc.getURL = () => wc.url;
  return wc;
}

function open(appEvents, url) {
  const wc = mkNavWc(url);
  appEvents["web-contents-created"]({}, wc);
  wc.fire("dom-ready");
  return wc;
}

await runSuite(async () => {
  const r = reporter("Theme engine: dom-ready injection is scoped to the app's own pages (#284)");

  // ------------------------------------------------------------------ [1] patched engine
  const { themes: T, appEvents, diag } = installEngine({ config: CONFIG });
  r.ok(T.active() === "harness-a", "engine booted with the harness theme active", T.active());
  const wcs = new Map();
  for (const url of [...THEMED, ...NOT_THEMED]) wcs.set(url, open(appEvents, url));
  await settle();

  r.section("[1] app pages get the theme at dom-ready");
  for (const url of THEMED) {
    const wc = wcs.get(url);
    r.ok(wc.css.length === 1 && injectedLog(diag, url), "themed: " + url,
      "insertCSS x" + wc.css.length + ", log " + injectedLog(diag, url));
  }

  r.section("[2] everything else is left alone");
  for (const url of NOT_THEMED) {
    const wc = wcs.get(url);
    r.ok(wc.css.length === 0 && wc.js.length === 0 && !injectedLog(diag, url),
      "not themed: " + (url === "" ? '"" (empty URL)' : url),
      "insertCSS x" + wc.css.length + ", executeJavaScript x" + wc.js.length + ", log " + injectedLog(diag, url));
  }

  r.section("[3] a live switch reaches the themed pages and only those");
  const before = new Map([...wcs].map(([u, wc]) => [u, wc.css.length]));
  const res = T.apply("harness-b");
  await settle();
  r.ok(!res || res.ok !== false, "apply(harness-b) succeeded", res && JSON.stringify(res));
  for (const url of THEMED) {
    const wc = wcs.get(url);
    r.ok(wc.css.length > before.get(url) && wc.removedKeys.length >= 1,
      "re-styled on switch: " + url, "insertCSS x" + wc.css.length + ", removed " + wc.removedKeys.length);
  }
  const reached = NOT_THEMED.filter((u) => wcs.get(u).css.length || wcs.get(u).js.length || wcs.get(u).win.bg.length);
  r.ok(reached.length === 0, "no skipped page is touched by the switch (css, js or window background)",
    reached.join(", "));

  // A page opened AFTER the switch picks up the current theme, and a third-party one still does not.
  const late = open(appEvents, "https://claude.ai/late");
  const lateGh = open(appEvents, "https://github.com/late");
  await settle();
  r.ok(late.css.length === 1 && late.css[0] === wcs.get(THEMED[0]).sheet(),
    "a claude.ai page opened after the switch gets the current sheet");
  r.ok(lateGh.css.length === 0, "a github.com page opened after the switch gets nothing");

  r.section("[4] a themed webContents that navigates to a third-party site");
  // The guard runs per dom-ready, so the new document gets no sheet, and insertCSS is
  // per-document, so the old sheet went with the old page. The guard also drops the
  // webContents from the engine's live set, so a later theme switch must not reach it.
  const nav = open(appEvents, "https://claude.ai/nav");
  await settle();
  r.ok(nav.css.length === 1, "the claude.ai document is themed first", "insertCSS x" + nav.css.length);
  nav.url = "https://github.com/login";
  nav.fire("dom-ready");
  await settle();
  const snap = () => [nav.css.length, nav.js.length, nav.win.bg.length].join("/");
  const atNav = snap();
  r.ok(nav.css.length === 1, "the third-party document is not themed at its dom-ready", "insertCSS x" + nav.css.length);
  T.apply("harness-a");
  await settle();
  r.ok(snap() === atNav,
    "a live switch does not reach it (no insertCSS, executeJavaScript or setBackgroundColor)",
    "css/js/bg " + atNav + " -> " + snap());
  // Navigating back to the app's own page puts it back under the engine.
  nav.url = "https://claude.ai/back";
  nav.fire("dom-ready");
  await settle();
  const back = nav.css.length;
  r.ok(back === 2, "back on claude.ai it is themed again at dom-ready", "insertCSS x" + back);
  T.apply("harness-b");
  await settle();
  r.ok(nav.css.length === 3, "and a live switch reaches it again", "insertCSS x" + nav.css.length);

  // ------------------------------------------------------------------ [5] control
  r.section("[5] control: the old skip list (devtools / localhost / picker only)");
  const old = installEngine({
    config: CONFIG,
    transform: (src) => src.split(NEW_GUARD).join(OLD_GUARD),
  });
  const oldGh = open(old.appEvents, "https://github.com/");
  const oldLocal = open(old.appEvents, "http://localhost:3000/");
  const oldMain = open(old.appEvents, "https://claude.ai/new");
  await settle();
  r.ok(oldGh.css.length === 1 && injectedLog(old.diag, "https://github.com/"),
    "the old guard themes https://github.com/ (#284 reproduced)");
  r.ok(oldLocal.css.length === 0, "the old guard skips http://localhost:3000/ (control engine is sane)");
  r.ok(oldMain.css.length === 1, "the old guard themes https://claude.ai/new (control engine is sane)");

  r.done();
});
