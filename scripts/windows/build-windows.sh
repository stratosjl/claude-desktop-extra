#!/usr/bin/env bash
# Build the portable Windows 11 package of claude-desktop-extra.
#
# Runs on Linux (CI or a dev box), like the other packages: downloads
# Anthropic's official Windows build (the Squirrel .nupkg the official
# installer fetches), verifies it against the RELEASES manifest, patches
# app.asar with the Windows patch set (apply_patches.py --windows, from a copy
# of the sources with scripts/windows/upstream-overlay.patch applied - see
# scripts/windows/prepare-sources.sh),
# repacks it, rewrites the asar integrity hash embedded in claude.exe, and
# zips the result with an installer script.
#
# Why the exe is touched: on Windows Electron enforces the
# EnableEmbeddedAsarIntegrityValidation fuse, so claude.exe refuses an
# app.asar whose header hash differs from the one it carries. The record is a
# fixed-length hex string, rewritten in place (scripts/windows/asar_integrity.py);
# Anthropic's code signature no longer matches the modified exe.
#
# Usage:
#   scripts/windows/build-windows.sh [--arch x64|arm64] [--version X.Y.Z]
#                                    [--nupkg FILE --sha1 HEX] [--out DIR]
#
# Needs: curl, unzip, zip, python3, node >= 24 (the bundle uses `await using`),
# nim + the regex package (to compile the patches), and asar
# (npm i -g @electron/asar; otherwise npx fetches @electron/asar@3.4.1).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PKG_DIR="$REPO_DIR/packaging/windows"
BASE_URL="https://downloads.claude.ai/releases/win32"

ARCH="x64"
VERSION=""
NUPKG=""
SHA1=""
OUT_DIR="$REPO_DIR/dist"

log() { echo "[build-windows] $*"; }
die() { echo "[build-windows] ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --arch) ARCH="${2:?}"; shift 2 ;;
        --arch=*) ARCH="${1#*=}"; shift ;;
        --version) VERSION="${2:?}"; shift 2 ;;
        --version=*) VERSION="${1#*=}"; shift ;;
        --nupkg) NUPKG="${2:?}"; shift 2 ;;
        --nupkg=*) NUPKG="${1#*=}"; shift ;;
        --sha1) SHA1="${2:?}"; shift 2 ;;
        --sha1=*) SHA1="${1#*=}"; shift ;;
        --out) OUT_DIR="${2:?}"; shift 2 ;;
        --out=*) OUT_DIR="${1#*=}"; shift ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

case "$ARCH" in x64|arm64) ;; *) die "--arch must be x64 or arm64" ;; esac

for dep in curl unzip zip python3 node; do
    command -v "$dep" >/dev/null || die "$dep is required"
done
node -e 'new Function("async function f(){await using x=null}")' 2>/dev/null ||
    die "node $(node --version) cannot parse the bundle (it uses \`await using\`): Node 24 or newer is needed"
if command -v asar >/dev/null; then
    ASAR=(asar)
else
    ASAR=(npx --yes @electron/asar@3.4.1)
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdb-windows.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# 1. The official package, verified
# ---------------------------------------------------------------------------
# RELEASES lines: "<SHA1> AnthropicClaude-<version>-full.nupkg <size>".
if [ -n "$NUPKG" ]; then
    [ -f "$NUPKG" ] || die "no such file: $NUPKG"
    [ -n "$SHA1" ] || die "--nupkg needs --sha1 (from the RELEASES file it was listed in)"
    if [ -z "$VERSION" ]; then
        VERSION="$(basename "$NUPKG" | sed -n 's/^AnthropicClaude-\(.*\)-full\.nupkg$/\1/p')"
        [ -n "$VERSION" ] || die "cannot read the version from $(basename "$NUPKG"); pass --version"
    fi
    cp "$NUPKG" "$WORK/claude.nupkg"
else
    log "Reading $BASE_URL/$ARCH/RELEASES"
    curl -fsSL --retry 3 -o "$WORK/RELEASES" "$BASE_URL/$ARCH/RELEASES"
    # The file starts with a UTF-8 BOM and uses CRLF.
    sed -i '1s/^\xEF\xBB\xBF//; s/\r$//' "$WORK/RELEASES"
    if [ -z "$VERSION" ]; then
        VERSION="$(sed -n 's/^[0-9A-Fa-f]\{40\} AnthropicClaude-\(.*\)-full\.nupkg [0-9]*$/\1/p' "$WORK/RELEASES" |
            sort -V | tail -1)"
        [ -n "$VERSION" ] || die "no full package listed in RELEASES"
    fi
    line="$(grep -F " AnthropicClaude-$VERSION-full.nupkg " "$WORK/RELEASES" || true)"
    [ -n "$line" ] || die "version $VERSION is not in RELEASES (it lists the current release only); download it yourself and pass --nupkg FILE --sha1 HEX"
    read -r SHA1 _name SIZE <<< "$line"
    log "Downloading AnthropicClaude-$VERSION-full.nupkg ($ARCH, $((SIZE / 1048576)) MiB)"
    curl -fsSL --retry 3 -o "$WORK/claude.nupkg" "$BASE_URL/$ARCH/AnthropicClaude-$VERSION-full.nupkg"
    got_size="$(stat -c %s "$WORK/claude.nupkg")"
    [ "$got_size" = "$SIZE" ] || die "size mismatch: got $got_size, RELEASES says $SIZE"
fi
got_sha1="$(sha1sum "$WORK/claude.nupkg" | cut -d' ' -f1)"
[ "${got_sha1,,}" = "${SHA1,,}" ] || die "SHA1 mismatch: got $got_sha1, expected $SHA1"
log "Verified SHA1 $got_sha1 (version $VERSION)"

# ---------------------------------------------------------------------------
# 2. Unpack the app and its asar
# ---------------------------------------------------------------------------
unzip -q "$WORK/claude.nupkg" 'lib/net45/*' -d "$WORK/nupkg"
APP_TREE="$WORK/nupkg/lib/net45"
RES="$APP_TREE/resources"
[ -f "$APP_TREE/claude.exe" ] && [ -f "$RES/app.asar" ] || die "not a Claude Desktop package: claude.exe or resources/app.asar missing"
cp "$RES/app.asar" "$WORK/original.asar"

log "Fuses: $(python3 -I "$SCRIPT_DIR/asar_integrity.py" fuses "$APP_TREE/claude.exe" | tr '\n' ' ')"
python3 -I "$SCRIPT_DIR/asar_integrity.py" unpacked "$WORK/original.asar" > "$WORK/unpacked.before"

mkdir -p "$WORK/app"
( cd "$RES" && "${ASAR[@]}" extract app.asar "$WORK/app/app.asar.contents" )

# ---------------------------------------------------------------------------
# 3. Patch
# ---------------------------------------------------------------------------
# The Windows build's sources: this repo plus the overlay of upstream files.
SRC="$WORK/src"
"$SCRIPT_DIR/prepare-sources.sh" "$SRC"
log "Compiling patches"
make -C "$SRC/patches" -j"$(nproc)" >/dev/null
log "Applying the Windows patch set"
python3 "$SRC/scripts/apply_patches.py" --windows "$SRC/patches" "$WORK/app"

# ion-dist (the third-party inference setup window) is not inside app.asar:
# its `@patch-type: nim-dir` patches run on a folder, as in
# build-patched-tarball.sh. Since v4.29.0 it ships packed as
# resources/ion-dist.asar (before, as a resources/ion-dist folder): the archive
# is extracted, patched and repacked to its place, and its record in the exe's
# integrity resource rewritten if the exe has one (step 4). The Linux-only ion
# fix (fix_ion_dist_linux) stays out.
ION_ASAR="$RES/ion-dist.asar"
if [ -e "$ION_ASAR" ] && [ -e "$RES/ion-dist" ]; then
    die "the package has both resources/ion-dist.asar and resources/ion-dist/ - re-audit which one the app serves"
elif [ -e "$ION_ASAR" ]; then
    { [ -f "$ION_ASAR" ] && [ ! -L "$ION_ASAR" ]; } || die "resources/ion-dist.asar is not a regular file"
    # The repack writes every file into the archive: an --unpack layout would be lost.
    [ ! -e "$ION_ASAR.unpacked" ] || die "resources/ion-dist.asar.unpacked exists - teach the repack its --unpack layout"
    ION_FORMAT=asar
    ION_DIR="$WORK/ion-dist"
    cp "$ION_ASAR" "$WORK/original-ion-dist.asar"
    "${ASAR[@]}" extract "$ION_ASAR" "$ION_DIR"
elif [ -d "$RES/ion-dist" ]; then
    ION_FORMAT=dir
    ION_DIR="$RES/ion-dist"
else
    die "neither resources/ion-dist.asar nor resources/ion-dist/ in the package - the layout moved; re-audit the ion-dist patches"
fi
[ -f "$ION_DIR/index.html" ] && [ -d "$ION_DIR/assets/v1" ] ||
    die "the staged ion-dist ($ION_FORMAT) has no index.html or assets/v1/ - the setup window's layout moved"
WINDOWS_ION_PATCHES=(community/add_feature_allow_non_anthropic_models_ion)
for p in "${WINDOWS_ION_PATCHES[@]}"; do
    grep -q '^# @patch-type: nim-dir$' "$SRC/patches/$p.nim" || die "$p is not a nim-dir patch"
    log "Applying $p to ion-dist ($ION_FORMAT)"
    "$SRC/patches/$p" "$ION_DIR" || die "ion-dist patch failed: $p"
done
if [ "$ION_FORMAT" = asar ]; then
    log "Repacking ion-dist.asar"
    "${ASAR[@]}" pack "$ION_DIR" "$WORK/ion-dist.asar"
    # Read it back: every staged file packed (`asar list --is-pack` prints
    # "pack   : /path" or "unpack : /path"), none unpacked, index.html there.
    "${ASAR[@]}" list --is-pack "$WORK/ion-dist.asar" > "$WORK/ion-dist.list" ||
        die "the repacked ion-dist.asar does not read back"
    if grep -q '^unpack ' "$WORK/ion-dist.list"; then die "the repacked ion-dist.asar flags unpacked files"; fi
    grep -qx 'pack *: /index.html' "$WORK/ion-dist.list" || die "the repacked ion-dist.asar has no /index.html"
    missing="$(LC_ALL=C comm -23 \
        <(cd "$ION_DIR" && find . -type f | sed 's|^\.||' | LC_ALL=C sort) \
        <(sed -n 's/^pack *: //p' "$WORK/ion-dist.list" | LC_ALL=C sort) | wc -l)"
    [ "$missing" -eq 0 ] || die "the repacked ion-dist.asar is missing $missing of the staged files"
    mv -f "$WORK/ion-dist.asar" "$ION_ASAR"
    rm -rf "$ION_DIR"
fi

log "Validating JavaScript syntax"
bad=0
for js in "$WORK/app/app.asar.contents/.vite/build/"*.js "$WORK/app/app.asar.contents/.vite/build/"*-worker/*.js; do
    [ -f "$js" ] || continue
    node --check "$js" 2>/dev/null || { echo "  syntax error: $(basename "$js")" >&2; bad=1; }
done
[ "$bad" = 0 ] || die "patched JavaScript does not parse"

# The V8 bytecode cache covers the files we patched: V8 would reject it and
# recompile anyway (see build-patched-tarball.sh).
rm -rf "$WORK/app/app.asar.contents/compile-cache"

# ---------------------------------------------------------------------------
# 4. Repack and re-sign the integrity record
# ---------------------------------------------------------------------------
log "Repacking app.asar"
( cd "$WORK/app" && "${ASAR[@]}" pack app.asar.contents app.asar --unpack "{**/*.node,**/*.dll,**/*.exe}" )
python3 -I "$SCRIPT_DIR/asar_integrity.py" unpacked "$WORK/app/app.asar" > "$WORK/unpacked.after"
diff -u "$WORK/unpacked.before" "$WORK/unpacked.after" >&2 ||
    die "the repacked asar unpacks a different set of files than the official one"
# Electron also checks every file it reads from a checked archive against its
# block hashes, so each file entry must carry them.
block_integrity() {
    node -e '
      const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let n = 0, missing = 0;
      (function walk(d) { for (const e of Object.values(d.files || {})) {
        if (e.files) walk(e); else if (!e.unpacked && !e.link) { n++; if (!e.integrity || !e.integrity.hash) missing++; } } })(h);
      if (!n || missing) { console.error("integrity blocks missing on " + missing + " of " + n + " files"); process.exit(1); }
    ' <(python3 -I -c 'import sys,struct;f=open(sys.argv[1],"rb");_,_,_,n=struct.unpack("<4I",f.read(16));sys.stdout.write(f.read(n).decode())' "$1")
}
block_integrity "$WORK/app/app.asar" || die "the repacked asar has no per-file integrity"

rm -rf "$RES/app.asar" "$RES/app.asar.unpacked"
mv "$WORK/app/app.asar" "$RES/app.asar"
mv "$WORK/app/app.asar.unpacked" "$RES/app.asar.unpacked"
python3 -I "$SCRIPT_DIR/asar_integrity.py" fix-exe "$APP_TREE/claude.exe" "$WORK/original.asar" "$RES/app.asar"
# Electron checks only the archives the integrity resource lists. A repacked
# ion-dist.asar that is listed needs its record rewritten like app.asar's.
records="$(python3 -I "$SCRIPT_DIR/asar_integrity.py" records "$APP_TREE/claude.exe")" ||
    die "cannot read claude.exe's integrity records"
log "claude.exe integrity records: $(tr '\n' ' ' <<< "$records")"
if [ "$ION_FORMAT" = asar ]; then
    if grep -qxF 'ion-dist.asar' <<< "$records"; then
        block_integrity "$ION_ASAR" || die "the repacked ion-dist.asar has no per-file integrity"
        python3 -I "$SCRIPT_DIR/asar_integrity.py" fix-exe "$APP_TREE/claude.exe" \
            "$WORK/original-ion-dist.asar" "$ION_ASAR" ion-dist.asar
    else
        log "claude.exe has no integrity record for ion-dist.asar: left unchecked, as in the official build"
    fi
fi

# The Squirrel updater and its shortcut stub only work inside Squirrel's own
# install layout; this build is portable.
rm -f "$APP_TREE/squirrel.exe" "$APP_TREE/claude_ExecutionStub.exe"

# ---------------------------------------------------------------------------
# 5. Package
# ---------------------------------------------------------------------------
NAME="claude-desktop-extra-$VERSION-windows-$ARCH"
STAGE="$WORK/$NAME"
mkdir -p "$STAGE"

# The app goes in as app.zip, which Install-ClaudeExtra.ps1 unpacks straight
# into its install folder. Unpacked by Explorer instead, its deepest files
# (ion-dist fonts) would sit under the user's download folder plus our folder
# names and pass Windows' 260-character path limit ("Error 0x80010135: Path
# too long"). The installer folder is short and known, so cap the app's own
# paths here: %LOCALAPPDATA%\Programs\Claude Desktop Extra\app.new\ is about 70
# characters for a typical user name.
MAX_REL_PATH=150
longest="$(cd "$APP_TREE" && find . -type f | sed 's|^\./||' \
    | awk 'length($0) > n { n = length($0); p = $0 } END { print n "\t" p }')"
[ "${longest%%$'\t'*}" -le "$MAX_REL_PATH" ] \
    || die "app path longer than $MAX_REL_PATH characters, too close to Windows' path limit: ${longest#*$'\t'}"
( cd "$APP_TREE" && zip -qr -X "$STAGE/app.zip" . )
rm -rf "$APP_TREE"
cp "$PKG_DIR/Install-ClaudeExtra.ps1" "$PKG_DIR/Install.cmd" "$STAGE/"
sed 's/$/\r/' "$PKG_DIR/README-Windows.txt" > "$STAGE/README-Windows.txt"
{
    echo "claude-desktop-extra Windows build"
    echo "Upstream Claude Desktop: $VERSION ($ARCH)"
    echo "Upstream package SHA1:   $got_sha1"
    echo "Source commit:           $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
} | sed 's/$/\r/' > "$STAGE/VERSION.txt"

mkdir -p "$OUT_DIR"
# Absolute: zip runs from inside $WORK below.
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
ZIP="$OUT_DIR/$NAME.zip"
rm -f "$ZIP"
# -n .zip: app.zip is already compressed; store it as is.
( cd "$WORK" && zip -qr -X -n .zip "$ZIP" "$NAME" )
( cd "$OUT_DIR" && sha256sum "$NAME.zip" > "$NAME.zip.sha256" )
log "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
