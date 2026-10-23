# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Popped-out session windows ("Open in new window"): keeps their menus,
# dropdowns and popovers opening and closing while the main window is on a
# hidden workspace on native Wayland (#280).
#
# A popped-out Code session is an about:blank window.open() child whose React
# tree runs in the MAIN view's JS realm and is portaled into the child
# document. Its menus step through open/close with the main view's
# requestAnimationFrame. A Wayland compositor sends no frame callbacks to a
# window on a hidden workspace (sway; GNOME and KDE throttle the same way) and
# Chromium then produces no frames for that window at all, regardless of
# backgroundThrottling (electron/electron#53814) - measured on sway 1.12 with
# Electron 44.7.0: 0 rAF callbacks and ResizeObserver stuck while the page
# still reports visibilityState "visible". The popout's menu scheduler waits
# on a frame that only arrives once the main window is shown again. XWayland
# does not have the problem.
#
# Injects js/popout_frames_main.js at the head of the main bundle; on native
# Wayland it executes js/popout_frames_page.js in the main view on dom-ready,
# which makes each batch of rAF callbacks run on the next real frame or on a
# 100 ms timer, whichever comes first (see both headers). With frames flowing
# the timer never wins, so a visible main window behaves as before.
#
# The main view is remote claude.ai code (app://localhost in 3P mode), so the
# fix is injected at run time rather than patched into a bundle on disk.
#
# Break risk: VERY LOW - no regex on minified app code, only the bundle-head
# anchor and standard Electron/Node APIs.

import std/[os, strutils, strformat]

const MAIN_JS = staticRead("../../js/popout_frames_main.js")
const PAGE_JS = staticRead("../../js/popout_frames_page.js")
const PLACEHOLDER = "\"__CDB_PF_PAGE_SRC__\""
# One marker per injected module, so a half-injected bundle is a loud failure
# rather than an [OK] backed by a false premise (AGENTS.md Rule 6).
const MARKERS = ["__CDB_POPOUT_FRAMES__", "__CDB_PF_PAGE__"]
const EXPECTED_PATCHES = 2 # main module + embedded page source

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc buildInjection(): string =
  if MAIN_JS.count(PLACEHOLDER) != 1:
    echo "  [FAIL] popout frames: page-source placeholder must occur exactly once in js/popout_frames_main.js"
    quit(1)
  "\n" & MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(PAGE_JS) & "\"") & "\n"

proc countMarkers(s: string): int =
  for m in MARKERS:
    if s.count(m) == 1:
      inc result

proc apply(content: string): string =
  result = content
  let present = countMarkers(result)
  if present == EXPECTED_PATCHES:
    echo "  [OK] popout frames: all modules already present (idempotent)"
    return
  if present != 0:
    echo &"  [FAIL] popout frames: bundle is half-patched ({present}/{EXPECTED_PATCHES} markers) - re-audit"
    quit(1)
  # Same head anchor as fix_cowork_font: after the directive when it is still
  # first in the staged bundle, otherwise prepended (an earlier patch in
  # basename order already owns the head by then).
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & buildInjection() & result[strictPrefix.len .. ^1]
    echo "  [OK] popout frames injected after \"use strict\""
  else:
    result = buildInjection() & result
    echo "  [OK] popout frames prepended"
  let applied = countMarkers(result)
  if applied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {applied}/{EXPECTED_PATCHES} popout-frames modules present exactly once after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_popout_menus_wayland <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_popout_menus_wayland ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo &"  [PASS] All {EXPECTED_PATCHES} patches applied"
