#!/usr/bin/env bash
# Copy this repo's tracked files to DEST and apply the Windows overlay there.
#
# The fork never edits upstream files in place (that is what keeps the daily
# upstream sync conflict-free). The upstream files the Windows build needs
# changed - the win32 gates of the shipped features, the Windows Settings ->
# Extra nav and Community list, Windows fixes (custom models short path and
# claude.exe, diff
# views git resolution, quick open path joins, theme engine details, the 3P
# folder), apply_patches.py --windows, the patches/windows Makefile rule and
# the Windows test cases - live in scripts/windows/upstream-overlay.patch and
# are applied to a copy at build time. If upstream moved the lines it touches,
# `git apply` fails here, loudly, instead of the sync conflicting.
#
# Usage: scripts/windows/prepare-sources.sh DEST
#
# To change the overlay: edit the files in a prepared copy, then regenerate
# the patch from that copy with `git -C DEST diff > upstream-overlay.patch`
# (DEST is a git repo whose first commit is the pristine copy).

set -euo pipefail

DEST="${1:?usage: prepare-sources.sh DEST}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAY="$REPO_DIR/scripts/windows/upstream-overlay.patch"

[ -f "$OVERLAY" ] || { echo "[prepare-sources] missing $OVERLAY" >&2; exit 1; }
mkdir -p "$DEST"
[ -z "$(ls -A "$DEST")" ] || { echo "[prepare-sources] $DEST is not empty" >&2; exit 1; }

# Tracked files only, as they are in the working tree.
( cd "$REPO_DIR" && git ls-files -z | tar --null -T - -cf - ) | tar -xf - -C "$DEST"

# A throwaway repo, so git apply works on DEST and nowhere else, and
# `git -C DEST diff` shows the overlay afterwards.
git -C "$DEST" init -q
git -C "$DEST" add -A
git -C "$DEST" -c user.name=overlay -c user.email=overlay@localhost commit -qm pristine

if ! git -C "$DEST" apply --check "$OVERLAY" 2>"$DEST/.overlay-error"; then
    echo "[prepare-sources] ERROR: scripts/windows/upstream-overlay.patch no longer applies:" >&2
    cat "$DEST/.overlay-error" >&2
    echo "[prepare-sources] Upstream changed lines the Windows build edits. Re-fit the overlay (see the header of this script)." >&2
    exit 1
fi
git -C "$DEST" apply "$OVERLAY"
echo "[prepare-sources] Windows overlay applied: $(git -C "$DEST" diff --stat | tail -1)"
