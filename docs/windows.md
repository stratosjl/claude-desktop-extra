# Windows 11 (experimental)

A portable Windows build of Anthropic's official Claude Desktop with this project's extras:

- **Profiles**: several separate Claude instances side by side, each with its own sign-in, settings and Claude Code configuration.
- **Settings → Extra**, with these panels:
  - **Themes**: the [theme engine](themes.md), its bundled palettes and the <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> picker.
  - **Community**: the opt-in features. They are diff view modes, panel tabs and files quick open (<kbd>Ctrl</kbd>+<kbd>P</kbd>) in the [Code tab](code-tab.md); load large sessions in full; allow non-Anthropic models (3P gateways); the theme picker; and developer tools.
  - **Models**: [custom models](custom-models.md) from other providers in the Code tab's picker.
  - **Anthropic**: [feature flag overrides](feature-flags.md).

Everything else is Anthropic's Windows app as shipped. Left out because Windows has its own, or they are Linux plumbing:

- the Linux fixes;
- Computer Use bridges;
- window controls, native titlebar and transparent window;
- the Quick Entry socket and `--toggle`/`--reload-theme` (Windows has its own Quick Entry shortcut; theme files are re-read when they change);
- the Deployment panel (Windows takes managed settings from the registry, `SOFTWARE\Policies\Claude`).

## Install

1. Download `claude-desktop-extra-<version>-windows-x64.zip` (or `-arm64`) from a `windows-v<version>` release, or from the artifacts of a **Build Windows** workflow run.
2. Unzip it and double-click **Install.cmd**. It unpacks the app (`app.zip` in the download) to `%LOCALAPPDATA%\Programs\Claude Desktop Extra` and adds **Claude (Extra)** to the Start Menu. No administrator rights are needed.
3. Windows may show "Windows protected your PC" for `Install.cmd`: click **More info → Run anyway**. See [Code signing](#code-signing) for why.

The app ships zipped inside the download because its deepest files are about 100 characters below the app folder. Unzipped by Explorer under a download folder, they can pass Windows' 260-character path limit ("Error 0x80010135: Path too long"); the installer unpacks them under its own short folder instead.

To update, install the next zip the same way; data and sign-in are kept. `Install.cmd -Uninstall` removes the app and its shortcuts and keeps the data.

**With the official app installed too:** the default profile uses the same data folder (`%APPDATA%\Claude`), so you stay signed in, but only one of the two runs at a time - quit the official app first. Sign-in links (`claude://`) may open either app; quit the one you are not signing in to.

## Code signing

Anthropic signs `claude.exe`. The build has to change it (see [How it is built](#how-it-is-built)), so its signature no longer verifies, and the build is not signed by anyone else. What that means:

- **SmartScreen.** Files from a downloaded zip carry the "downloaded from the internet" mark, so Windows may warn once when you run `Install.cmd`. The installer clears the mark, and the app it unpacks never had it, so starting Claude afterwards should not warn.
- **Smart App Control.** If it is on (Windows Security → App & browser control), Windows blocks apps whose signature is missing or broken, so this build will not start. Smart App Control has no per-app exception.
- **Antivirus** may look harder at an exe whose signature does not verify. The build changes only the 64-character asar hash inside it; `scripts/windows/asar_integrity.py` checks the old value before replacing it.

A signature of our own would need a code-signing certificate (an OV certificate from a certificate authority, or Microsoft's Artifact Signing, which only organizations or US/Canadian individuals can get) and the right to distribute Anthropic's app under that name. Even then SmartScreen and Smart App Control trust a new publisher only after it builds a reputation. The build is not signed for now; a signing step can be added to the **Build Windows** workflow if a project identity with a certificate exists.

## Profiles

```bat
Install.cmd -Profile work            :: adds "Claude (work)" to the Start Menu
Install.cmd -Profile work -Desktop   :: and to the desktop
Install.cmd -RemoveProfile work      :: removes the shortcut, keeps the data
```

A shortcut runs `claude.exe --profile=work`; `CLAUDE_PROFILE=work` in the environment does the same.

| | Default profile | Profile `work` |
|---|---|---|
| App data (sign-in, settings, logs, `claude-desktop-extra.json`) | `%APPDATA%\Claude` | `%APPDATA%\Claude-work` |
| Claude Code configuration | `%USERPROFILE%\.claude` | `%USERPROFILE%\.claude-work` |
| Window title | `Claude` | `Claude (work)` |

Names use letters, digits, `-` and `_`; an invalid name shows an error instead of starting the default profile. Each profile is its own instance (Electron's single-instance lock is per data folder).

**Signing in.** `claude://` callbacks always start `claude.exe` without a profile. As on Linux, a profile that opens a sign-in page in the browser leaves a timestamped marker in `%LOCALAPPDATA%\claude-desktop-extra\`; a callback that arrives within 5 minutes goes to the profile with the newest marker. Start one sign-in at a time.

Known limits: **Start at login** starts the default profile; all profiles share one taskbar group (tell them apart by the title); a named profile ignores the 3P (`Claude-3p`) data folder switch, because it pins its own folder.

## Custom models

Identical to Linux ([custom-models.md](custom-models.md)), with the Windows paths above.

The model routing loads a preload into the Claude Code CLI through `BUN_OPTIONS`, which cannot carry a space. When the user folder has one (`C:\Users\John Smith`), the preload is passed through the profile folder's 8.3 short name (`C:\Users\JOHNSM~1\...`). On a drive with short names turned off, sessions are not routed and `claude-patches.log` says so; setting `CLAUDE_USER_DATA_DIR` to a folder without spaces is the workaround.

## Settings files

The extras keep their settings in the profile folder (`%APPDATA%\Claude`, or `%APPDATA%\Claude-<name>`):

- `claude-desktop-extra.json` is written by Settings → Extra.
- `claude-desktop-extra.jsonc` is yours to edit. Its keys are those of [docs/claude-desktop-extra.jsonc](claude-desktop-extra.jsonc).
- Your own themes go in `themes.d\`.

Save hand-edited files as **UTF-8 without a byte-order mark**: Notepad's default, or `Set-Content -Encoding utf8NoBOM` in PowerShell 7. Windows PowerShell 5.1's `>` and `Set-Content -Encoding UTF8` write encodings that some of these readers cannot parse.

## Logs

`%APPDATA%\Claude\logs\` (or `%APPDATA%\Claude-<name>\logs\`): `claude-patches.log` holds our lines (`[win-profiles]`, `[ExtraSettings]`, `[CustomThemes]`, `[custom-models]`, `[DiffViews]`, ...), `custom-models.log` the routed requests, `main.log` the app's own log.

## How it is built

`scripts/windows/build-windows.sh` runs on Linux, like the other packages:

1. Reads `https://downloads.claude.ai/releases/win32/<arch>/RELEASES` (what the official installer reads), downloads the full Squirrel `.nupkg` and checks its size and SHA1 against it.
2. Prepares the sources: `scripts/windows/prepare-sources.sh` copies the repo to a temp folder and applies `scripts/windows/upstream-overlay.patch` there (see [Staying in sync with upstream](#staying-in-sync-with-upstream)).
3. Extracts `app.asar` and applies the Windows patch set from that copy:
   - `apply_patches.py --windows` runs the shared patches listed in `WINDOWS_PATCH_SET` (every core and community feature except the Linux window handling, the Quick Entry socket and the Linux profile URL routing), then everything in `patches/windows/`;
   - the allow-non-Anthropic-models patch of the 3P setup window runs on its files: since v4.29.0 they ship as `resources/ion-dist.asar`, which is extracted, patched and repacked to its place (older packages have a `resources/ion-dist` folder, patched in place). The strictness rules are the same as on Linux: a patch that does not match fails the build, and so does a layout that is neither of the two.
4. Repacks `app.asar` (same unpacked file set as Anthropic's, checked) and rewrites the asar integrity hash in `claude.exe`. On Windows, Electron's `EnableEmbeddedAsarIntegrityValidation` fuse is enforced, unlike on Linux: the exe refuses an archive whose header hash differs from the one it carries. `scripts/windows/asar_integrity.py` replaces that fixed-length hash in place, after checking that the old value matches the original archive. The exe checks only the archives its integrity record lists; if it lists `ion-dist.asar` too, that hash is rewritten the same way. The exe is otherwise byte-identical; its Authenticode signature no longer verifies.
5. Drops the Squirrel updater (the build is portable and does not auto-update), checks that no path in the app is longer than 150 characters, packs the app as `app.zip` and zips it with `Install.cmd`, `Install-ClaudeExtra.ps1`, `README-Windows.txt` and `VERSION.txt`.

```bash
scripts/windows/build-windows.sh                    # current release, x64
scripts/windows/build-windows.sh --arch arm64
scripts/windows/build-windows.sh --nupkg AnthropicClaude-3.6556.2-full.nupkg --sha1 <SHA1>
```

Needs Node 24+, Nim with the `regex` package, `asar` (or `npx`), `curl`, `unzip` and `zip`. The **Build Windows** workflow (`.github/workflows/build-windows.yml`) builds both architectures, boots the x64 build on a Windows runner with a test profile (checking that the patched bundle loads and logs its startup lines), and publishes a release when run with `publish`.

The Windows version stream is not the Linux one (Windows usually ships first), so a Windows build can meet a bundle the patches were not yet re-fitted to; the build then fails like a Linux build would.

## Staying in sync with upstream

This fork follows [patrickjaja/claude-desktop-extra](https://github.com/patrickjaja/claude-desktop-extra), which ships the Linux packages.

- **The fork only adds files.** Its few edits to upstream files are kept in `scripts/windows/upstream-overlay.patch` and applied to a copy at build time, never committed in place:
  - the `win32` gates of the shipped features;
  - the Windows Settings → Extra nav and Community list (`js/extra_settings_page.js`);
  - Windows fixes:
    - git resolved from PATH only, with no console window, in diff views;
    - native path joins in files quick open;
    - the theme caption colors, BOM-tolerant config reads, and no app menu in the theme picker;
    - the Windows 3P folder;
  - `apply_patches.py --windows`, the `windows` category of `scripts/run-feature-tests.sh` and the `patches/windows` Makefile rule;
  - the Windows cases in the Extra settings DOM test.

  Custom models need no overlay any more: upstream took the fork's Windows changes for them (the `win32` gate and the 8.3 short path in [patrickjaja/claude-desktop-extra#295](https://github.com/patrickjaja/claude-desktop-extra/pull/295), the router accepting `claude.exe` in [#296](https://github.com/patrickjaja/claude-desktop-extra/pull/296)).

  So syncing master with upstream never conflicts. If upstream rewrites one of those lines, `prepare-sources.sh` fails loudly instead.
- **Daily automation:** the **Upstream Sync** workflow (`.github/workflows/upstream-sync.yml`) runs every morning:
  1. syncs master with GitHub's "Sync fork";
  2. compares Anthropic's current Windows version with the newest `windows-v` release;
  3. when either moved, runs Build Windows with `publish`.

  A failed check publishes nothing. The failure is reported in an issue (when Issues are enabled on the repo, otherwise in the run summary; GitHub also emails failed scheduled runs), with a ready-to-paste prompt for fixing it with Claude. A later successful run closes that issue.
- **Workflow files:** syncing upstream commits that change `.github/workflows/` needs a token with the workflow permission. Add a fine-grained personal access token as the `SYNC_TOKEN` repository secret (this repository only; Contents and Workflows: read and write).
- **Changing the overlay:**
  1. run `scripts/windows/prepare-sources.sh /tmp/src`;
  2. edit the files in `/tmp/src`;
  3. run `git -C /tmp/src diff > scripts/windows/upstream-overlay.patch`.
