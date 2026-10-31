#!/usr/bin/env bash
# venice-opencode installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/zalo-alex/venice-opencode/main/install.sh | bash
#
# Re-run the same command (or `venice-opencode update`) to update.
# Options are passed to `venice-opencode setup`, e.g.:
#   curl -fsSL .../install.sh | bash -s -- --port 4000 --no-opencode
#
# Environment:
#   VENICE_OPENCODE_DIR   install location (default ~/.local/share/venice-opencode)
#   VENICE_OPENCODE_REF   git branch or tag to install (default main)
#   VENICE_OPENCODE_SRC   install from a local checkout instead of GitHub (development)
set -euo pipefail

REPO="zalo-alex/venice-opencode"
REF="${VENICE_OPENCODE_REF:-main}"
DIR="${VENICE_OPENCODE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/venice-opencode}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; C=$'\033[36m'; Z=$'\033[0m'
else
  B=; D=; R=; G=; C=; Z=
fi
step() { printf '  %s›%s %s\n' "$C" "$Z" "$*"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$Z" "$*"; }
die()  { printf '\n  %s✘ %s%s\n\n' "$R" "$*" "$Z" >&2; exit 1; }

printf '\n  %s▲ venice-opencode%s  %sinstaller%s\n\n' "$B$C" "$Z" "$B" "$Z"

[ "$(uname -s)" = "Linux" ] || printf '  %s!%s Only Linux is tested; there is no systemd service on other systems.\n' "$R" "$Z"

for cmd in node npm tar; do
  command -v "$cmd" >/dev/null || die "$cmd is required (Node.js 22+: https://nodejs.org/en/download or 'nvm install 22')"
done
[ -n "${VENICE_OPENCODE_SRC:-}" ] || command -v curl >/dev/null || die "curl is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22+ is required, found $(node -v). Try: nvm install 22"
ok "Node $(node -v)"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/venice-opencode.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
NEW="$STAGE/app"
mkdir -p "$NEW"

if [ -n "${VENICE_OPENCODE_SRC:-}" ]; then
  step "Copying local sources from $VENICE_OPENCODE_SRC"
  (cd "$VENICE_OPENCODE_SRC" && tar --exclude=node_modules --exclude=.git -cf - .) | tar -xf - -C "$NEW"
else
  step "Downloading $REPO@$REF"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$STAGE/src.tgz" \
    || die "download failed (is the repo public and the ref '$REF' valid?)"
  tar -xzf "$STAGE/src.tgz" -C "$NEW" --strip-components=1
fi
[ -f "$NEW/package.json" ] || die "downloaded archive looks wrong"

step "Installing dependencies"
(cd "$NEW" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || die "npm install failed"
touch "$NEW/.installed"
chmod +x "$NEW/bin/venice-opencode.mjs"

# Swap in the new version; keep the old one until the swap succeeded.
mkdir -p "$(dirname "$DIR")"
if [ -e "$DIR" ]; then
  mv "$DIR" "$DIR.old.$$"
  mv "$NEW" "$DIR" || { mv "$DIR.old.$$" "$DIR"; die "could not replace $DIR"; }
  rm -rf "$DIR.old.$$"
else
  mv "$NEW" "$DIR"
fi
ok "Installed to $DIR"

# Prompts need a terminal even when this script arrives through a pipe.
if [ ! -t 0 ] && [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  exec </dev/tty
fi
rm -rf "$STAGE"
exec node "$DIR/bin/venice-opencode.mjs" setup "$@"
