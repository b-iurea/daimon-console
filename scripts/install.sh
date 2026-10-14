#!/usr/bin/env bash
# install.sh — render this overlay into a Hermes home. Idempotent.
#   usage: scripts/install.sh [--home /path/to/.hermes]
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
[ "${1:-}" = "--home" ] && HOME_DIR="$2"

mkdir -p "$HOME_DIR/skins" "$HOME_DIR/tui-widgets"
cp -f skins/daimon.yaml "$HOME_DIR/skins/daimon.yaml"

if [ ! -f "$HOME_DIR/config.yaml" ] || [ "${OVERWRITE_CONFIG:-0}" = 1 ]; then
  cp config/base.yaml "$HOME_DIR/config.yaml"
  echo "config.yaml rendered (was missing or OVERWRITE_CONFIG=1)"
else
  echo "config.yaml exists — merge keys manually if needed: display.skin=daimon, model.provider=custom"
fi

# widgets are self-contained .mjs apps under $HERMES_HOME/tui-widgets/
for w in widgets/*.mjs; do [ -e "$w" ] && cp -f "$w" "$HOME_DIR/tui-widgets/"; done

echo "installed → $HOME_DIR (skin: daimon)"
echo "activate with: hermes config set display.skin daimon"
