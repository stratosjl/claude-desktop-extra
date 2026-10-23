# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Stop the app raising itself when it gains focus without a raise
# (focus-follows-mouse on KWin, Cinnamon, ...; anthropics/claude-code#75905).
#
# Upstream moves keyboard focus into the window's WebContentsView from the
# window's `focus` event: the main window through its focus helper
# (`(<flag>?<win>.webContents:<view>).focus()`), popouts through
# `<win>.on("focus",()=>{<view>.isDestroyed()||<view>.focus()})`. On Linux,
# Electron's WebContents::Focus() first calls `owner_window()->Focus(true)`,
# i.e. `Widget::Activate()`, which has no "already active" check: on Wayland it
# sends an xdg_activation token + `activate`, on X11 `_NET_ACTIVE_WINDOW`, and
# the window manager treats both as a raise request. With focus-follows-mouse
# the WM focuses the window on pointer entry WITHOUT raising it, the `focus`
# event fires, and the app re-activates (raises) itself on every hover.
#
# Three sub-patches:
#   0. `__cdbFocusNoRaise(win, contents)` helper, injected after "use strict".
#      Off Linux, or when the window is not already active, it is a plain
#      `contents.focus()`. When the window is already active it skips the call
#      if the view already holds focus (Chromium restores the last focused view
#      on activation), and otherwise re-checks once after the activation
#      settles before falling back to the stock call.
#      Startup: the window maps without focus (KWin answers the launch
#      activation with "not-granted"), and upstream's initial focus call runs
#      before the view has loaded, so the view never holds focus and the first
#      focus-follows-mouse activation would take the raising fallback. The
#      helper therefore focuses the view once more 500 ms after its first load,
#      while the window is still visible and inactive. That activation request
#      carries no input serial and is denied like the launch one (no raise), but
#      the view's focus is stored and restored on the first hover. It is skipped
#      once the window has been active, because a request then could carry a
#      valid serial and be granted.
#   A. The main window's focus helper calls it instead of `.focus()`.
#   B. The popout window's `focus` handler calls it instead of `.focus()`.
#
# Scope is deliberately limited to calls made from `focus` handlers. Every
# other activation path (tray "Show App", second-instance, notifications,
# teach-mode restore) keeps stock Electron behaviour: those run while the
# window is NOT active and must raise it (issue #233, fix_dock_bounce.nim).

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 3

# Bumped whenever the helper's shape changes, so idempotency asserts THIS
# version's end-state rather than "some helper is present".
const HELPER_MARKER = "__cdb_focusnoraise_v1__"

const FOCUS_NO_RAISE_HELPER =
  """;(function(){
/*""" & HELPER_MARKER &
  """*/
var _last="",_lastAt=0;
function _log(m){
var n=Date.now();
if(m===_last&&n-_lastAt<1000)return;
_last=m;_lastAt=n;
try{(globalThis.__cdbDiag||function(){})("[focus-no-raise] "+m)}catch(_){}
}
globalThis.__cdbFocusNoRaise=function(w,c){
if(!c||c.isDestroyed())return;
if(process.platform!=="linux"||!w||w.isDestroyed())return c.focus();
if(!w.isFocused()){
if(!c.__cdbFnrPre){
c.__cdbFnrPre=1;
c.once("did-finish-load",function(){
setTimeout(function(){
if(c.__cdbFnrPre!==1||c.isDestroyed()||w.isDestroyed()||w.isFocused()||!w.isVisible())return;
c.__cdbFnrPre=2;
c.focus();
_log("prefocus after first load: view focused="+c.isFocused());
},500);
});
}
return c.focus();
}
c.__cdbFnrPre=2;
if(c.isFocused()){_log("skip: window already active, view already focused");return;}
_log("defer: window already active, view not focused yet");
setTimeout(function(){
if(c.isDestroyed()||w.isDestroyed()||!w.isFocused())return;
if(c.isFocused()){_log("skip: view focus restored after activation");return;}
_log("fallback: webContents.focus() (re-activates the window)");
c.focus();
},0);
};
})();"""

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # ── 0. Helper ──────────────────────────────────────────────────────────────
  if HELPER_MARKER in result:
    echo "  [INFO] focus-no-raise helper already injected (" & HELPER_MARKER & ")"
    patchesApplied += 1
  elif "__cdbFocusNoRaise=" in result:
    echo "  [FAIL] Input carries a different __cdbFocusNoRaise helper version."
    echo "         Re-extract a clean bundle."
  elif result.startsWith("\"use strict\";"):
    result =
      "\"use strict\";" & FOCUS_NO_RAISE_HELPER & result[len("\"use strict\";") .. ^1]
    echo "  [OK] focus-no-raise helper injected after \"use strict\""
    patchesApplied += 1
  else:
    result = FOCUS_NO_RAISE_HELPER & result
    echo "  [OK] focus-no-raise helper prepended"
    patchesApplied += 1

  # ── A. Main window focus helper ────────────────────────────────────────────
  # v3.1623.3:
  #   y=()=>{let e=p.webContents;!e||e.isDestroyed()||((To?l.webContents:e).focus(),...
  # Groups (0-based): 0 and 1 = view contents (guard), 2 = flag, 3 = window,
  # 4 = view contents (ternary else). 0, 1 and 4 must name the same variable.
  let mainDone =
    re2"!([\w$]+)\|\|[\w$]+\.isDestroyed\(\)\|\|\(__cdbFocusNoRaise\([\w$]+,[\w$]+\?[\w$]+\.webContents:[\w$]+\),"
  if result.contains(mainDone):
    echo "  [INFO] main window focus helper already rewritten"
    patchesApplied += 1
  else:
    let mainPat =
      re2"!([\w$]+)\|\|([\w$]+)\.isDestroyed\(\)\|\|\(\(([\w$]+)\?([\w$]+)\.webContents:([\w$]+)\)\.focus\(\),"
    var count = 0
    result = result.replace(
      mainPat,
      proc(m: RegexMatch2, s: string): string =
        let v = s[m.group(0)]
        if s[m.group(1)] != v or s[m.group(4)] != v:
          return s[m.boundaries]
        inc count
        &"!{v}||{v}.isDestroyed()||(__cdbFocusNoRaise({s[m.group(3)]},{s[m.group(2)]}?{s[m.group(3)]}.webContents:{v}),",
    )
    if count == 1:
      echo "  [OK] main window focus helper rewritten (1 match)"
      patchesApplied += 1
    else:
      echo &"  [FAIL] main window focus helper: {count} matches, expected 1"

  # ── B. Popout window focus handler ─────────────────────────────────────────
  # v3.1623.3:
  #   c.on("focus",(()=>{n.isDestroyed()||n.focus()}))
  # Groups (0-based): 0 = window, 1 = contents (guard), 2 = contents (call);
  # 1 and 2 must name the same variable.
  let popoutDone =
    re2"[\w$]+\.on\(""focus"",\(\(\)=>\{[\w$]+\.isDestroyed\(\)\|\|__cdbFocusNoRaise\([\w$]+,[\w$]+\)\}"
  if result.contains(popoutDone):
    echo "  [INFO] popout focus handler already rewritten"
    patchesApplied += 1
  else:
    let popoutPat =
      re2"([\w$]+)\.on\(""focus"",\(\(\)=>\{([\w$]+)\.isDestroyed\(\)\|\|([\w$]+)\.focus\(\)\}"
    var count = 0
    result = result.replace(
      popoutPat,
      proc(m: RegexMatch2, s: string): string =
        let w = s[m.group(0)]
        let c = s[m.group(1)]
        if s[m.group(2)] != c:
          return s[m.boundaries]
        inc count
        &"{w}.on(\"focus\",(()=>{{{c}.isDestroyed()||__cdbFocusNoRaise({w},{c})}}",
    )
    if count == 1:
      echo "  [OK] popout focus handler rewritten (1 match)"
      patchesApplied += 1
    else:
      echo &"  [FAIL] popout focus handler: {count} matches, expected 1"

  if patchesApplied < EXPECTED_PATCHES:
    raise newException(
      ValueError,
      &"fix_focus_follows_mouse_raise: Only {patchesApplied}/{EXPECTED_PATCHES} patches applied",
    )

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_focus_follows_mouse_raise <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_focus_follows_mouse_raise ==="
  echo &"  Target: {file}"
  if not fileExists(file):
    echo &"  [FAIL] File not found: {file}"
    quit(1)
  let input = readFile(file)
  let output = apply(input)
  if output != input:
    writeFile(file, output)
    echo "  [PASS] Patches applied"
  else:
    echo "  [PASS] No changes needed (already patched)"
