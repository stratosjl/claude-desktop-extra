# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# "Developer tools" switch in Settings -> Extra -> Community Features.
#
# Upstream gates DevTools (Ctrl+Alt+I, the "Toggle Dev Tools" menu entry) on
# its own opt-in file <userData>/developer_settings.json ({"allowDevTools":
# true}), re-read on every shortcut press, with no UI to set it. This injects
# js/dev_tools_toggle_main.js at the head of the main bundle: the cdb-dt:*
# IPC pair the Extra page's row (js/extra_settings_page.js, bridged by
# js/extra_settings_bridge.js) reads and writes that file through. Nothing of
# upstream's gate is changed - an org workspace with developer mode disabled
# still gets no DevTools.
#
# Break risk: VERY LOW - no regex on minified app code, only the bundle-head
# anchor and standard Electron/Node APIs.

import std/[os, strutils, strformat]

const MAIN_JS = staticRead("../../js/dev_tools_toggle_main.js")
const MARKER = "__CDB_DEV_TOOLS_TOGGLE__"
const EXPECTED_PATCHES = 1 # the main-process module

proc apply(content: string): string =
  result = content
  let present = result.count(MARKER)
  if present == 1:
    echo "  [OK] dev tools toggle: module already present (idempotent)"
    return
  if present != 0:
    echo &"  [FAIL] dev tools toggle: marker found {present} times - re-audit"
    quit(1)
  # Same head anchor as fix_cowork_font: after the directive when it is still
  # first in the staged bundle, otherwise prepended (an earlier patch in
  # basename order may already own the head).
  let strictPrefix = "\"use strict\";"
  let injection = "\n" & MAIN_JS & "\n"
  if result.startsWith(strictPrefix):
    result = strictPrefix & injection & result[strictPrefix.len .. ^1]
    echo "  [OK] dev tools toggle injected after \"use strict\""
  else:
    result = injection & result
    echo "  [OK] dev tools toggle prepended"
  if result.count(MARKER) != 1:
    echo "  [FAIL] dev tools toggle: module not present exactly once after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_dev_tools_toggle <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_dev_tools_toggle ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo &"  [PASS] All {EXPECTED_PATCHES} patches applied"
