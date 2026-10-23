# CLAUDE.md - this fork (stratosjl/claude-desktop-extra)

@AGENTS.md

AGENTS.md is upstream's (patrickjaja/claude-desktop-extra) and is kept byte-identical to it. This file adds what is specific to this fork: an experimental **Windows 11 build** with custom models and multiple profiles. User guide and build details: [docs/windows.md](docs/windows.md).

## Rule: never edit upstream files in place

The fork only ADDS files. That is what keeps the daily sync with upstream (`.github/workflows/upstream-sync.yml`, GitHub's "Sync fork") conflict-free. A change the Windows build needs in an upstream file goes into `scripts/windows/upstream-overlay.patch`, which `scripts/windows/prepare-sources.sh` applies to a temp copy at build time:

```bash
scripts/windows/prepare-sources.sh /tmp/src     # copy + overlay
# edit files under /tmp/src
git -C /tmp/src diff > scripts/windows/upstream-overlay.patch
```

Check before committing: `git diff --diff-filter=M upstream/master...HEAD --stat` must list nothing (fetch `https://github.com/patrickjaja/claude-desktop-extra` as `upstream`). Fork docs go in docs/windows.md or this file, not in README.md / CHANGELOG.md / AGENTS.md.

## Fork-only files

| Path | What |
|---|---|
| `scripts/windows/build-windows.sh` | Download + verify the official Windows `.nupkg`, patch, repack, rewrite the asar integrity hash in `claude.exe`, zip |
| `scripts/windows/prepare-sources.sh`, `scripts/windows/upstream-overlay.patch` | The fork's edits to upstream files, applied at build time |
| `scripts/windows/asar_integrity.py` | asar header hash, fuses, the exe integrity record (Windows enforces it; Linux does not) |
| `patches/windows/add_windows_profiles.nim`, `js/windows_profiles_main.js` | `--profile=NAME` and sign-in callback routing, injected into `index.pre.js` |
| `packaging/windows/` | `Install.cmd`, `Install-ClaudeExtra.ps1`, `README-Windows.txt` |
| `scripts/tests/windows/` | Windows harnesses; run them on a prepared copy (the overlaid upstream tests too) |
| `.github/workflows/build-windows.yml` | Build x64 + arm64, boot x64 on a Windows runner, publish `windows-v<version>` (`--latest=false`) |
| `.github/workflows/upstream-sync.yml` | Daily: sync master, rebuild + publish when upstream or Anthropic's Windows version moved, report failures |

## Checks for a Windows change

```bash
scripts/windows/prepare-sources.sh /tmp/src
node /tmp/src/scripts/tests/community/test-custom-models-main.mjs
node /tmp/src/scripts/tests/windows/test-windows-profiles.mjs
node /tmp/src/scripts/tests/core/test-extra-settings-dom.mjs   # needs Chromium
scripts/windows/build-windows.sh --out dist                   # Node 24+, Nim + regex, asar
```

The real proof is the **Build Windows** smoke-test job: it installs the zip on a Windows runner and boots `claude.exe --profile=ci`.

Known red check: `Build & Release / check-version` fails on this fork because it has no Linux releases. The fork does not publish Linux packages.
