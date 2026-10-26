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
# The same filter also drops the death that follows a watchdog kill attempt
# (issue #299). The handler's sibling `unresponsive` watchdog runs
#
#   let l=async t=>{SB(e),q3n(); ...telemetry...
#     e.forcefullyCrashRenderer(),F6n(e),Q("desktop_main_view_hang_kill_wait",u)}
#
# (v3.6556.2 names: q3n() adds one token, J3n() in the filter takes one, CN is
# the quitting predicate). On Linux Electron's forcefullyCrashRenderer() is an
# IPC that asks the renderer to crash itself on its IO thread: a no-op for a
# hung renderer. The view stays frozen, every further "unresponsive" adds a
# token, and when the renderer finally dies (OOM killer, the user's kill) the
# leftover tokens make the filter drop the real `killed` event: no reload, no
# error overlay, a blank window until restart.
#
# Four sub-patches, none touching the handler head that
# fix_renderer_gone_suppressed_log rewrites (the two compose in either order):
#
#   A. the filter's clean-exit term becomes
#      `e.reason==="clean-exit"&&!globalThis.__cdbCleanExitRecoverable(e,CN)`.
#      The helper returns true only for a clean-exit on Linux while upstream's
#      own CN() says the app is not quitting (quit, relaunch, Reset App Data and
#      the 1P/3P switch all go through app.quit, so they count as app-initiated),
#      at most 3 times per 10 minutes; otherwise upstream's verdict stands.
#   B. the grace: upstream waits 300 ms after a `killed` and drops the event if
#      the WebContents is destroyed or the app is quitting by then. The condition
#      becomes `(n.reason==="killed"||n.reason==="clean-exit")&&(await ...)`, so a
#      view being torn down, or a quit whose before-quit lands a moment after the
#      renderer exit, is still dropped (and logged by the suppressed-log patch).
#   C. the filter's token branch `...&&X3n(),!1):` becomes
#      `...&&X3n(),globalThis.__cdbWatchdogKillRecoverable(e,CN)):`. X3n() (the
#      expected-crash-dump note) still runs. The helper returns true on Linux
#      while the app is not quitting (a clean-exit gets A's verdict), so the
#      death takes upstream's own grace, telemetry, 3-per-5-min cap with its
#      error overlay, and reload. No rate limit of our own.
#   D. the watchdog's `e.forcefullyCrashRenderer(),F6n(e)` gains a leading
#      `globalThis.__cdbHungKillEscalate(e),`: on Linux the helper SIGKILLs the
#      renderer pid 5 s later unless the view became responsive, crashed, was
#      destroyed or got a new renderer in between. Electron then reports
#      `killed` and C hands it to the reload path.
#
# js/renderer_clean_exit.js defines the three helpers. It is inlined once, as a
# statement right in front of the filter, in the chunk that also holds the
# watchdog and the handler. One [cdb-renderer] line per decision lands in
# claude-patches.log.
#
# Preconditions asserted (fail loud, Rule 4): the filter with the unconditional
# clean-exit drop and the `!1` token branch exists exactly once, the `killed`
# grace exists exactly once and consults the same quitting predicate, the
# handler that owns the grace calls that filter, the predicate is defined as a
# zero-arg arrow over the quit flags, and the watchdog's
# forcefullyCrashRenderer-then-reload pair exists exactly once. If upstream
# starts reloading after a clean-exit itself, sub-patch A finds no
# unconditional drop and the patch must be re-audited; if upstream escalates
# the watchdog kill on Linux itself, C and D are dropped.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 4
  # A clean-exit term, B grace, C token branch, D SIGKILL fallback

# js/renderer_clean_exit.js must never contain the literal `.forcefullyCrashRenderer(`: D counts that string after the helper is inlined.
const HELPER_JS = staticRead("../../js/renderer_clean_exit.js")

# Bumped whenever the helper's shape changes, so idempotency asserts THIS
# version's injected end-state rather than "something of ours is present".
const MARKER = "__cdb_clean_exit_reload_v2__"

# The three globals the helper installs, as they appear in the inlined source.
const HELPER_DEFS = [
  "globalThis.__cdbCleanExitRecoverable ||= function",
  "globalThis.__cdbWatchdogKillRecoverable ||= function",
  "globalThis.__cdbHungKillEscalate ||= function",
]

# Minified identifiers may contain `$`, which is a regex metacharacter.
proc rxEscape(name: string): string =
  name.replace("$", "\\$")

proc countRe(s: string, r: Regex2): int =
  for _ in s.findAll(r):
    inc result

proc helperState(s: string): tuple[marker: int, defsOk: bool] =
  result.marker = s.count(MARKER)
  result.defsOk = true
  for d in HELPER_DEFS:
    if s.count(d) != 1:
      result.defsOk = false

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # ── B's anchor first: it names the details var and the quitting predicate ─
  # the main handler uses, which A/C cross-check against the filter.
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
  if result.countRe(quitRe) < 1:
    echo &"  [FAIL] quitting predicate {quitFn} is not a zero-arg arrow over the quit " &
      "flags anymore; re-audit what the handler's `killed` grace consults"
    quit(1)

  # ── A + C: the reason filter ─────────────────────────────────────────────
  # Pristine:
  #   function Q3n(e){return J3n()?((e.reason==="killed"||e.reason==="crashed")&&X3n(),!1)
  #                   :!(e.reason==="clean-exit"||e.reason==="killed"&&CN())}
  #   groups: 0 filterFn, 1 param, 2 latch, 3..4 param, 5 push, 6..7 param, 8 quitting
  let filterRe = re2(
    """function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(\)\?\(\(([\w$]+)\.reason===""" &
      """["`]killed["`]\|\|([\w$]+)\.reason===["`]crashed["`]\)&&([\w$]+)\(\),!1\):!\(""" &
      """([\w$]+)\.reason===["`]clean-exit["`]\|\|([\w$]+)\.reason===["`]killed["`]&&""" &
      """([\w$]+)\(\)\)\}"""
  )
  # A's end-state: the clean-exit term consults our helper.
  #   groups: 0 param, 1 quitting
  let aDoneRe = re2(
    """["`]clean-exit["`]&&!globalThis\.__cdbCleanExitRecoverable\(([\w$]+),([\w$]+)\)\|\|""" &
      """[\w$]+\.reason===["`]killed["`]&&[\w$]+\(\)\)\}"""
  )
  # C's end-state: the token branch returns our helper's verdict, X3n() kept.
  #   groups: 0..1 param, 2 push, 3 param, 4 quitting
  let cDoneRe = re2(
    """\(\(([\w$]+)\.reason===["`]killed["`]\|\|([\w$]+)\.reason===["`]crashed["`]\)&&""" &
      """([\w$]+)\(\),globalThis\.__cdbWatchdogKillRecoverable\(([\w$]+),([\w$]+)\)\):!\("""
  )
  # The whole patched filter, to recover its name for the handler cross-check.
  let filterPatchedRe = re2(
    """function ([\w$]+)\(([\w$]+)\)\{return [\w$]+\(\)\?\(\([\w$]+\.reason===["`]killed["`]""" &
      """\|\|[\w$]+\.reason===["`]crashed["`]\)&&[\w$]+\(\),globalThis\.__cdbWatchdogKillRecoverable""" &
      """\([\w$]+,[\w$]+\)\):!\([\w$]+\.reason===["`]clean-exit["`]&&!globalThis\.""" &
      """__cdbCleanExitRecoverable\([\w$]+,[\w$]+\)\|\|[\w$]+\.reason===["`]killed["`]&&""" &
      """[\w$]+\(\)\)\}"""
  )
  var filterMatches: seq[RegexMatch2] = @[]
  for m in result.findAll(filterRe):
    filterMatches.add m
  var aDone: seq[RegexMatch2] = @[]
  for m in result.findAll(aDoneRe):
    aDone.add m
  var cDone: seq[RegexMatch2] = @[]
  for m in result.findAll(cDoneRe):
    cDone.add m
  var patchedMatches: seq[RegexMatch2] = @[]
  for m in result.findAll(filterPatchedRe):
    patchedMatches.add m
  let hs = result.helperState()
  var filterFn: string
  if filterMatches.len == 0 and aDone.len == 1 and cDone.len == 1 and
      patchedMatches.len == 1 and hs.marker == 1 and hs.defsOk:
    filterFn = result[patchedMatches[0].group(0)]
    let param = result[patchedMatches[0].group(1)]
    # A: positive end-state - our helper consulted with this filter's param and
    # the handler's quitting predicate.
    if result[aDone[0].group(0)] != param or result[aDone[0].group(1)] != quitFn:
      echo &"  [FAIL] A: patched clean-exit term of {filterFn} passes " &
        &"({result[aDone[0].group(0)]},{result[aDone[0].group(1)]}), expected ({param},{quitFn}); re-audit"
      quit(1)
    echo "  [OK] A: clean-exit term already consults __cdbCleanExitRecoverable (" &
      MARKER & ")"
    patchesApplied += 1
    for g in [0, 1, 3]:
      if result[cDone[0].group(g)] != param:
        echo &"  [FAIL] C: patched token branch of {filterFn} uses its parameter inconsistently; re-audit"
        quit(1)
    if result[cDone[0].group(4)] != quitFn:
      echo &"  [FAIL] C: patched token branch consults {result[cDone[0].group(4)]}, " &
        &"expected {quitFn}; re-audit"
      quit(1)
    echo "  [OK] C: token branch already returns __cdbWatchdogKillRecoverable (" & MARKER &
      ")"
    patchesApplied += 1
  elif filterMatches.len == 1 and aDone.len == 0 and cDone.len == 0 and
      patchedMatches.len == 0 and hs.marker == 0:
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
    # The helper statement goes in front of a function declaration; anything
    # other than a statement boundary before it means the shape moved.
    if m.boundaries.a > 0 and result[m.boundaries.a - 1] notin {'}', ';', '\n'}:
      echo &"  [FAIL] filter {filterFn} is not preceded by a statement boundary " &
        &"('{result[m.boundaries.a - 1]}'); the helper cannot be inlined in front of it; re-audit"
      quit(1)
    var matched = result[m.boundaries]
    # C: `,!1):` of the token branch -> our helper's verdict.
    const tokenTail = ",!1):!("
    if matched.count(tokenTail) != 1:
      echo "  [FAIL] internal: token branch tail not found once in the matched filter"
      quit(1)
    matched = matched.replace(
      tokenTail,
      ",globalThis.__cdbWatchdogKillRecoverable(" & param & "," & quitFn & ")):!(",
    )
    # A: after the clean-exit literal's closing quote.
    let ce = matched.find("clean-exit")
    if ce < 0:
      echo "  [FAIL] internal: clean-exit literal missing from the matched filter"
      quit(1)
    let insertAt = ce + "clean-exit".len + 1
    matched =
      matched[0 ..< insertAt] & "&&!globalThis.__cdbCleanExitRecoverable(" & param & "," &
      quitFn & ")" & matched[insertAt .. ^1]
    let injected = ";" & HELPER_JS.strip() & ";" & matched
    result = result[0 ..< m.boundaries.a] & injected & result[m.boundaries.b + 1 .. ^1]
    let hs2 = result.helperState()
    if hs2.marker != 1 or not hs2.defsOk or result.countRe(filterPatchedRe) != 1:
      echo "  [FAIL] A/C: injection did not land (patched filter, helper or " & MARKER &
        " absent)"
      quit(1)
    if result.countRe(aDoneRe) != 1:
      echo "  [FAIL] A: patched clean-exit term not found after injection"
      quit(1)
    echo &"  [OK] A: clean-exit term of {filterFn} now consults __cdbCleanExitRecoverable " &
      &"(quitting={quitFn})"
    patchesApplied += 1
    if result.countRe(cDoneRe) != 1 or result.countRe(filterRe) != 0:
      echo "  [FAIL] C: patched token branch not found after injection"
      quit(1)
    echo &"  [OK] C: token branch of {filterFn} now returns __cdbWatchdogKillRecoverable " &
      &"(quitting={quitFn})"
    patchesApplied += 1
  else:
    echo &"  [FAIL] A/C: reason filter with the unconditional clean-exit drop found " &
      &"{filterMatches.len} time(s), patched clean-exit term {aDone.len}, patched token " &
      &"branch {cDone.len}, patched filter {patchedMatches.len}, marker {hs.marker}; " &
      "expected 1/0/0/0/0 (pristine) or 0/1/1/1/1 (applied). If upstream now reloads " &
      "after a clean-exit or after a watchdog kill attempt itself, re-audit which " &
      "sub-patch is absorbed and drop it (Rule 4)"
    quit(1)

  # The handler that owns the grace must be the one consulting this filter.
  let callRe = re2("!" & rxEscape(filterFn) & """\(""" & rxEscape(details) & """\)\)""")
  if result.countRe(callRe) < 1:
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
    if result.countRe(graceDoneRe) != 1 or result.countRe(graceRe) != 0:
      echo "  [FAIL] B: widened grace did not land"
      quit(1)
    echo &"  [OK] B: 300 ms grace now covers clean-exit (details={details} quitting={quitFn})"
    patchesApplied += 1

  # ── D: SIGKILL fallback for the watchdog's no-op crash request ───────────
  #   e.forcefullyCrashRenderer(),F6n(e)  ->
  #   globalThis.__cdbHungKillEscalate(e),e.forcefullyCrashRenderer(),F6n(e)
  # The reload call names the same WebContents, which pins this to the
  # kill-and-reload pair (there is one forcefullyCrashRenderer call in the bundle).
  #   groups: 0 wc, 1 reload fn, 2 wc again
  let killRe = re2("""([\w$]+)\.forcefullyCrashRenderer\(\),([\w$]+)\(([\w$]+)\)""")
  let killDoneRe = re2(
    """globalThis\.__cdbHungKillEscalate\(([\w$]+)\),([\w$]+)\.forcefullyCrashRenderer\(\),""" &
      """([\w$]+)\(([\w$]+)\)"""
  )
  var kills: seq[RegexMatch2] = @[]
  for m in result.findAll(killRe):
    if result[m.group(0)] == result[m.group(2)]:
      kills.add m
  var killsDone: seq[RegexMatch2] = @[]
  for m in result.findAll(killDoneRe):
    killsDone.add m
  let anyCrash = result.count(".forcefullyCrashRenderer(")
  if kills.len != 1 or anyCrash != 1:
    echo &"  [FAIL] D: the watchdog's `<wc>.forcefullyCrashRenderer(),<reload>(<wc>)` pair " &
      &"found {kills.len} time(s) ({anyCrash} forcefullyCrashRenderer call(s) in total); " &
      "expected exactly 1; re-audit the unresponsive watchdog"
    quit(1)
  let escalateCalls = result.count("globalThis.__cdbHungKillEscalate(")
  if killsDone.len == 1 and escalateCalls == 1:
    let d = killsDone[0]
    let wc = result[d.group(0)]
    if result[d.group(1)] != wc or result[d.group(3)] != wc:
      echo "  [FAIL] D: __cdbHungKillEscalate call present but names a different WebContents; re-audit"
      quit(1)
    echo &"  [OK] D: SIGKILL fallback already armed before forcefullyCrashRenderer ({MARKER})"
    patchesApplied += 1
  elif killsDone.len == 0 and escalateCalls == 0:
    let m = kills[0]
    let wc = result[m.group(0)]
    let reloadFn = result[m.group(1)]
    result =
      result[0 ..< m.boundaries.a] & "globalThis.__cdbHungKillEscalate(" & wc & ")," &
      result[m.boundaries.a .. ^1]
    if result.countRe(killDoneRe) != 1 or
        result.count("globalThis.__cdbHungKillEscalate(") != 1:
      echo "  [FAIL] D: SIGKILL fallback call did not land"
      quit(1)
    echo &"  [OK] D: SIGKILL fallback armed before {wc}.forcefullyCrashRenderer() " &
      &"(reload={reloadFn})"
    patchesApplied += 1
  else:
    echo &"  [FAIL] D: {killsDone.len} __cdbHungKillEscalate call(s) in front of the " &
      &"watchdog pair, {escalateCalls} in total; expected 0/0 (pristine) or 1/1 " &
      "(applied); re-audit"
    quit(1)

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
    echo &"  [PASS] Renderer clean-exit reload + hang recovery: {EXPECTED_PATCHES}/{EXPECTED_PATCHES} patches applied"
  else:
    echo "  [PASS] No changes needed (already applied)"
