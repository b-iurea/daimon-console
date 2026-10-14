#!/usr/bin/env bash
# install.sh — render this overlay into a Hermes home. Idempotent.
#   usage: scripts/install.sh [--home /path/to/.hermes]
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
[ "${1:-}" = "--home" ] && HOME_DIR="$2"

mkdir -p "$HOME_DIR/skins" "$HOME_DIR/tui-widgets" "$HOME_DIR/plugins"
cp -f skins/daimon.yaml "$HOME_DIR/skins/daimon.yaml"

if [ ! -f "$HOME_DIR/config.yaml" ] || [ "${OVERWRITE_CONFIG:-0}" = 1 ]; then
  cp config/base.yaml "$HOME_DIR/config.yaml"
  echo "config.yaml rendered (was missing or OVERWRITE_CONFIG=1)"
else
  echo "config.yaml exists — merge keys manually if needed: display.skin=daimon, model.provider=custom"
fi

# widgets are self-contained .mjs apps under $HERMES_HOME/tui-widgets/
for w in widgets/*.mjs; do [ -e "$w" ] && cp -f "$w" "$HOME_DIR/tui-widgets/"; done

# plugins: Hermes loads user plugins from $HERMES_HOME/plugins/<name>/ (plugin.yaml + __init__.py).
# Replaced as a whole so a file removed here does not linger there.
for p in plugins/*/; do
  [ -f "$p/plugin.yaml" ] || continue
  name="$(basename "$p")"
  rm -rf "${HOME_DIR:?}/plugins/$name"
  cp -R "$p" "$HOME_DIR/plugins/$name"
  find "$HOME_DIR/plugins/$name" -name __pycache__ -type d -prune -exec rm -rf {} +
done
# plugins are opt-in (plugins.enabled); config/base.yaml enables daimon-bridge
if ! grep -q 'daimon-bridge' "$HOME_DIR/config.yaml" 2>/dev/null; then
  echo "plugin daimon-bridge copied but NOT enabled — run: HERMES_HOME=$HOME_DIR hermes plugins enable daimon-bridge"
fi

echo "installed → $HOME_DIR (skin: daimon, plugin: daimon-bridge)"
echo "activate with: hermes config set display.skin daimon"
