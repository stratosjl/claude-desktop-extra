#!/usr/bin/env bash
# Check every Computer Use bridge in a directory against the bridge CLI
# contract (docs/computer-use-bridge-contract.md).
#
#   scripts/check-bridge-contract.sh <dir>
#
# Checks each executable `*-bridge` in <dir>. Every command runs with an empty
# environment (PATH kept), a throwaway HOME / XDG_STATE_HOME / XDG_RUNTIME_DIR,
# no display and an unreachable session bus, so it cannot touch the caller's
# grant or open a portal session. CI runs it on the freshly built bridges and on
# the bundled resources/ of the tarball. Needs python3 for the JSON checks (CI
# only; the launcher itself never needs it).
#
# Exit: 0 when every check passed, 1 when any failed, 2 on bad usage.

set -uo pipefail

if (( $# != 1 )) || [[ ! -d "$1" ]]; then
    echo >&2 "usage: $0 <dir-with-bridges>"
    exit 2
fi
dir="$1"
command -v python3 >/dev/null 2>&1 || { echo >&2 "$0: python3 is required"; exit 2; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

passes=0
fails=0
pass() { echo "PASS $1"; passes=$((passes + 1)); }
fail() { echo "FAIL $1${2:+ - $2}"; fails=$((fails + 1)); }

# JSON checks. Mode and arguments on argv, the bridge's stdout on stdin.
# Prints nothing and exits 0 when the JSON fits; prints why and exits 1 when not.
# `doctor` additionally prints session_supported (true/false) on success.
read -r -d '' PY <<'EOF'
import json, sys

mode = sys.argv[1]
raw = sys.stdin.read()
try:
    v = json.loads(raw)
except ValueError as e:
    print("stdout is not one JSON value: %s" % e)
    sys.exit(1)
if not isinstance(v, dict):
    print("expected a JSON object, got %s" % type(v).__name__)
    sys.exit(1)

NOOP = {"ok": True, "ended": False, "daemon": "none", "token_removed": False, "token_path": None}
problems = []

def is_bool(x): return isinstance(x, bool)
def is_num(x): return isinstance(x, (int, float)) and not isinstance(x, bool)
def is_str(x): return isinstance(x, str)
def is_str_or_null(x): return x is None or isinstance(x, str)

def expect(key, check, what):
    if key not in v:
        problems.append("missing key %r" % key)
    elif not check(v[key]):
        problems.append("%r must be %s, got %s" % (key, what, json.dumps(v[key])))

if mode == "doctor":
    name = sys.argv[2]
    expect("contract", is_num, "a number")
    expect("bridge", is_str, "a string")
    expect("version", is_str, "a string")
    expect("backend", is_str, "a string")
    expect("session_match", is_bool, "a bool")
    expect("backend_reachable", is_bool, "a bool")
    expect("backend_error", is_str_or_null, "a string or null")
    expect("session_supported", is_bool, "a bool")
    expect("restore_token_present", is_bool, "a bool")
    expect("restore_token_path", is_str_or_null, "a string or null")
    expect("daemon_running", is_bool, "a bool")
    expect("session_socket", is_str_or_null, "a string or null")
    if not problems:
        if v["contract"] != 1:
            problems.append("contract must be 1, got %s" % json.dumps(v["contract"]))
        if v["bridge"] != name:
            problems.append("bridge must be %r (the file name), got %r" % (name, v["bridge"]))
        if not v["session_supported"]:
            for key, want in (("restore_token_present", False), ("restore_token_path", None),
                              ("session_socket", None)):
                if v[key] != want:
                    problems.append("%r must be %s without a session, got %s"
                                    % (key, json.dumps(want), json.dumps(v[key])))
elif mode == "session-end":
    if v.get("ok") is not True: problems.append("ok must be true")
    if v.get("ended") is not False: problems.append("ended must be false with no daemon")
    if v.get("daemon") != "none": problems.append("daemon must be \"none\" with no daemon")
elif mode in ("forget-empty", "forget-planted"):
    supported = sys.argv[2] == "true"
    if not supported:
        if v != NOOP:
            problems.append("a bridge without a session must answer exactly %s, got %s"
                            % (json.dumps(NOOP), json.dumps(v)))
    else:
        if v.get("ok") is not True: problems.append("ok must be true")
        if v.get("ended") is not False: problems.append("ended must be false with no daemon")
        if v.get("daemon") != "none": problems.append("daemon must be \"none\" with no daemon")
        want = mode == "forget-planted"
        if v.get("token_removed") is not want:
            problems.append("token_removed must be %s" % json.dumps(want))
        if not is_str_or_null(v.get("token_path", 0)):
            problems.append("token_path must be a string or null")
else:
    problems.append("unknown mode %r" % mode)

if problems:
    print("; ".join(problems))
    sys.exit(1)
if mode == "doctor":
    print("true" if v["session_supported"] else "false")
EOF

json_check() {  # mode [arg] <<< json
    python3 -I -c "$PY" "$@"
}

# A fresh sandbox: prints its path. home/, state/ and run/ start empty.
sandbox() {
    local sb
    sb="$(mktemp -d "$scratch/sb.XXXXXX")"
    mkdir -p "$sb/home" "$sb/state" "$sb/run"
    chmod 700 "$sb/run"
    printf '%s\n' "$sb"
}

# Run a bridge in sandbox $1: sets OUT, ERR, RC.
OUT='' ERR='' RC=0
run_bridge() {
    local sb="$1" bin="$2"
    shift 2
    RC=0
    OUT="$(timeout -s KILL 30 env -i PATH="$PATH" HOME="$sb/home" \
        XDG_STATE_HOME="$sb/state" XDG_RUNTIME_DIR="$sb/run" \
        DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent \
        "$bin" "$@" 2>"$sb/stderr" </dev/null)" || RC=$?
    ERR="$(head -c 300 "$sb/stderr")"
}

# Anything a command left in the sandbox (state or runtime dirs, HOME).
leftovers() {
    find "$1/home" "$1/state" "$1/run" -mindepth 1 2>/dev/null | sed "s|^$1/||" | head -5 | tr '\n' ' '
}

check_bridge() {
    local bin="$1" name sb why supported='' first sub
    name="${bin##*/}"
    echo "== $name ($bin)"

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" --version
    first="${OUT%%$'\n'*}"
    if [[ "$RC" == 0 && "$first" =~ ^"$name "[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        pass "$name: --version ($first)"
    else
        fail "$name: --version" "exit $RC, stdout '${first:0:80}' (want '$name <semver>')"
    fi

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" doctor
    if [[ "$RC" != 0 ]]; then
        fail "$name: doctor" "exit $RC (must exit 0 even without a display or session bus): ${ERR:0:120}"
    elif supported="$(json_check doctor "$name" <<< "$OUT")"; then
        pass "$name: doctor (contract 1, required keys, session_supported=$supported)"
    else
        fail "$name: doctor" "$supported"
        supported=''
    fi

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" session-end
    if [[ "$RC" != 0 ]]; then
        fail "$name: session-end" "exit $RC: ${ERR:0:120}"
    elif why="$(json_check session-end <<< "$OUT")"; then
        pass "$name: session-end with no daemon"
    else
        fail "$name: session-end" "$why"
    fi

    if [[ -z "$supported" ]]; then
        fail "$name: forget-session" "skipped: doctor did not say whether the bridge has a session"
    else
        sb="$(sandbox)"
        run_bridge "$sb" "$bin" forget-session
        if [[ "$RC" != 0 ]]; then
            fail "$name: forget-session with nothing stored" "exit $RC: ${ERR:0:120}"
        elif ! why="$(json_check forget-empty "$supported" <<< "$OUT")"; then
            fail "$name: forget-session with nothing stored" "$why"
        elif [[ -n "$(leftovers "$sb")" ]]; then
            fail "$name: forget-session with nothing stored" "created $(leftovers "$sb")"
        else
            pass "$name: forget-session with nothing stored (idempotent, creates nothing)"
        fi

        sb="$(sandbox)"
        mkdir -p "$sb/state/$name"
        echo '{"token":"planted-by-check-bridge-contract"}' > "$sb/state/$name/restore-token.json"
        echo keep > "$sb/state/$name/keep.txt"
        run_bridge "$sb" "$bin" forget-session
        if [[ "$RC" != 0 ]]; then
            fail "$name: forget-session with a stored grant" "exit $RC: ${ERR:0:120}"
        elif ! why="$(json_check forget-planted "$supported" <<< "$OUT")"; then
            fail "$name: forget-session with a stored grant" "$why"
        elif [[ ! -f "$sb/state/$name/keep.txt" ]]; then
            fail "$name: forget-session with a stored grant" "deleted a sibling file of the token"
        elif [[ "$supported" == true && -e "$sb/state/$name/restore-token.json" ]]; then
            fail "$name: forget-session with a stored grant" "reported success but the token file is still there"
        elif [[ "$supported" == false && ! -f "$sb/state/$name/restore-token.json" ]]; then
            fail "$name: forget-session with a stored grant" "a bridge without a session deleted the file"
        elif [[ "$supported" == true ]]; then
            pass "$name: forget-session with a stored grant (token removed, sibling kept)"
        else
            pass "$name: forget-session with a stored grant (no session: exact no-op, file untouched)"
        fi
    fi

    for sub in screens windows session-start; do
        sb="$(sandbox)"
        run_bridge "$sb" "$bin" "$sub" --help
        if [[ "$RC" == 0 ]]; then pass "$name: $sub --help"; else fail "$name: $sub --help" "exit $RC"; fi
    done

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" pointer-move --x -5 --y -5 --help
    if [[ "$RC" == 0 ]]; then
        pass "$name: negative coordinates are accepted (pointer-move --x -5 --y -5 --help)"
    else
        fail "$name: negative coordinates" "pointer-move --x -5 --y -5 --help exited $RC: ${ERR:0:120}"
    fi

    sb="$(sandbox)"
    run_bridge "$sb" "$bin" no-such-subcommand-cdb
    if [[ "$RC" == 2 ]]; then pass "$name: unknown subcommand exits 2"; else fail "$name: unknown subcommand" "exit $RC, want 2"; fi
}

found=0
for bin in "$dir"/*-bridge; do
    [[ -f "$bin" && -x "$bin" ]] || continue
    found=$((found + 1))
    check_bridge "$bin"
done
if (( found == 0 )); then
    fail "no executable *-bridge in $dir"
fi

echo
echo "$found bridge(s): $passes passed, $fails failed"
(( fails == 0 ))
