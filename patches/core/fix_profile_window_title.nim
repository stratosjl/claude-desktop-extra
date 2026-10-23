# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Suffix the main window title with the active profile name when CLAUDE_PROFILE
# is set. "Claude" → "Claude (work)" so users can tell windows apart in
# Alt-Tab, taskbar tooltips, and screenshots without relying on icon shape.
#
# How it works:
#   - The main window is constructed by the unsuffixed-named function
#     `function NAME(arg){return WIN=new ELECTRON.BrowserWindow(arg),...}`.
#   - Since v2.19675.1 upstream drives the main-window title itself: it
#     preventDefaults the window's page-title-updated and calls
#     win.setTitle(composed) on did-navigate, on a debounced claude.ai
#     page-title-updated, and when GrowthBook flag 3052534774 flips.
#   - We inject a tiny comma-expression right after the BrowserWindow
#     construction that, when CLAUDE_PROFILE is set, wraps THIS window's
#     setTitle so every title (ours or upstream's) ends with " (PROFILE)"
#     exactly once and re-applies the current title. Electron's native
#     page-title-updated path bypasses JS setTitle, so the patch also
#     asserts upstream's sync (preventDefault + setTitle) is still there.
#     "Claude" -> "Claude (work)", "My chat - Claude" -> "My chat - Claude (work)".
#
# Default profile (CLAUDE_PROFILE unset) → no listener attached, no behavior
# change.
#
# Break risk: LOW. Targets the standard Electron BrowserWindow API with
# flexible regex on minified variable names.
#
# Uses the `regex` package (pure Nim) like the other patches: std/nre dlopens
# PCRE1 at run time, which ubuntu-24.04 (the CI harness runner) does not ship.
# `regex` has no backreferences: the sync precondition's "same window
# variable" (`\1`, used three times) is a two-stage match (the head pins the
# variable, the full pattern is built with it spliced in literally), the
# "same event param" (`\2`) and the factory's "same argument" are equality
# checks on the captured groups. Its repetition ranges are capped at 100, so
# the lazy 200-char window before `.on("page-title-updated"` is two lazy
# 100-char runs (same language, same shortest-first preference).

import std/[os, strformat, strutils]
import regex

const SENTINEL = "__cdb_titleHook"

# Precondition, stage 1: the head of upstream's main-window title sync, which
# pins the window variable. Groups 0 and 1 must be the same identifier.
const SYNC_HEAD =
  re2"""function [\w$]+\(([\w$]+),[\w$]+\)\{let [\w$]+,[\w$]+,[\w$]+=\(\)=>\{if\(([\w$]+)\.isDestroyed\(\)\)return;"""

proc syncPattern(winVar: string): Regex2 =
  ## Precondition, stage 2: the full sync shape with the window variable
  ## spliced in literally (`win.on("page-title-updated",e=>{e.preventDefault()})`
  ## + a `win.setTitle(...)` driver). Groups: 0 = winVar, 1 = event param,
  ## 2 = event param again (must equal group 1).
  let w = escapeRe(winVar)
  re2(
    r"function [\w$]+\((" & w & r"),[\w$]+\)\{let [\w$]+,[\w$]+,[\w$]+=\(\)=>\{if\(" & w &
      r"\.isDestroyed\(\)\)return;let [\w$]+=[\w$]+\([^;]*;[^}]*" & w &
      r"\.setTitle\([\w$]+\)\)\}[^;]*;?[^\n]{0,100}?[^\n]{0,100}?" & w &
      r"""\.on\(["`]page-title-updated["`],\(?([\w$]+)\)?=>\{?([\w$]+)\.preventDefault\(\)"""
  )

proc countSyncSites(s: string): int =
  ## Non-overlapping sync sites: every head whose full pattern matches at that
  ## very position (what nre's `findIter` with the backreferences counted).
  var next = 0
  for head in s.findAll(SYNC_HEAD):
    if head.boundaries.a < next or s[head.group(0)] != s[head.group(1)]:
      continue
    var m = RegexMatch2()
    if s.find(syncPattern(s[head.group(0)]), m, head.boundaries.a) and
        m.boundaries.a == head.boundaries.a and s[m.group(1)] == s[m.group(2)]:
      inc result
      next = m.boundaries.b + 1

# function NAME(ARG){return WIN=new ELECTRON.BrowserWindow(ARG),
# WIN may be a dotted property path since v1.19367.0 (`exports.mainWindow`).
# Groups: 0 = NAME, 1 = ARG, 2 = WIN, 3 = ELECTRON, 4 = ARG again (must equal
# group 1).
const FACTORY_PATTERN =
  re2"function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+(?:\.[\w$]+)*)=new ([\w$]+)\.BrowserWindow\(([\w$]+)\),"

proc apply*(input: string): string =
  result = input

  if SENTINEL in result:
    echo "  [INFO] Window title hook already applied"
    echo "  [PASS] No changes needed (already patched)"
    return

  # Precondition: upstream's main-window title sync owns the title
  # (`win.on("page-title-updated",e=>{e.preventDefault()})` + a
  # `win.setTitle(...)` driver). Without it Electron applies page titles
  # natively, bypassing our setTitle wrapper, and the suffix would be lost.
  let syncHits = result.countSyncSites()
  if syncHits != 1:
    echo &"  [FAIL] upstream main-window title sync: {syncHits} matches, expected 1"
    raise newException(
      ValueError, "fix_profile_window_title: title sync not found - re-audit"
    )
  echo "  [OK] upstream main-window title sync present (1 match)"

  var hits = 0
  result = result.replace(
    FACTORY_PATTERN,
    proc(m: RegexMatch2, s: string): string =
      let funcName = s[m.group(0)]
      let argName = s[m.group(1)]
      let winVar = s[m.group(2)]
      let electronVar = s[m.group(3)]
      if argName != s[m.group(4)]:
        # Not the `\2` shape: leave the site untouched (nre would not have
        # matched it at all).
        return s[m.boundaries]
      inc hits
      "function " & funcName & "(" & argName & "){return " & winVar & "=new " &
        electronVar & ".BrowserWindow(" & argName & ")," &
        # Profile-aware title injection. Wrapped in a single short-circuit
        # expression so the comma chain still type-checks; evaluates to
        # `false` (no-op) when CLAUDE_PROFILE is unset.
        #
        # Since v2.19675.1 upstream owns the main-window title (it
        # preventDefaults page-title-updated and calls win.setTitle() from
        # did-navigate / a debounced page-title-updated / a GrowthBook
        # listener). A one-shot setTitle would be overwritten, so we wrap
        # THIS window's setTitle: every title, ours or upstream's, gets the
        # suffix exactly once. Other windows keep their own setTitle.
        "process.env.CLAUDE_PROFILE&&((globalThis." & SENTINEL &
        "=true),((__cdb_w,__cdb_s)=>{" & "const __cdb_o=__cdb_w.setTitle.bind(__cdb_w);" &
        "__cdb_w.setTitle=(__cdb_t)=>{__cdb_t=String(__cdb_t??\"\");" &
        "return __cdb_o(__cdb_t.endsWith(__cdb_s)?__cdb_t:__cdb_t+__cdb_s)};" &
        "__cdb_w.setTitle(__cdb_w.getTitle())})(" & winVar &
        ",\" (\"+process.env.CLAUDE_PROFILE+\")\")),",
  )

  if hits == 1:
    echo &"  [OK] Main window title hook injected (function={hits} match)"
  elif hits > 1:
    # Defensive: should be exactly one main-window-construction site. If the
    # pattern starts matching multiple BrowserWindow factories, that's a
    # signal upstream changed shape and we should investigate rather than
    # silently inject into windows that already lock their title.
    echo &"  [FAIL] Expected 1 BrowserWindow construction site, got {hits}"
    raise newException(ValueError, "fix_profile_window_title: ambiguous match")
  else:
    echo "  [FAIL] Main window construction pattern not found"
    raise newException(ValueError, "fix_profile_window_title: 0 matches")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_profile_window_title <file>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: fix_profile_window_title ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Profile window title hook installed"
  # If unchanged, apply() already printed [PASS] for the already-applied case.
