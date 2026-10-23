# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Reload the main view after a renderer clean-exit the app did not ask for
# (issue #287).
#
# Upstream's main-webview `render-process-gone` handler (v3.1623.0, same shape
# in v2.42304.2) is
#
#   e.on("render-process-gone",(async(t,n)=>{if(h$n(e),!B$n(n))return;
#     let r=s(),c=w$n(e),l=j1n(),u=KEn();
#     if(n.reason==="killed"&&(await new Promise((e=>setTimeout(e,j$n))),
#        e.isDestroyed()||Nj())||e.isDestroyed())return;
#     P.info("Main webview render process gone: %o",n); ...telemetry...
#     ...3 reloads per 5 min cap... M1n(e) /* setImmediate(reload) */ ...
#
# and its reason filter is
#
#   function B$n(e){return I$n()?((e.reason==="killed"||e.reason==="crashed")&&R$n(),!1)
#                   :!(e.reason==="clean-exit"||e.reason==="killed"&&Nj())}
#
# where I$n() is the "we crashed it ourselves" latch (counted up only by the
# unresponsive path right before forcefullyCrashRenderer) and Nj=()=>Oj||kj||Aj
# is upstream's own quitting predicate (kj is set by the before-quit / will-quit
# interceptor, Aj once cleanup is done, Oj while an update installs). So a
# `clean-exit` is dropped unconditionally; our fix_renderer_gone_suppressed_log
# is what writes the "(suppressed)" line for it.
#
# On Linux the main view's renderer can exit with reason clean-exit / exitCode 0
# on its own (niri Wayland, 10-16 Code sessions open, every day or two). The
# window stays blank, Ctrl+R / F5 have no renderer left to receive them, and
# only a full restart - which ends every Code session - recovers. A real crash
# (`crashed`, exit code 132) takes the reload path and recovers on its own.
#
# Two sub-patches, neither touching the handler head that
# fix_renderer_gone_suppressed_log rewrites (the two compose in either order):
#
#   A. the filter: js/renderer_clean_exit.js is inlined in front of it as
#      `globalThis.__cdbCleanExitRecoverable||=(...)`, and its clean-exit term
#      becomes `e.reason==="clean-exit"&&!globalThis.__cdbCleanExitRecoverable(e,Nj)`.
#      The helper returns true only for a clean-exit on Linux while upstream's
#      own Nj() says the app is not quitting (quit, relaunch, Reset App Data and
#      the 1P/3P switch all go through app.quit, so they count as app-initiated),
#      at most 3 times per 10 minutes; otherwise upstream's verdict stands. The
#      I$n() branch (forcefullyCrashRenderer reports crashed/killed) is untouched.
#   B. the grace: upstream waits 300 ms after a `killed` and drops the event if
#      the WebContents is destroyed or the app is quitting by then. The condition
#      becomes `(n.reason==="killed"||n.reason==="clean-exit")&&(await ...)`, so a
#      view being torn down, or a quit whose before-quit lands a moment after the
#      renderer exit, is still dropped (and logged by the suppressed-log patch).
#
# A `true` continues into upstream's own path: its log line, telemetry, reload
# cap and setImmediate reload. One [cdb-renderer] line per decision lands in
# claude-patches.log.
#
# Preconditions asserted (fail loud, Rule 4): the filter with the unconditional
# clean-exit drop exists exactly once, the `killed` grace exists exactly once
# and consults the same quitting predicate, the handler that owns the grace
# calls that filter, and the predicate is defined as a zero-arg arrow over the
# quit flags. If upstream starts reloading after a clean-exit itself, sub-patch
# A finds no unconditional drop and this patch is removed.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 2 # A filter, B grace

const HELPER_JS = staticRead("../../js/renderer_clean_exit.js")

# Bumped whenever the helper's shape changes, so idempotency asserts THIS
# version's injected end-state rather than "something of ours is present".
const MARKER = "__cdb_clean_exit_reload_v1__"

# Minified identifiers may contain `$`, which is a regex metacharacter.
proc rxEscape(name: string): string =
  name.replace("$", "\\$")

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # ── B's anchor first: it names the details var and the quitting predicate ─
  # the main handler uses, which A cross-checks against the filter.
  #   groups: 0 details, 1 promise param, 2 resolve, 3 delay const, 4 wc, 5 quitting
  let graceRe = re2(
    """([\w$]+)\.reason===["`]killed["`]&&\(await new Promise\(\(([\w$]+)=>setTimeout\(""" &
      """([\w$]+),([\w$]+)\)\)\),([\w$]+)\.isDestroyed\(\)\|\|([\w$]+)\(\)\)"""
  )
  let graceDoneRe = re2(
    """\(([\w$]+)\.reason===["`]killed["`]\|\|([\w$]+)\.reason===["`]clean-exit["`]\)&&""" &
      """\(await new Promise\(\(([\w$]+)=>setTimeout\(([\w$]+),([\w$]+)\)\)\),([\w$]+)""" &
      """\.isDestroyed\(\)\|\|([\w$]+)\(\)\)"""
  )
  var graceMatches: seq[RegexMatch2] = @[]
  for m in result.findAll(graceRe):
    graceMatches.add m
  var graceDone: seq[RegexMatch2] = @[]
  for m in result.findAll(graceDoneRe):
    graceDone.add m
  var details, quitFn: string
  var graceState: string
  if graceDone.len == 1 and graceMatches.len == 0:
    details = result[graceDone[0].group(0)]
    quitFn = result[graceDone[0].group(6)]
    if result[graceDone[0].group(1)] != details:
      echo "  [FAIL] B: widened grace matched but its details identifiers differ; re-audit"
      quit(1)
    graceState = "done"
  elif graceDone.len == 0 and graceMatches.len == 1:
    details = result[graceMatches[0].group(0)]
    quitFn = result[graceMatches[0].group(5)]
    if result[graceMatches[0].group(1)] != result[graceMatches[0].group(2)]:
      echo "  [FAIL] B: `killed` grace matched but its promise identifiers differ; re-audit"
      quit(1)
    graceState = "pending"
  else:
    echo &"  [FAIL] B: `killed` grace found {graceMatches.len} time(s) and widened grace " &
      &"{graceDone.len} time(s); expected exactly one of them once (the main-view " &
      "handler changed shape; re-audit)"
    quit(1)

  # The quitting predicate must still be a zero-arg arrow over the quit flags.
  let quitRe = re2("(?:var |[,;])" & rxEscape(quitFn) & """=\(\)=>[\w$]+\|\|[\w$]+""")
  if result.findAll(quitRe).len < 1:
    echo &"  [FAIL] quitting predicate {quitFn} is not a zero-arg arrow over the quit " &
      "flags anymore; re-audit what the handler's `killed` grace consults"
    quit(1)

  # ── A: the reason filter ─────────────────────────────────────────────────
  #   groups: 0 filterFn, 1 param, 2 latch, 3..4 param, 5 push, 6..7 param, 8 quitting
  let filterRe = re2(
    """function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\)\?\(\(([\w$]+)\.reason===""" &
      """["`]killed["`]\|\|([\w$]+)\.reason===["`]crashed["`]\)&&([\w$]+)\(\),!1\):!\(""" &
      """([\w$]+)\.reason===["`]clean-exit["`]\|\|([\w$]+)\.reason===["`]killed["`]&&""" &
      """([\w$]+)\(\)\)\}"""
  )
  let filterDoneRe = re2(
    """["`]clean-exit["`]&&!globalThis\.__cdbCleanExitRecoverable\(([\w$]+),([\w$]+)\)\|\|""" &
      """[\w$]+\.reason===["`]killed["`]&&[\w$]+\(\)\)\}"""
  )
  let helperDoneRe = re2"""globalThis\.__cdbCleanExitRecoverable\|\|=\("""
  var filterMatches: seq[RegexMatch2] = @[]
  for m in result.findAll(filterRe):
    filterMatches.add m
  let filterDoneCount = result.findAll(filterDoneRe).len
  let helperCount = result.findAll(helperDoneRe).len
  let markerCount = result.count(MARKER)
  var filterFn: string
  if filterDoneCount == 1 and helperCount == 1 and markerCount == 1 and
      filterMatches.len == 0:
    echo "  [OK] A: clean-exit term already consults __cdbCleanExitRecoverable (" &
      MARKER & ")"
    patchesApplied += 1
    # Recover the filter name from the patched shape for the handler cross-check.
    let nameRe = re2(
      """function ([\w$]+)\(([\w$]+)\)\{return [\w$]+\(\)\?\(\([\w$]+\.reason===["`]killed["`]""" &
        """\|\|[\w$]+\.reason===["`]crashed["`]\)&&[\w$]+\(\),!1\):!\([\w$]+\.reason===""" &
        """["`]clean-exit["`]&&!globalThis\.__cdbCleanExitRecoverable\("""
    )
    var nm: seq[RegexMatch2] = @[]
    for m in result.findAll(nameRe):
      nm.add m
    if nm.len != 1:
      echo "  [FAIL] A: patched filter present but its function head is not recognizable"
      quit(1)
    filterFn = result[nm[0].group(0)]
  elif filterDoneCount == 0 and helperCount == 0 and markerCount == 0 and
      filterMatches.len == 1:
    let m = filterMatches[0]
    filterFn = result[m.group(0)]
    let param = result[m.group(1)]
    let filterQuit = result[m.group(8)]
    for g in [3, 4, 6, 7]:
      if result[m.group(g)] != param:
        echo &"  [FAIL] A: filter {filterFn} matched but its parameter is used inconsistently; re-audit"
        quit(1)
    if filterQuit != quitFn:
      echo &"  [FAIL] A: filter {filterFn} consults {filterQuit} while the handler's grace " &
        &"consults {quitFn}; expected one quitting predicate; re-audit"
      quit(1)
    let matched = result[m.boundaries]
    let ce = matched.find("clean-exit")
    if ce < 0:
      echo "  [FAIL] internal: clean-exit literal missing from the matched filter"
      quit(1)
    let insertAt = ce + "clean-exit".len + 1 # after the closing quote
    let injected =
      "globalThis.__cdbCleanExitRecoverable||=(" & HELPER_JS.strip() & ");" &
      matched[0 ..< insertAt] & "&&!globalThis.__cdbCleanExitRecoverable(" & param & "," &
      quitFn & ")" & matched[insertAt .. ^1]
    result = result[0 ..< m.boundaries.a] & injected & result[m.boundaries.b + 1 .. ^1]
    if result.findAll(filterDoneRe).len != 1 or result.findAll(helperDoneRe).len != 1 or
        result.count(MARKER) != 1:
      echo "  [FAIL] A: injection did not land (patched filter, helper or " & MARKER &
        " absent)"
      quit(1)
    echo &"  [OK] A: clean-exit term of {filterFn} now consults __cdbCleanExitRecoverable " &
      &"(quitting={quitFn})"
    patchesApplied += 1
  else:
    echo &"  [FAIL] A: reason filter with the unconditional clean-exit drop found " &
      &"{filterMatches.len} time(s), patched term {filterDoneCount}, helper {helperCount}, " &
      &"marker {markerCount}; expected 1/0/0/0 (pristine) or 0/1/1/1 (applied). If " &
      "upstream now reloads after a clean-exit, this patch is absorbed: remove it (Rule 4)"
    quit(1)

  # The handler that owns the grace must be the one consulting this filter.
  let callRe = re2("!" & rxEscape(filterFn) & """\(""" & rxEscape(details) & """\)\)""")
  if result.findAll(callRe).len < 1:
    echo &"  [FAIL] no `!{filterFn}({details}))` guard found: the grace and the filter " &
      "belong to different handlers; re-audit"
    quit(1)

  # ── B: widen the `killed` grace to clean-exit ────────────────────────────
  if graceState == "done":
    echo "  [OK] B: 300 ms grace already covers clean-exit (idempotent)"
    patchesApplied += 1
  else:
    # Re-locate: A's injection sits before the handler, so the offsets captured
    # above are stale once A has run.
    var fresh: seq[RegexMatch2] = @[]
    for m in result.findAll(graceRe):
      fresh.add m
    if fresh.len != 1:
      echo &"  [FAIL] B: `killed` grace found {fresh.len} time(s) after A, expected 1"
      quit(1)
    let m = fresh[0]
    let matched = result[m.boundaries]
    let killedEnd = matched.find("&&(await")
    if killedEnd < 0:
      echo "  [FAIL] internal: grace slice marker missing"
      quit(1)
    let injected =
      "(" & matched[0 ..< killedEnd] & "||" & details & ".reason===\"clean-exit\")" &
      matched[killedEnd .. ^1]
    result = result[0 ..< m.boundaries.a] & injected & result[m.boundaries.b + 1 .. ^1]
    if result.findAll(graceDoneRe).len != 1 or result.findAll(graceRe).len != 0:
      echo "  [FAIL] B: widened grace did not land"
      quit(1)
    echo &"  [OK] B: 300 ms grace now covers clean-exit (details={details} quitting={quitFn})"
    patchesApplied += 1

  if patchesApplied < EXPECTED_PATCHES:
    echo &"  [FAIL] Only {patchesApplied}/{EXPECTED_PATCHES} patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_renderer_clean_exit_reload <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_renderer_clean_exit_reload ==="
  echo &"  Target: {filePath}"
  if not fileExists(filePath):
    echo &"  [FAIL] File not found: {filePath}"
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Renderer clean-exit reload: 2/2 patches applied"
  else:
    echo "  [PASS] No changes needed (already applied)"
