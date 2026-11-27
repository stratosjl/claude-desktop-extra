#!/usr/bin/env node
/*
 * test-windows-v7-layout.mjs - what the Windows build relies on for Anthropic's
 * Windows 7.37095.0 layout:
 *   - sub-patch B of patches/community/add_feature_files_quick_open.nim on both
 *     fork-site shapes: the direct `utilityProcess.fork(` call (Windows 6.28899)
 *     and 7.37095.0's pass-through wrapper, where the generic worker host calls
 *     `Gun(r,[],{serviceName:t,stdio:"pipe",...},n)`;
 *   - scripts/apply_patches.py's staging: a worker is staged with the
 *     content-hashed modules it requires, and the index bundle with
 *     managedConfigSchemas.js when its chunks require it.
 *
 * Runs the compiled patch on small staged bundles. Needs `make` in patches/,
 * and the overlaid sources (scripts/windows/prepare-sources.sh).
 */
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIN = join(ROOT, "patches/community/add_feature_files_quick_open");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

try { accessSync(BIN, constants.X_OK); } catch {
  console.log("  FAIL patch binary missing (run make in patches/): " + BIN); process.exit(1);
}

const ENV = 'env:Object.assign({},process.env)';
const PTY = 'forkWorker(){this.cooldown.forked();let e=t.VOt(t.Ogt("pty-host","ptyHostWorker.js"),[],{serviceName:t.JN,stdio:"pipe"},{exitsOnSigterm:!0});}';
const WRAPPER = 'function Gun(e,t,n,{exitsOnSigterm:r=!1}={}){return u.utilityProcess.fork(e,t,n)}';
const HOST_V7 = 'this.cooldown.forked();let i=Date.now(),a=!1,o=Gun(r,[],{serviceName:t,stdio:"pipe",...this.opts.env&&{env:this.opts.env()},...this.opts.disclaim&&!1},n);';
const HOST_V6 = 'this.cooldown.forked();let i=Date.now(),a=!1,o=u.utilityProcess.fork(r,[],{serviceName:t,stdio:"pipe",...this.opts.env&&{env:this.opts.env()}});';

function run(body) {
  const dir = mkdtempSync(join(tmpdir(), "cdb-fork-wrapper-"));
  const file = join(dir, "index.js");
  try {
    writeFileSync(file, '"use strict";' + body);
    const r = spawnSync(BIN, [file], { encoding: "utf8" });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), text: readFileSync(file, "utf8"), file };
  } finally {
    // the file is read above; the directory is removed by the caller via `cleanup`
    run.last = dir;
  }
}
const cleanup = () => { if (run.last) rmSync(run.last, { recursive: true, force: true }); };

// 1. Windows 6.28899: the direct call is patched.
{
  const r = run(WRAPPER + PTY + HOST_V6); cleanup();
  ok(r.status === 0, "6.28899 direct fork: exit 0");
  ok(r.text.includes('utilityProcess.fork(r,[],{serviceName:t,stdio:"pipe",' + ENV + ',...this.opts.env'),
     "6.28899 direct fork: env inserted before the worker's own env spread");
  ok(r.text.split(ENV).length === 2, "6.28899 direct fork: exactly one site patched");
}

// 2. Windows 7.37095.0: the host calls the proven wrapper; pty-host is left alone.
{
  const r = run(WRAPPER + PTY + HOST_V7); cleanup();
  ok(r.status === 0, "7.37095 wrapper: exit 0");
  ok(r.text.includes('o=Gun(r,[],{serviceName:t,stdio:"pipe",' + ENV + ',...this.opts.env'),
     "7.37095 wrapper: env inserted in the worker host's wrapper call");
  ok(r.text.includes(PTY), "7.37095 wrapper: the pty-host fork is untouched");
  ok(r.text.split(ENV).length === 2, "7.37095 wrapper: exactly one site patched");
}

// 3. A name that is not a pass-through wrapper does not count: fail loud.
for (const [label, wrapper] of [
  ["wrapper reorders its arguments", 'function Gun(e,t,n){return u.utilityProcess.fork(t,e,n)}'],
  ["wrapper does something else", 'function Gun(e,t,n){return u.other.fork(e,t,n)}'],
  ["no wrapper defined", ''],
]) {
  const r = run(wrapper + PTY + HOST_V7); cleanup();
  ok(r.status !== 0 && /\[FAIL\]/.test(r.out) && !r.text.includes(ENV), "fails closed: " + label);
}

// 4. A member call with the wrapper's name (`x.Gun(`) is not the wrapper.
{
  const r = run(WRAPPER + PTY + HOST_V7.replace("o=Gun(", "o=x.Gun(")); cleanup();
  ok(r.status !== 0 && !r.text.includes(ENV), "fails closed: a member call named like the wrapper");
}

// 5. Idempotent: a second run reports the end state and changes nothing.
{
  const first = run(WRAPPER + PTY + HOST_V7);
  const again = spawnSync(BIN, [first.file], { encoding: "utf8" });
  const text = readFileSync(first.file, "utf8"); cleanup();
  ok(again.status === 0 && /already forks with main's env/.test(again.stdout), "second run: idempotent [OK]");
  ok(text === first.text, "second run: byte-identical");
}

// 6. apply_patches.py staging (chunk_parts) on a synthetic build directory.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-v7-staging-"));
  try {
    const build = join(dir, ".vite/build"), worker = join(build, "file-index-worker"), heavy = join(build, "heavy-work-worker");
    for (const d of [worker, heavy]) mkdirSync(d, { recursive: true });
    const w = (p, t) => writeFileSync(join(build, p), t);
    w("file-index-worker/fileIndexWorker.js", 'require("./rolldown-runtime-CI_2c2Xz.js");const s=require("./sdk-DUs7ylS-.js");require("./named.js");');
    w("file-index-worker/sdk-DUs7ylS-.js", "sdk"); w("file-index-worker/rolldown-runtime-CI_2c2Xz.js", "rt"); w("file-index-worker/named.js", "n");
    w("heavy-work-worker/heavyWorkWorker.js", "no requires");
    w("index.js", 'require("./index.chunk-AAAAAAAA.js");');
    w("index.chunk-AAAAAAAA.js", 'var{values:amt}=require("./managedConfigSchemas.js");');
    w("managedConfigSchemas.js", "schemas");
    w("index.pre.js", 'require("./index.js");require("./managedConfigSchemas.js");');
    const py = 'import sys,json;sys.path.insert(0,sys.argv[1]);import apply_patches as ap;from pathlib import Path\n' +
      'b=Path(sys.argv[2]);print(json.dumps({t:[p.name for p in (ap.chunk_parts(b/t) or [])] for t in sys.argv[3:]}))';
    const targets = ["file-index-worker/fileIndexWorker.js", "heavy-work-worker/heavyWorkWorker.js", "index.js", "index.pre.js"];
    const r = spawnSync("python3", ["-I", "-c", py, join(ROOT, "scripts"), build, ...targets], { encoding: "utf8" });
    const parts = r.status === 0 ? JSON.parse(r.stdout) : {};
    ok(r.status === 0, "staging: apply_patches.chunk_parts runs" + (r.status === 0 ? "" : ": " + r.stderr));
    ok(JSON.stringify(parts[targets[0]]) === JSON.stringify(["fileIndexWorker.js", "rolldown-runtime-CI_2c2Xz.js", "sdk-DUs7ylS-.js"]),
       "staging: the worker gets its hashed modules, not a named one: " + JSON.stringify(parts[targets[0]]));
    ok(JSON.stringify(parts[targets[1]]) === "[]", "staging: a worker that requires nothing is staged alone");
    ok(JSON.stringify(parts[targets[2]]) === JSON.stringify(["index.js", "index.chunk-AAAAAAAA.js", "managedConfigSchemas.js"]),
       "staging: the index bundle takes managedConfigSchemas.js after its chunks: " + JSON.stringify(parts[targets[2]]));
    ok(JSON.stringify(parts[targets[3]]) === "[]", "staging: index.pre.js never pulls in index.js or the schemas");
    w("index.chunk-AAAAAAAA.js", "no schemas here");
    const r2 = spawnSync("python3", ["-I", "-c", py, join(ROOT, "scripts"), build, "index.js"], { encoding: "utf8" });
    ok(r2.status === 0 && JSON.stringify(JSON.parse(r2.stdout)["index.js"]) === JSON.stringify(["index.js", "index.chunk-AAAAAAAA.js"]),
       "staging: managedConfigSchemas.js stays out when no chunk requires it (6.28899 layout)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
