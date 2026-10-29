# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Reload the main view after a renderer clean-exit the app did not ask for
# (issue #287), and SIGKILL a main-view renderer the unresponsive watchdog
# could not crash (issue #299).
#
# Upstream's main-webview `render-process-gone` handler (v4.29.0) is
#
#   e.on("render-process-gone",(async(t,n)=>{if($B(e),!Wnr(n))return;d();
#     let r=l(),i=nV(e),s=wV(),c=kVn();
#     if(n.reason==="killed"&&(await new Promise((e=>setTimeout(e,Onr))),
#        e.isDestroyed()||XN())){p("abandoned");return}
#     if(e.isDestroyed()){p("abandoned");return}
#     P.info("Main webview render process gone: %o",n), ...telemetry...
#     v(n,r) /* 3 reloads per 5 min cap, then the error card; else Orr(e) */
#
# and its reason filter is
#
#   function Wnr(e){return znr()?((e.reason==="killed"||e.reason==="crashed")&&Hnr(),!1)
#                   :!(e.reason==="clean-exit"||e.reason==="killed"&&XN())}
#
# where znr() takes one "we crashed it ourselves" token (added only by the
# unresponsive watchdog when it starts a kill attempt) and XN=()=>WN||GN||KN
# is upstream's own quitting predicate (set by the before-quit / will-quit
# interceptor, once cleanup is done, and while an update installs). So a
# `clean-exit` is dropped unconditionally; our fix_renderer_gone_suppressed_log
# is what writes the "(suppressed)" line for it.
#
# On Linux the main view's renderer can exit with reason clean-exit / exitCode 0
# on its own (niri Wayland, 10-16 Code sessions open, every day or two). The
# window stays blank, Ctrl+R / F5 have no renderer left to receive them, and
# only a full restart - which ends every Code session - recovers. A real crash
# (`crashed`, exit code 132) takes the reload path and recovers on its own.
#
# The handler's sibling `unresponsive` watchdog runs (v4.29.0)
#
#   w=async t=>{$B(e),Inr(),d(); ...telemetry, optional spare check...
#     if(u==="spared"){...;return}
#     e.forcefullyCrashRenderer(),f??={startedAt:...},g(),Orr(e),
#     Q("desktop_main_view_hang_kill_wait",h)}
#
# (v4.29.0 names: Inr() adds one token, Rnr() lets it expire 10 s after the
# attempt - 5 min longer while upstream's recovery reload is pending - znr() in
# the filter takes one, Orr is the reload helper, and g() arms upstream's 30 s
# "Main webview committed no page within %d s of its recovery reload" re-check,
# which reloads again, at most 3 times per 5 min, and then shows its
# Restart-only "Claude stopped responding" card.)
#
# Electron 44.9.3's WebContents::ForcefullyCrashRenderer() is, on Linux only,
# `rph->ForceCrash()` with no Shutdown() fallback, and Chromium 152 turns that
# into ChildProcess::CrashHungProcess(), which the renderer serves on its IO
# thread (`LOG(FATAL) << "Crashing because hung"`). So it does crash a renderer
# whose main thread alone is hung; upstream's watchdog handles that case by
# itself. It is a no-op when the renderer's IO thread is stalled as well - the
# whole process stuck (futex deadlock, SIGSTOP, thrashing), issue #299: the view
# stays frozen, every re-check reload goes to the same stalled renderer, and
# upstream ends on the "Claude stopped responding" card after about 120 s (or
# never, while input keeps re-arming the hang monitor).
#
# Three sub-patches, none touching the handler head that
# fix_renderer_gone_suppressed_log rewrites (the two compose in either order):
#
#   A. the filter's clean-exit term becomes
#      `e.reason==="clean-exit"&&!globalThis.__cdbCleanExitRecoverable(e,XN)`.
#      The helper returns true only for a clean-exit on Linux while upstream's
#      own XN() says the app is not quitting (quit, relaunch, Reset App Data and
#      the 1P/3P switch all go through app.quit, so they count as app-initiated),
#      at most 3 times per 10 minutes; otherwise upstream's verdict stands.
#   B. the grace: upstream waits 300 ms after a `killed` and drops the event if
#      the WebContents is destroyed or the app is quitting by then. The condition
#      becomes `(n.reason==="killed"||n.reason==="clean-exit")&&(await ...)`, so a
#      view being torn down, or a quit whose before-quit lands a moment after the
#      renderer exit, is still dropped (and logged by the suppressed-log patch).
#   D. the watchdog's `e.forcefullyCrashRenderer(),...,Orr(e)` gains a leading
#      `globalThis.__cdbHungKillEscalate(e),`: on Linux the helper SIGKILLs the
#      renderer pid 5 s later (7 s at most, after a 2 s liveness probe) unless
#      the view became responsive, crashed, was destroyed or got a new renderer
#      in between. It is armed only after upstream's spare check decided to
#      kill. The `killed` that follows still carries the attempt's token, so the
#      filter drops it (fix_renderer_gone_suppressed_log logs it as suppressed);
#      the re-check g() armed at the attempt then reloads into a new renderer
#      about 30 s after the attempt.
#
# (Sub-patch C, which handed a death with a token pending straight to the
# reload path, is retired: the token expiry and the 30 s re-check recover that
# case on their own since v4.29.0. The patch refuses an output that still
# carries it.)
#
# js/renderer_clean_exit.js defines the two helpers. It is inlined once, as a
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
# the watchdog kill on Linux itself, D is dropped.

import std/[os, strformat, strutils]
import regex

const EXPECTED_PATCHES = 3
  # A clean-exit term, B grace, D SIGKILL fallback (C retired with v4.29.0)

# js/renderer_clean_exit.js must never contain the literal `.forcefullyCrashRenderer(`: D counts that string after the helper is inlined.
const HELPER_JS = staticRead("../../js/renderer_clean_exit.js")

# Bumped whenever the helper's shape changes, so idempotency asserts THIS
# version's injected end-state rather than "something of ours is present".
# v3: the helper set lost __cdbWatchdogKillRecoverable (sub-patch C retired).
const MARKER = "__cdb_clean_exit_reload_v3__"

# The two globals the helper installs, as they appear in the inlined source.
const HELPER_DEFS = [
  "globalThis.__cdbCleanExitRecoverable ||= function",
  "globalThis.__cdbHungKillEscalate ||= function",
]

# Retired sub-patch C's helper: an output that still names it is a stale v2
# end-state, never "already applied".
const RETIRED = "__cdbWatchdogKillRecoverable"

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
  if result.countRe(quitRe) < 1:
    echo &"  [FAIL] quitting predicate {quitFn} is not a zero-arg arrow over the quit " &
      "flags anymore; re-audit what the handler's `killed` grace consults"
    quit(1)

  # ── A: the reason filter ─────────────────────────────────────────────────
  # Pristine:
  #   function Wnr(e){return znr()?((e.reason==="killed"||e.reason==="crashed")&&Hnr(),!1)
  #                   :!(e.reason==="clean-exit"||e.reason==="killed"&&XN())}
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
  # The whole patched filter (token branch still upstream's `!1`), to recover
  # its name for the handler cross-check.
  let filterPatchedRe = re2(
    """function ([\w$]+)\(([\w$]+)\)\{return [\w$]+\(\)\?\(\([\w$]+\.reason===["`]killed["`]""" &
      """\|\|[\w$]+\.reason===["`]crashed["`]\)&&[\w$]+\(\),!1\):!\([\w$]+\.reason===""" &
      """["`]clean-exit["`]&&!globalThis\.__cdbCleanExitRecoverable\([\w$]+,[\w$]+\)\|\|""" &
      """[\w$]+\.reason===["`]killed["`]&&[\w$]+\(\)\)\}"""
  )
  var filterMatches: seq[RegexMatch2] = @[]
  for m in result.findAll(filterRe):
    filterMatches.add m
  var aDone: seq[RegexMatch2] = @[]
  for m in result.findAll(aDoneRe):
    aDone.add m
  var patchedMatches: seq[RegexMatch2] = @[]
  for m in result.findAll(filterPatchedRe):
    patchedMatches.add m
  let hs = result.helperState()
  let retired = result.count(RETIRED)
  var filterFn: string
  if filterMatches.len == 0 and aDone.len == 1 and patchedMatches.len == 1 and
      hs.marker == 1 and hs.defsOk and retired == 0:
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
  elif filterMatches.len == 1 and aDone.len == 0 and patchedMatches.len == 0 and
      hs.marker == 0 and retired == 0:
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
    if hs2.marker != 1 or not hs2.defsOk or result.count(RETIRED) != 0 or
        result.countRe(filterPatchedRe) != 1 or result.countRe(aDoneRe) != 1 or
        result.countRe(filterRe) != 0:
      echo "  [FAIL] A: injection did not land (patched filter, helper or " & MARKER &
        " absent)"
      quit(1)
    echo &"  [OK] A: clean-exit term of {filterFn} now consults __cdbCleanExitRecoverable " &
      &"(quitting={quitFn})"
    patchesApplied += 1
  else:
    echo &"  [FAIL] A: reason filter with the unconditional clean-exit drop found " &
      &"{filterMatches.len} time(s), patched clean-exit term {aDone.len}, patched filter " &
      &"{patchedMatches.len}, marker {hs.marker}, retired {RETIRED} {retired}; " &
      "expected 1/0/0/0/0 (pristine) or 0/1/1/1/0 (applied). A stale v2 output (with " &
      "retired sub-patch C) is not accepted. If upstream now reloads after a clean-exit " &
      "itself, re-audit whether sub-patch A is absorbed and drop it (Rule 4)"
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

  # ── D: SIGKILL fallback when the stalled renderer never serves the crash ─
  #   v3.6556.2: e.forcefullyCrashRenderer(),F6n(e),Q("desktop_main_view_hang_kill_wait",u)
  #   v4.29.0:   e.forcefullyCrashRenderer(),f??={startedAt:Date.now(),...},g(),Orr(e),
  #              Q("desktop_main_view_hang_kill_wait",h)
  #   ->         globalThis.__cdbHungKillEscalate(e),e.forcefullyCrashRenderer(),...
  # v4.29.0 put recovery bookkeeping (`f??={...}`, `g()`) between the crash
  # request and the reload, so the pair is no longer adjacent. Preconditions:
  # exactly one `.forcefullyCrashRenderer(` in the bundle, called with no
  # arguments on a plain identifier, and the comma expression it heads calls
  # upstream's setImmediate reload helper on that same WebContents exactly once.
  # The helper is pinned by its definition, which pins this to the
  # kill-and-reload site.
  const crashCall = ".forcefullyCrashRenderer()"
  const JsIdent = {'a' .. 'z', 'A' .. 'Z', '0' .. '9', '_', '$'}
  const MaxExpr = 800
  let anyCrash = result.count(".forcefullyCrashRenderer(")
  let at = result.find(crashCall)
  var wc = ""
  var reloadFns: seq[string] = @[]
  if anyCrash == 1 and at > 0:
    var ws = at
    while ws > 0 and result[ws - 1] in JsIdent:
      dec ws
    wc = result[ws ..< at]
    let exprStart = at + crashCall.len
    # A member access (`x.<wc>.forcefullyCrashRenderer()`) would get our call
    # spliced after the dot, so the WebContents must be a bare identifier.
    let bare = ws == 0 or result[ws - 1] != '.'
    if bare and wc.len > 0 and wc[0] notin {'0' .. '9'} and exprStart < result.len and
        result[exprStart] == ',':
      # Scan to the end of the comma expression the crash request heads.
      var j = exprStart
      var depth = 0
      var quote = '\0'
      while j < result.len and j - exprStart < MaxExpr:
        let c = result[j]
        if quote != '\0':
          if c == '\\':
            inc j
          elif c == quote:
            quote = '\0'
        elif c in {'"', '\'', '`'}:
          quote = c
        elif c in {'(', '[', '{'}:
          inc depth
        elif c in {')', ']', '}'}:
          if depth == 0:
            break
          dec depth
        elif c == ';' and depth == 0:
          break
        inc j
      if j - exprStart < MaxExpr and j < result.len:
        let expr = result[exprStart ..< j]
        for m in expr.findAll(re2(""",([\w$]+)\(([\w$]+)\)""")):
          let after = m.boundaries.b + 1
          if expr[m.group(1)] != wc or (after < expr.len and expr[after] != ','):
            continue
          let fn = expr[m.group(0)]
          let defRe = re2(
            "function " & rxEscape(fn) &
              """\(([\w$]+)\)\{setImmediate\(\(\(\)=>\{([\w$]+)\.isDestroyed\(\)\|\|""" &
              """([\w$]+)\.reload\(\)\}\)\)\}"""
          )
          var defs: seq[RegexMatch2] = @[]
          for d in result.findAll(defRe):
            defs.add d
          if defs.len == 1 and result[defs[0].group(0)] == result[defs[0].group(1)] and
              result[defs[0].group(0)] == result[defs[0].group(2)]:
            reloadFns.add fn
  if anyCrash != 1 or reloadFns.len != 1:
    echo &"  [FAIL] D: the watchdog's `<wc>.forcefullyCrashRenderer(),...,<reload>(<wc>)` pair " &
      &"found {reloadFns.len} time(s) ({anyCrash} forcefullyCrashRenderer call(s) in total); " &
      "expected exactly 1; re-audit the unresponsive watchdog"
    quit(1)
  let reloadFn = reloadFns[0]
  let escalateCall = "globalThis.__cdbHungKillEscalate(" & wc & "),"
  let armed =
    at >= wc.len + escalateCall.len and
    result[at - wc.len - escalateCall.len ..< at - wc.len] == escalateCall
  let escalateCalls = result.count("globalThis.__cdbHungKillEscalate(")
  if armed and escalateCalls == 1:
    echo &"  [OK] D: SIGKILL fallback already armed before forcefullyCrashRenderer ({MARKER})"
    patchesApplied += 1
  elif not armed and escalateCalls == 0:
    let ins = at - wc.len
    result = result[0 ..< ins] & escalateCall & result[ins .. ^1]
    if result.count(escalateCall & wc & crashCall) != 1 or
        result.count("globalThis.__cdbHungKillEscalate(") != 1:
      echo "  [FAIL] D: SIGKILL fallback call did not land"
      quit(1)
    echo &"  [OK] D: SIGKILL fallback armed before {wc}.forcefullyCrashRenderer() " &
      &"(reload={reloadFn})"
    patchesApplied += 1
  else:
    echo &"  [FAIL] D: {ord(armed)} __cdbHungKillEscalate call(s) in front of the " &
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
