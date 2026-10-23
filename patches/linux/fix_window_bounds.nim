# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
# Fix BrowserWindow child view bounds, ready-to-show jiggle, and Quick Entry blur.
# Two patches: bounds fix IIFE injection and Quick Entry blur before hide.
#
# Uses the `regex` package (pure Nim) like the other patches: std/nre dlopens
# PCRE1 at run time, which ubuntu-24.04 (the CI harness runner) does not ship.
# `regex` has no backreferences, so the "same window variable" constraints that
# used to be `\1`/`\2` are a two-stage match (head pins the variable, the full
# pattern is built with it spliced in literally) or an equality check on the
# captured groups.

import std/[os, strformat, strutils]
import regex

const BOUNDS_FIX_JS =
  "(function(__wb_w){" & "if(process.platform!==\"linux\")return;" &
  "var __wb_fcb=function(){" & "if(__wb_w.isDestroyed())return;" &
  "var __wb_cv=__wb_w.contentView;" &
  "if(!__wb_cv||!__wb_cv.children||!__wb_cv.children.length)return;" &
  "var __wb_cs=__wb_w.getContentSize(),__wb_cw=__wb_cs[0],__wb_ch=__wb_cs[1];" &
  "if(__wb_cw<=0||__wb_ch<=0)return;" & "var __wb_cb=__wb_cv.children[0].getBounds();" &
  "if(__wb_cb.width!==__wb_cw||__wb_cb.height!==__wb_ch)" &
  "__wb_cv.children[0].setBounds({x:0,y:0,width:__wb_cw,height:__wb_ch})" & "};" &
  "var __wb_fasc=function(){__wb_fcb();setTimeout(__wb_fcb,16);setTimeout(__wb_fcb,150)};" &
  "[\"maximize\",\"unmaximize\",\"enter-full-screen\",\"leave-full-screen\"]" &
  ".forEach(function(__wb_ev){__wb_w.on(__wb_ev,__wb_fasc)});" & "var __wb_lsz=[0,0];" &
  "__wb_w.on(\"moved\",function(){" & "if(__wb_w.isDestroyed())return;" &
  "var __wb_s=__wb_w.getSize();" & "if(__wb_s[0]!==__wb_lsz[0]||__wb_s[1]!==__wb_lsz[1])" &
  "{__wb_lsz=__wb_s;__wb_fasc()}" & "});" & "__wb_w.once(\"ready-to-show\",function(){" &
  "var __wb_s=__wb_w.getSize();" & "__wb_w.setSize(__wb_s[0]+1,__wb_s[1]+1);" &
  "setTimeout(function(){" & "if(__wb_w.isDestroyed())return;" &
  "__wb_w.setSize(__wb_s[0],__wb_s[1]);" & "__wb_fasc()" & "},50)" & "})" & "})"

# Main window factory, stage 1: the head that pins the window variable.
# Allow optional code between BrowserWindow() and the setup call (midCode),
# AND between the setup call and the final `,W}` (trailing). v1.15962 added a
# `,Cft(tt)` call after the MAIN_WINDOW setup call which broke the old adjacency anchor.
# v1.19367.0 changed the window variable from a minified local (`it`) to a dotted
# property path (`exports.mainWindow`), so winVar allows `.`-joined segments.
# v1.26832.0 moved the logger-tagging helper and the window-name enum behind chunk
# namespaces (`t.c(J.webContents,t.n.MAIN_WINDOW)`), so the setup call's callee and
# the enum holder are dotted chains too.
# Groups: 0 = prefix, 1 = winVar, 2 = electronVar, 3 = paramVar.
const MAIN_WIN_HEAD =
  re2"(function [\w$]+\([\w$]+\)\{return )([\w$]+(?:\.[\w$]+)*)=new ([\w$]+)\.BrowserWindow\(([\w$]+)\),"

proc mainWinPattern(winVar: string): Regex2 =
  ## Stage 2: the full factory with the window variable spliced in literally
  ## where std/nre used the `\2` backreference. Same groups as the head, plus
  ## 4 = midCode, 5 = setupCall, 6 = trailing.
  let w = escapeRe(winVar)
  re2(
    r"(function [\w$]+\([\w$]+\)\{return )(" & w &
      r")=new ([\w$]+)\.BrowserWindow\(([\w$]+)\),(.*?)([\w$]+(?:\.[\w$]+)*\(" & w &
      r"\.webContents,[\w$]+(?:\.[\w$]+)*\.MAIN_WINDOW\))(.*?)," & w & r"\}"
  )

proc findMainWindowFactory(s: string): (bool, RegexMatch2) =
  ## Leftmost factory head whose full pattern matches at that very position
  ## (what nre's `find` with the backreference returned).
  for head in s.findAll(MAIN_WIN_HEAD):
    var m = RegexMatch2()
    if s.find(mainWinPattern(s[head.group(1)]), m, head.boundaries.a) and
        m.boundaries.a == head.boundaries.a:
      return (true, m)
  (false, default(RegexMatch2))

# Positive end state of Patch 2: the guard function whose single `||` arm blurs
# and then hides the same window. Groups 0 and 1 must be the same variable.
const QE_BLUR_CHECK =
  re2"function [\w$]+\(\)\{[\w$]+\(\)\|\|\(([\w$]+)\.blur\(\),([\w$]+)\.hide\(\)\)\}"

const QE_HIDE_PATTERN =
  re2"(function [\w$]+\(\)\{)([\w$]+\(\))\|\|([\w$]+)(\.hide\(\))\}"

proc apply*(input: string): string =
  result = input
  var applied: seq[string] = @[]

  # 1. Child view bounds fix + ready-to-show jiggle
  let boundsMarker = "__wb_fcb"
  if boundsMarker in result:
    echo "  [INFO] Window bounds fix already injected"
    applied.add("bounds-fix(skip)")
  else:
    let (found, m) = result.findMainWindowFactory()
    if found:
      let prefix = result[m.group(0)]
      let winVar = result[m.group(1)]
      let electronVar = result[m.group(2)]
      let paramVar = result[m.group(3)]
      let midCode = result[m.group(4)]
      let setupCall = result[m.group(5)]
      # trailing: any setup calls between the MAIN_WINDOW call and the final `,W}`.
      # v1.15962 added `,Cft(tt)`; on v1.15200 this is "". Already includes its own
      # leading comma, so it slots in directly after setupCall.
      let trailing = result[m.group(6)]
      let iife = BOUNDS_FIX_JS & "(" & winVar & ")"
      let replacement =
        prefix & winVar & "=new " & electronVar & ".BrowserWindow(" & paramVar & ")," &
        midCode & setupCall & trailing & "," & iife & "," & winVar & "}"
      result =
        result[0 ..< m.boundaries.a] & replacement & result[m.boundaries.b + 1 .. ^1]
      echo "  [OK] Window bounds fix + size jiggle injected: 1 match(es)"
      applied.add("bounds-fix(1)")
    else:
      # Must raise on its own miss - do NOT rely on the `applied.len == 0` guard
      # below, which Patch 2 (Quick Entry blur) independently satisfies, masking a
      # silent Patch 1 miss and shipping broken child-view geometry on Linux.
      echo "  [FAIL] Main window factory pattern not matched"
      raise newException(
        ValueError, "fix_window_bounds: Main window factory pattern not matched"
      )

  # 2. Quick Entry blur before hide
  # Positive end state: the exact shape Patch 2 produces - the guard function
  # whose single `||` arm blurs and then hides the same window.
  var alreadyBlurred = false
  for m in result.findAll(QE_BLUR_CHECK):
    if result[m.group(0)] == result[m.group(1)]:
      alreadyBlurred = true
      break

  if alreadyBlurred:
    echo "  [INFO] Quick Entry blur already applied"
    applied.add("qe-blur(skip)")
  else:
    var countQe = 0
    result = result.replace(
      QE_HIDE_PATTERN,
      proc(m: RegexMatch2, s: string): string =
        inc countQe
        let funcDecl = s[m.group(0)]
        let guardCall = s[m.group(1)]
        let winVar = s[m.group(2)]
        let hideCall = s[m.group(3)]
        funcDecl & guardCall & "||(" & winVar & ".blur()," & winVar & hideCall & ")}",
    )
    if countQe == 1:
      echo &"  [OK] Quick Entry blur before hide: {countQe} match"
      applied.add(&"qe-blur({countQe})")
    else:
      echo &"  [FAIL] Quick Entry hide pattern: {countQe} matches, expected 1"
      raise newException(
        ValueError, "fix_window_bounds: Quick Entry hide pattern not matched"
      )

  if applied.len == 0:
    raise newException(ValueError, "fix_window_bounds: No patches could be applied")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_window_bounds <file>"
    quit(1)
  let file = paramStr(1)
  echo "=== Patch: fix_window_bounds ==="
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
