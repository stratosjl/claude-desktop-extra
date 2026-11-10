# @patch-target: app.asar.contents/.vite/build/index.pre.js
# @patch-type: nim
#
# Windows build only (patches/windows/ is applied by
# scripts/windows/build-windows.sh, never by the Linux packages).
#
# Update notice on Windows: append js/windows_update_notice_main.js to
# index.pre.js (package.json's `main`). The build is portable and ships
# without Anthropic's Squirrel updater, so the module tells the user once per
# version when this fork has published a newer windows-v<version> release.
# It only reads the release list and opens the release page on request. See
# the header of the JS file.
#
# Appended, not prefixed: add_windows_profiles.nim keeps the first code of the
# file, and this module only registers an app.whenReady() handler.
#
# Break risk: LOW - no upstream anchor; the module is appended to the file.

import std/[os, strutils]

const NOTICE_JS = staticRead("../../js/windows_update_notice_main.js")
const MARKER = "/*__CDB_WIN_UPDATE__*/"

const EXPECTED_PATCHES = 1 # A (injection)

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # A. Injection. Idempotency: our marker present (positive end-state).
  if MARKER in result:
    echo "  [OK] Windows update notice already present (idempotent)"
    inc patchesApplied
  elif MARKER notin NOTICE_JS:
    echo "  [FAIL] windows_update_notice_main.js lost its marker"
  else:
    result = result & "\n" & NOTICE_JS
    if MARKER in result:
      echo "  [OK] Windows update notice appended to index.pre.js"
      inc patchesApplied
    else:
      echo "  [FAIL] Windows update notice not present after injection"

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_windows_update_notice <path_to_index.pre.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_windows_update_notice ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Windows update notice installed"
  else:
    echo "  [OK] Already applied (no changes needed)"
