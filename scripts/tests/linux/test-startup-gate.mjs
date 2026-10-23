#!/usr/bin/env node
// The show-at-launch gate must never hide a window the user did not ask to hide
// (issue #233).
//
// WHY THIS EXISTS
// ---------------
// gnome-session and Plasma re-launch saved clients after a reboot WITHOUT
// passing --startup, so a user with "start in system tray" enabled got the main
// window on every login. The fix widened upstream's argv check with a
// heuristic: if the graphical session started less than 60s ago, treat the
// launch as a session restore and keep the window hidden.
//
// That heuristic had no notion of whether the user wanted a hidden start at
// all. So clicking the launcher icon within a minute of logging in - the most
// ordinary thing a person does after a reboot - created the main window with
// show:false. The reporter saw a tray icon, no window, and needed a second
// click (which takes the already-running activation path) to get in.
//
// js/startup_session_restore_gate.js now requires BOTH conditions:
//
//   1. an ENABLED XDG autostart entry exists - i.e. the user actually asked for
//      a hidden start. This is the condition that fixes #233.
//   2. the graphical session started under 60s ago.
//
// and fails safe towards SHOWING the window on every error path, because a
// window that is wrongly hidden is invisible and hard to report, while one that
// is wrongly shown is a minor annoyance.
//
// This harness pins that truth table against the real gate source, evaluated
// with process/require shimmed so the socket age, the autostart entry and the
// session type can all be controlled.
//
// Section [6] runs the compiled patches/linux/fix_startup_settings against the
// upstream shapes it targets (v3.1623.0, verbatim) and checks that only the
// window-show gate is widened: Reset App Data's own `--startup` reader must stay
// byte-identical and keep upstream behavior.
//
// Exit codes follow the repo convention: 0 = PASS, 3 = SKIP, other = FAIL.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  accessSync,
  constants,
} from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const gateSrc = readFileSync(
  join(repo, "js", "startup_session_restore_gate.js"),
  "utf8"
);

const SKIP_EXIT = 3;
const PATCH_BIN = join(repo, "patches", "linux", "fix_startup_settings");

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label} -> ${actual}`);
    pass++;
  } else {
    console.log(`  FAIL ${label} -> got ${actual}, expected ${expected}`);
    failures.push(label);
  }
}

const scratch = join(tmpdir(), `cdb-startup-gate-${process.pid}`);
const EXEC = "/usr/lib/claude-desktop/claude";
const ENTRY_NAME = basename(EXEC) + ".desktop";

// Write an autostart entry into <home>/.config/autostart (or an explicit
// XDG_CONFIG_HOME) and return that home dir.
function makeHome(entryBody, { xdgConfigHome = null } = {}) {
  const home = join(scratch, `home-${Math.random().toString(36).slice(2)}`);
  const cfg = xdgConfigHome || join(home, ".config");
  if (entryBody !== null) {
    mkdirSync(join(cfg, "autostart"), { recursive: true });
    writeFileSync(join(cfg, "autostart", ENTRY_NAME), entryBody);
  } else {
    mkdirSync(home, { recursive: true });
  }
  return { home, cfg };
}

const ENABLED_ENTRY = [
  "[Desktop Entry]",
  "Type=Application",
  "Name=Claude",
  `Exec="${EXEC}" --startup`,
  "X-GNOME-Autostart-enabled=true",
  "",
].join("\n");

// process/require shims: the socket age, the autostart entry (via HOME /
// XDG_CONFIG_HOME) and the session type are all controlled by the caller.
function makeShims({ env, socketAgeMs, socketPath, execPath = EXEC, argv = [EXEC] }) {
  const diagLines = [];
  const fsShim = {
    readFileSync,
    statSync(p) {
      if (socketPath !== null && p === socketPath) {
        if (socketAgeMs === null) {
          const e = new Error("ENOENT");
          e.code = "ENOENT";
          throw e;
        }
        return { mtimeMs: Date.now() - socketAgeMs };
      }
      const e = new Error("ENOENT: " + p);
      e.code = "ENOENT";
      throw e;
    },
  };
  const requireShim = (name) => {
    if (name === "path") return path;
    if (name === "fs") return fsShim;
    if (name === "os") return { homedir: () => env.HOME };
    throw new Error("unexpected require: " + name);
  };
  const processShim = {
    env,
    execPath,
    argv,
    platform: "linux",
    getuid: () => 1000,
  };
  return { requireShim, processShim, diagLines };
}

// Evaluate the real gate with process/require shimmed.
function runGate(opts) {
  const { requireShim, processShim, diagLines } = makeShims(opts);
  const globalShim = {
    __cdbDiag: (s) => diagLines.push(s),
  };
  const fn = new Function(
    "require",
    "process",
    "globalThis",
    `return (${gateSrc});`
  );
  return { result: fn(requireShim, processShim, globalShim), diagLines };
}

// Upstream shapes P3 and P4 target, copied verbatim from the v3.1623.0 bundle
// (index.chunk-*.js). Code between the sites is trimmed; the first line only
// maps upstream's namespace aliases (n/s = path/os, a = electron, r = process).
//   1. the autostart dir/file/Exec builders (k2a, A2a, j2a, M2a): P3's
//      precondition and P4's anchor
//   2. Reset App Data's reader cIi: decides only whether the reset path shows a
//      dialog on exit, must stay byte-identical
//   3. the window-show gate z3a: the one site P3 widens
const RESET_READER = "function cIi(){return process.argv.includes(\"--startup\")}";
const UPSTREAM_GATE =
  "var R3a,z3a=()=>R3a??=!r.default.argv.includes(\"--startup\"),B3a=0;";
const FIXTURE = [
  '"use strict";',
  'var n={default:require("path")},s={default:require("os")},a={app:{getName:()=>"Claude"}},r={default:process};',
  "function k2a(){let e=process.env.XDG_CONFIG_HOME||n.default.join(s.default.homedir(),\".config\");return n.default.join(e,\"autostart\")}function A2a(){return`${n.default.basename(process.execPath)}.desktop`}function j2a(e){return`\"${e.replace(/[\\\\\"`$]/g,\"\\\\$&\")}\"`.replace(/%/g,\"%%\")}function M2a(){return[\"[Desktop Entry]\",\"Type=Application\",`Name=${a.app.getName()}`,`Exec=${j2a(process.execPath)} --startup`,\"X-GNOME-Autostart-enabled=true\",\"\"].join(`\\n`)}",
  RESET_READER,
  UPSTREAM_GATE,
  "",
].join("\n");

function runPatch(file) {
  const r = spawnSync(PATCH_BIN, [file], { encoding: "utf8" });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

// Run the (patched) fixture with process/require shimmed and report what the
// window-show gate, the reset reader and the autostart builder return.
function evalFixture(src, opts) {
  const { requireShim, processShim } = makeShims(opts);
  const sandbox = { require: requireShim, process: processShim, __cdbDiag: () => {} };
  return vm.runInNewContext(
    src + "\n;({ hidden: !z3a(), reset: cIi(), entry: M2a() })",
    vm.createContext(sandbox)
  );
}

try {
  mkdirSync(scratch, { recursive: true });

  console.log(
    "\n[1] a user who never asked for a hidden start is NEVER suppressed"
  );
  {
    const { home } = makeHome(null);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 1000, // session literally just started
      socketPath: "/run/user/1000/wayland-0",
    });
    check("no autostart entry, socket 1s old (issue #233)", result, false);
  }
  {
    const { home } = makeHome(
      ENABLED_ENTRY.replace(
        "X-GNOME-Autostart-enabled=true",
        "X-GNOME-Autostart-enabled=false"
      )
    );
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 1000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("entry with X-GNOME-Autostart-enabled=false", result, false);
  }
  {
    const { home } = makeHome(ENABLED_ENTRY + "Hidden=true\n");
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 1000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("entry with Hidden=true", result, false);
  }

  console.log(
    "\n[2] a user who DID ask for a hidden start keeps session-restore suppression"
  );
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("enabled entry + session 5s old (PR #67 case)", result, true);
  }
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 120000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("enabled entry + session 120s old", result, false);
  }

  console.log("\n[3] session types and path handling");
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home }, // no WAYLAND_DISPLAY -> X11
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/bus",
    });
    check("X11 falls back to the session bus socket", result, true);
  }
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "/run/user/1000/wl-abs" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wl-abs",
    });
    check("absolute WAYLAND_DISPLAY is used as-is", result, true);
  }
  {
    const xdg = join(scratch, "xdgconf");
    const { home } = makeHome(ENABLED_ENTRY, { xdgConfigHome: xdg });
    const { result } = runGate({
      env: { HOME: home, XDG_CONFIG_HOME: xdg, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check("XDG_CONFIG_HOME is honoured", result, true);
  }

  console.log("\n[4] fail-safe direction is always 'show the window'");
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { result } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: null, // socket missing (no /run/user, exotic setup)
      socketPath: "/run/user/1000/wayland-0",
    });
    check("unreadable compositor socket", result, false);
  }

  console.log("\n[5] the decision is recorded for issue reports");
  {
    const { home } = makeHome(ENABLED_ENTRY);
    const { diagLines } = runGate({
      env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
      socketAgeMs: 5000,
      socketPath: "/run/user/1000/wayland-0",
    });
    check(
      "a [startup-gate] line is emitted",
      diagLines.length === 1 && diagLines[0].startsWith("[startup-gate] "),
      true
    );
  }

  console.log(
    "\n[6] the compiled patch widens only the window-show gate (v3.1623.0 shapes)"
  );
  let patchMissing = false;
  try {
    accessSync(PATCH_BIN, constants.X_OK);
  } catch {
    patchMissing = true;
    console.log(
      "  SKIP patches/linux/fix_startup_settings is not compiled " +
        "(run: make -C patches linux/fix_startup_settings)"
    );
  }
  if (!patchMissing) {
    const file = join(scratch, "index.js");
    writeFileSync(file, FIXTURE);
    const r1 = runPatch(file);
    check("first run exits 0", r1.status, 0);
    check("no [FAIL] line", /\[FAIL\]/.test(r1.out), false);
    check(
      "P3 applied to exactly 1 gate",
      r1.out.includes("[OK] session-restore detection: augmented argv --startup gate (1 match)"),
      true
    );
    check("P4 applied", r1.out.includes("[OK] autostart Exec now points at the launcher (1 match)"), true);
    const patched = readFileSync(file, "utf8");
    check(
      "gate widened with the ! outside the parens",
      patched.includes(
        'R3a??=!(r.default.argv.includes("--startup")||process.platform==="linux"&&/* __cdb_startup_gate_v2__'
      ),
      true
    );
    check("upstream gate no longer present verbatim", patched.includes(UPSTREAM_GATE), false);
    check(
      "Reset App Data reader cIi is byte-identical",
      patched.split("\n").filter((l) => l === RESET_READER).length,
      1
    );
    check("gate marker injected once", patched.split("__cdb_startup_gate_v2__").length - 1, 1);
    let syntaxOk = true;
    try {
      execFileSync("node", ["--check", file], { stdio: "pipe" });
    } catch {
      syntaxOk = false;
    }
    check("patched fixture passes node --check", syntaxOk, true);

    const r2 = runPatch(file);
    check("second run exits 0", r2.status, 0);
    check("second run reports already patched", r2.out.includes("already patched (__cdb_startup_gate_v2__)"), true);
    check("second run leaves the file byte-identical", readFileSync(file, "utf8") === patched, true);

    // The reset reader alone must not satisfy P3: with the gate gone, the
    // patch fails loud instead of widening cIi.
    const noGate = join(scratch, "index-no-gate.js");
    writeFileSync(noGate, FIXTURE.replace(UPSTREAM_GATE + "\n", ""));
    const r3 = runPatch(noGate);
    check("reset reader alone is not taken for the gate (exit 1)", r3.status, 1);
    check("...and the file is left untouched", readFileSync(noGate, "utf8") === FIXTURE.replace(UPSTREAM_GATE + "\n", ""), true);

    // Behavior of the patched code.
    {
      const { home } = makeHome(null);
      const out = evalFixture(patched, {
        env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
        socketAgeMs: 1000,
        socketPath: "/run/user/1000/wayland-0",
        argv: [EXEC, "--startup"],
      });
      check("--startup launch: window hidden", out.hidden, true);
      check("--startup launch: reset reader sees --startup", out.reset, true);
    }
    {
      const { home } = makeHome(null);
      const out = evalFixture(patched, {
        env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
        socketAgeMs: 1000,
        socketPath: "/run/user/1000/wayland-0",
      });
      check("plain launch, no autostart entry: window shown", out.hidden, false);
      check("plain launch: reset reader returns false", out.reset, false);
    }
    {
      const { home } = makeHome(ENABLED_ENTRY);
      const out = evalFixture(patched, {
        env: { HOME: home, WAYLAND_DISPLAY: "wayland-0" },
        socketAgeMs: 5000,
        socketPath: "/run/user/1000/wayland-0",
      });
      check("session restore (enabled entry, 5s session): window hidden", out.hidden, true);
      check("session restore: reset reader keeps upstream behavior (false)", out.reset, false);
    }
    {
      const { home } = makeHome(null);
      const out = evalFixture(patched, {
        env: { HOME: home, CLAUDE_LAUNCHER: "/usr/bin/claude-desktop", CLAUDE_PROFILE: "work" },
        socketAgeMs: null,
        socketPath: null,
      });
      check(
        "autostart Exec points at the launcher with the profile",
        out.entry.split("\n").includes('Exec="/usr/bin/claude-desktop" --profile=work --startup'),
        true
      );
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  if (patchMissing) {
    console.log(`${pass} checks passed; patch section SKIPPED`);
    process.exit(SKIP_EXIT);
  }
  console.log("ALL " + pass + " CHECKS PASSED");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
