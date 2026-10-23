# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Quit backstop: end the process 3 s after Electron's 'quit' if it is still
# alive.
#
# With Electron 44.7.0 (v2.37337.1) a SIGTERM to the whole process group
# (logout, `systemctl stop` on the app's scope, pkill, Ctrl+C) also kills the
# zygotes; every GPU relaunch then fails at once and, with upstream's
# disable-gpu-process-crash-limit switch, is retried forever. 44.7.0 fires app
# 'child-process-gone' per failure, and upstream's handler plus Sentry's
# listeners keep the main thread busy, so Electron never leaves its loop after
# 'quit': app.exit(0), process.exit(0) and upstream's 15 s quit watchdog all do
# nothing, and the process spins until SIGKILL (90 s under systemd). A healthy
# quit is gone well under a second after 'quit', so a timer that still fires
# 3 s later only fires in that stuck state; process.reallyExit(0) (Node's raw
# exit, past Electron's routing) is the one call that still ends it.
#
# Re-check on each Electron bump: SIGTERM the app's process group and time the
# exit. If it exits on its own again, the backstop never fires and can go.

import std/os
import regex

proc apply*(input: string): string =
  let pattern = re2"""([\w$]+)\.app\.on\("will-quit",[\w$]+\("willQuit"\)\),"""
  # Our end state (positive idempotency marker, AGENTS.md Rule 6).
  let marker =
    re2"""\.app\.on\("quit",\(\)=>\{setTimeout\(\(\)=>\{\(globalThis\.__cdbDiag\|\|console\.log\)\("\[quit-backstop\][^"]*"\);process\.reallyExit\(0\)\},3e3\)\}\),"""
  let count = input.findAll(pattern).len
  let done = input.findAll(marker).len
  if done == 1:
    echo "  [OK] quit backstop: already applied (idempotent)"
    return input
  if count != 1 or done != 0:
    echo "  [FAIL] quit backstop: " & $count & " will-quit anchors and " & $done &
      " backstops, expected exactly 1 anchor"
    quit(1)
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      let electronVar = s[m.group(0)]
      s[m.boundaries] & electronVar &
        ".app.on(\"quit\",()=>{setTimeout(()=>{(globalThis.__cdbDiag||console.log)(" &
        "\"[quit-backstop] still alive 3s after quit, process.reallyExit(0)\");" &
        "process.reallyExit(0)},3e3)}),",
  )
  echo "  [OK] quit backstop: 1 match"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_app_quit <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_app_quit ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] App quit backstop patched successfully"
