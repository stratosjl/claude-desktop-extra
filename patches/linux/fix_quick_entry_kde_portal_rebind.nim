# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Quick Entry hotkey survives a restart on KDE Plasma 6.7.4+ (#281).
#
# On native Wayland the bundled Electron (44.x, Chromium 152) registers the
# Quick Entry hotkey through the GlobalShortcuts portal and only calls
# BindShortcuts when one of its ids is not yet listed by the portal.
# xdg-desktop-portal-kde 6.7.4 stopped arming stored shortcuts at
# CreateSession (KDE bug 523063): the first launch binds, KDE asks once, the
# hotkey works; every later launch lists the stored id, skips the bind, and
# the hotkey is dead while System Settings still shows it. Chromium main
# binds per session since 2026-10-15 (CL 8527334); no shipped Electron has it.
#
# js/kde_global_shortcuts_rebind.js, injected at the head of the main bundle,
# hooks electron.globalShortcut.register/unregister and, while a shortcut is
# registered, keeps a second portal session open from the main process (same
# app id) that binds exactly the ids KDE already stores. KDE arms returning
# ids silently and delivers Activated to every session of the app, so the
# upstream listener fires as on a first launch. Gated at run time to Wayland
# + KDE + KWin >= 6.4 + Chromium < 159; CDB_KDE_GS_REBIND=0 turns it off.
#
# Break risk: VERY LOW - no regex on minified app code, only the bundle-head
# anchor and the public electron.globalShortcut API.

import std/[os, strutils, strformat]

const MAIN_JS = staticRead("../../js/kde_global_shortcuts_rebind.js")
const MARKER = "__CDB_KDE_GS_REBIND__"
const EXPECTED_PATCHES = 1 # the main-process module

proc apply(content: string): string =
  result = content
  let present = result.count(MARKER)
  if present == 1:
    echo "  [OK] kde portal rebind: module already present (idempotent)"
    return
  if present != 0:
    echo &"  [FAIL] kde portal rebind: marker found {present} times - re-audit"
    quit(1)
  # Same head anchor as add_feature_dev_tools_toggle: after the directive when
  # it is still first in the staged bundle, otherwise prepended (an earlier
  # patch in basename order may already own the head).
  let strictPrefix = "\"use strict\";"
  let injection = "\n" & MAIN_JS & "\n"
  if result.startsWith(strictPrefix):
    result = strictPrefix & injection & result[strictPrefix.len .. ^1]
    echo "  [OK] kde portal rebind injected after \"use strict\""
  else:
    result = injection & result
    echo "  [OK] kde portal rebind prepended"
  if result.count(MARKER) != 1:
    echo "  [FAIL] kde portal rebind: module not present exactly once after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_quick_entry_kde_portal_rebind <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_quick_entry_kde_portal_rebind ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo &"  [PASS] All {EXPECTED_PATCHES} patches applied"
