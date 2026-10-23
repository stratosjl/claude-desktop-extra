#!/usr/bin/env bash
# verify-install-channel.sh - install claude-desktop-extra the way a user does,
# from a published channel, and check the version that lands.
#
# Usage (inside a fresh container, as root, repo mounted read-only):
#   verify-install-channel.sh <apt|dnf|pacman|aur|nix> <version> <pkgrel> [readme]
#
# The install command is read from README.md, never duplicated here: the
# Quick install table row for apt/dnf/aur/nix, the "signed pacman repository"
# block for pacman. Only what a container lacks compared to a desktop is
# added around it (curl/sudo/gnupg, a non-root user for makepkg, auto-yes).
# `nix run` is swapped for `nix build` since there is no display to launch on.
set -euo pipefail

CHANNEL="${1:?channel}"
VERSION="${2:?version}"
PKGREL="${3:?pkgrel}"
README="${4:-$(dirname "$0")/../README.md}"
EXPECTED="${VERSION}-${PKGREL}"

# Third field of the Quick install table row whose first cell is $1.
# `\|` inside a cell is an escaped pipe, not a column separator.
table_row() {
  local line cell
  line="$(grep -m1 "^| $1 |" "$README")" || { echo "README: no Quick install row '$1'" >&2; exit 1; }
  line="${line//\\|/$'\x01'}"
  IFS='|' read -r _ _ cell _ <<<"$line"
  cell="${cell#*\`}"; cell="${cell%%\`*}"
  printf '%s' "${cell//$'\x01'/|}"
}

case "$CHANNEL" in
  apt)    SNIPPET="$(table_row 'Debian / Ubuntu')" ;;
  dnf)    SNIPPET="$(table_row 'Fedora / RHEL')" ;;
  aur)    SNIPPET="$(table_row 'Arch / Manjaro')" ;;
  nix)    SNIPPET="$(table_row 'NixOS / Nix')" ;;
  pacman) SNIPPET="$(grep -E '^(curl .*install-pacman\.sh \| sudo bash|sudo pacman -Syu claude-desktop-extra)' "$README" \
                     | sed 's/ *#.*$//' | awk '!seen[$0]++' | paste -sd'&' | sed 's/&/ \&\& /g')" ;;
  *) echo "unknown channel: $CHANNEL" >&2; exit 2 ;;
esac
[ -n "$SNIPPET" ] || { echo "README: empty install command for $CHANNEL" >&2; exit 1; }
echo "== README command ($CHANNEL): $SNIPPET"

case "$CHANNEL" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg sudo >/dev/null
    echo 'APT::Get::Assume-Yes "true";' > /etc/apt/apt.conf.d/90assume-yes
    bash -c "$SNIPPET"
    GOT="$(dpkg-query -W -f='${Version}' claude-desktop-extra)"
    ;;
  dnf)
    dnf install -y -q sudo >/dev/null   # curl ships in the base image (curl-minimal on RHEL)
    echo 'assumeyes=True' >> /etc/dnf/dnf.conf
    bash -c "$SNIPPET"
    GOT="$(rpm -q --qf '%{VERSION}-%{RELEASE}' claude-desktop-extra)"
    ;;
  pacman)
    pacman -Syu --noconfirm --needed sudo curl >/dev/null
    bash -c "$SNIPPET" < <(yes '')
    GOT="$(pacman -Q claude-desktop-extra | cut -d' ' -f2)"
    ;;
  aur)
    # yay refuses root: give it the usual desktop user with sudo rights,
    # and install yay itself the documented way (yay-bin from the AUR).
    pacman -Syu --noconfirm --needed sudo git base-devel >/dev/null
    useradd -m user
    echo 'user ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/user
    su user -c 'cd ~ && git clone -q https://aur.archlinux.org/yay-bin.git && cd yay-bin && makepkg -si --noconfirm' >/dev/null
    su user -c "cd ~ && ${SNIPPET} --noconfirm --answerdiff None --answerclean None --removemake"
    GOT="$(pacman -Q claude-desktop-extra | cut -d' ' -f2)"
    ;;
  nix)
    export NIX_CONFIG="experimental-features = nix-command flakes"
    OUT="$(${SNIPPET/nix run/nix build --no-link --print-out-paths})"
    echo "built: $OUT"
    [ -x "$OUT/bin/claude-desktop" ] || { echo "FAIL: $OUT/bin/claude-desktop missing" >&2; exit 1; }
    # The Nix package version carries no pkgrel.
    EXPECTED="$VERSION"
    GOT="${OUT##*/}"; GOT="${GOT#*-claude-desktop-extra-}"
    ;;
esac

if [ "$CHANNEL" != nix ]; then
  command -v claude-desktop >/dev/null || { echo "FAIL: claude-desktop not on PATH" >&2; exit 1; }
fi
if [ "$GOT" != "$EXPECTED" ]; then
  echo "FAIL: $CHANNEL installed $GOT, expected $EXPECTED" >&2
  exit 3
fi
echo "OK: $CHANNEL installed claude-desktop-extra $GOT"
