/* "Update available" follows claude-desktop-extra's releases, not Anthropic's apt.
 *
 * Upstream's Linux updater polls Anthropic's apt repo (30 s after start, then
 * hourly) and shows "Update available" whenever that repo has a newer
 * claude-desktop than app.getVersion(). Our users update from OUR packages
 * (pacman repo / AUR, our apt + dnf repos, AppImage, Nix), which trail
 * Anthropic's apt, and our patch releases (v3.1623.1-2) never show up because
 * app.getVersion() only knows 3.1623.1. The SPA's click on the button opens
 * https://code.claude.com/docs/<locale>/desktop-linux#update, which is
 * Anthropic's apt instructions.
 *
 * fix_update_check_own_releases.nim inlines this expression once as
 *   globalThis.__cdbUpdateOwn ||= (<this>);
 * and wires it into upstream's updater:
 *   A. the apt Packages fetcher's body becomes
 *        return globalThis.__cdbUpdateOwn.latestTag(<electron>)
 *      (upstream's 5 s timeout wrapper and its catch -> null stay around it),
 *   B. the poll's semver.gt(remote, app.getVersion()) becomes
 *        globalThis.__cdbUpdateOwn.isNewer(remote, app.getVersion())
 *      and the dangerousMaxVersion cap gets xyz(remote), the tag without -N,
 *   C. upstream's Linux updater init calls hookLinks(<electron>) right before
 *      it starts the poll; that wraps electron.shell.openExternal once (and
 *      latestTag() repeats the idempotent call as a fallback). The SPA's
 *      desktop-linux#update docs URL becomes our README section for the
 *      installed package format; every other URL passes through untouched.
 *      The URL is a constant plus an allowlisted format: nothing from the
 *      network enters it.
 *
 * Installed tag + format come from the build-time stamp
 * <process.resourcesPath>/cdb-release.json = {"tag":"v3.1623.1-2","format":"pacman"},
 * read once. Missing or malformed: tag "v" + app.getVersion(), N = 1, format
 * unknown (link to #quick-install). Nothing here throws into upstream code.
 *
 * Tags compare as (X.Y.Z, N): X.Y.Z numerically, then N, where N defaults to 1
 * ("v3.1623.1" == "v3.1623.1-1" < "v3.1623.1-2" < "v3.1623.3").
 *
 * One [cdb-update] line per decision change (installed tag, remote tag,
 * format, decision) and per fetch-failure change, one per rewritten link.
 * Comments are block comments only: the expression is inlined into a minified
 * line, where a // comment would swallow the code after it.
 */
(function () {
  /*__cdb_update_own_releases_v1__*/
  var API = "https://api.github.com/repos/patrickjaja/claude-desktop-extra/releases/latest";
  var README = "https://github.com/patrickjaja/claude-desktop-extra";
  var FORMATS = ["pacman", "deb", "rpm", "appimage", "nix"];
  var TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;
  var DOCS_RE = /^https:\/\/code\.claude\.com\/docs\/(?:[A-Za-z-]+\/)?desktop-linux#update$/;
  var installedCache = null;
  var electronRef = null;
  var lastDecision = null;
  var lastFetchNote = null;

  function log(msg) {
    try {
      (globalThis.__cdbDiag || function () {})("[cdb-update] " + msg);
    } catch (_) {}
  }

  /* "v3.1623.1-2" / "3.1623.1-2" -> [3, 1623, 1, 2]; anything else -> null */
  function parse(tag) {
    if (typeof tag !== "string") return null;
    var m = TAG_RE.exec(tag.charAt(0) === "v" ? tag : "v" + tag);
    if (!m) return null;
    return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  }

  function cmp(a, b) {
    for (var i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    return 0;
  }

  function installed(appVersion) {
    if (installedCache) return installedCache;
    var tag = null;
    var format = null;
    var source = "app.getVersion()";
    try {
      var path = require("path");
      var raw = require("fs").readFileSync(
        path.join(process.resourcesPath, "cdb-release.json"),
        "utf8"
      );
      var j = JSON.parse(raw);
      if (j && typeof j.tag === "string" && TAG_RE.test(j.tag)) {
        tag = j.tag;
        source = "cdb-release.json";
        if (FORMATS.indexOf(j.format) !== -1) format = j.format;
      }
    } catch (_) {}
    if (tag === null) tag = "v" + appVersion;
    installedCache = { tag: tag, parts: parse(tag), format: format, source: source };
    return installedCache;
  }

  function readmeUrl() {
    var v = "";
    try {
      v = electronRef.app.getVersion();
    } catch (_) {}
    var f = installed(v).format;
    return README + (f ? "#install-" + f : "#quick-install");
  }

  function noteFetch(note) {
    if (note === lastFetchNote) return;
    lastFetchNote = note;
    if (note !== null) log("latest-release check failed: " + note + " (keeping the current state)");
  }

  function hookLinks(electron) {
    if (electron && !electronRef) electronRef = electron;
    if (globalThis.__cdbUpdateLinkHooked) return;
    var shell = electron && electron.shell;
    if (!shell || typeof shell.openExternal !== "function") return;
    var orig = shell.openExternal;
    shell.openExternal = function (url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        if (typeof url === "string" && DOCS_RE.test(url)) {
          args[0] = readmeUrl();
          log("update link " + url + " -> " + args[0]);
        }
      } catch (_) {}
      return orig.apply(this || shell, args);
    };
    globalThis.__cdbUpdateLinkHooked = true;
  }

  return {
    /* Sub-patch C: called from upstream's Linux updater init; idempotent. */
    hookLinks: function (electron) {
      try {
        hookLinks(electron);
      } catch (_) {}
    },
    /* Sub-patch A: our latest release tag without the leading "v", or null. */
    latestTag: async function (electron) {
      try {
        hookLinks(electron);
      } catch (_) {}
      try {
        var res = await electron.net.fetch(API, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res || !res.ok) {
          noteFetch("HTTP " + (res ? res.status : "no response"));
          return null;
        }
        var body = await res.json();
        var tag = body && body.tag_name;
        if (typeof tag !== "string" || !TAG_RE.test(tag)) {
          noteFetch("unexpected tag_name " + JSON.stringify(String(tag).slice(0, 40)));
          return null;
        }
        noteFetch(null);
        return tag.slice(1);
      } catch (e) {
        noteFetch((e && e.message) || String(e));
        return null;
      }
    },
    /* Sub-patch B: is the remote tag newer than the installed package? */
    isNewer: function (remote, appVersion) {
      var decision = false;
      var inst = { tag: "?", parts: null, format: null, source: "?" };
      var rem = null;
      try {
        inst = installed(appVersion);
        rem = parse(remote);
        decision = !!(inst.parts && rem && cmp(rem, inst.parts) > 0);
      } catch (_) {
        decision = false;
      }
      var key = inst.tag + "|" + remote + "|" + inst.format + "|" + decision;
      if (key !== lastDecision) {
        lastDecision = key;
        log(
          "installed " + inst.tag + " (" + inst.source + ", format " + (inst.format || "unknown") +
            "), latest release v" + remote + " -> " +
            (decision ? "update available" : inst.parts ? "up to date" : "installed version unparseable, no update shown")
        );
      }
      return decision;
    },
    /* For upstream's dangerousMaxVersion cap: compare X.Y.Z only. */
    xyz: function (remote) {
      var p = parse(remote);
      return p ? p[0] + "." + p[1] + "." + p[2] : remote;
    },
  };
})()
