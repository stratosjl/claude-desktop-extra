#!/usr/bin/env node
/*
 * test-windows-feature-gates.mjs - the Windows build turns on the shared
 * feature modules whose platform gate scripts/windows/upstream-overlay.patch
 * widens to win32. Run it on a prepared copy (scripts/windows/
 * prepare-sources.sh DEST, then node DEST/scripts/tests/windows/...): in the
 * repo itself the gates are upstream's, Linux-only, and this test fails.
 *
 * Each module sets its own globalThis marker right after its gate. The module
 * runs in a sandbox with a stub electron; what happens after the marker (and
 * may throw on the stub) is not this test's business - each feature's own
 * harness covers that on Linux.
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

// A stub that answers every property access and call with itself.
function anything() {
  const target = function () {};
  const p = new Proxy(target, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : p),
    apply: () => p,
    construct: () => p
  });
  return p;
}

function run(file, platform) {
  const src = readFileSync(join(ROOT, "js", file), "utf8");
  const req = Module.createRequire(import.meta.url);
  const sandbox = {
    require: (m) => (m === "electron" ? anything() : req(m)),
    process: { platform, env: {}, versions: { electron: "44.0.0", node: process.versions.node }, pid: 1, on() {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    Buffer, URL
  };
  sandbox.globalThis = sandbox;
  sandbox.__cdbDiag = () => {};
  try { vm.runInNewContext(src, vm.createContext(sandbox), { filename: file }); } catch (e) {}
  return sandbox;
}

const MODULES = [
  ["files_quick_open_main.js", "__cdbFilesQuickOpenMain"],
  ["panel_tabs_main.js", "__cdbPanelTabsMain"],
  ["transcript_limits_main.js", "__cdbTranscriptLimitsMain"],
  ["diff_views_main.js", "__cdbDiffViewsMain"],
  ["custom_models_main.js", "__cdbCustomModels"],
  ["dev_tools_toggle_main.js", "__cdbDevToolsToggle"]
];

for (const [file, marker] of MODULES) {
  for (const platform of ["win32", "linux"]) {
    ok(!!run(file, platform)[marker], file + ": on for " + platform);
  }
  if (file !== "dev_tools_toggle_main.js") { // no platform gate upstream: it runs everywhere
    ok(!run(file, "darwin")[marker], file + ": still off on darwin");
  }
}

// Allow non-Anthropic models leaves an always-false stub when gated off.
{
  const on = run("allow_non_anthropic_models.js", "win32").__cdbAllowNonAnthropicModels;
  const off = run("allow_non_anthropic_models.js", "darwin").__cdbAllowNonAnthropicModels;
  ok(typeof on === "function" && typeof off === "function" && on.toString() !== off.toString(),
     "allow_non_anthropic_models.js: the real module on win32, the inert stub on darwin");
}

// The inline modules of the Nim patches (theme engine, theme picker) carry the
// same widened gate; the Windows smoke test proves they run.
for (const nim of ["patches/core/add_feature_custom_themes.nim", "patches/community/add_feature_theme_picker.nim"]) {
  const s = readFileSync(join(ROOT, nim), "utf8");
  ok(s.includes('if(process.platform!=="linux"&&process.platform!=="win32")return;') &&
     !s.includes('if(process.platform!=="linux")return;'), nim + ": gate allows win32");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
