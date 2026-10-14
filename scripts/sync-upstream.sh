#!/usr/bin/env bash
# sync-upstream.sh — pull the pinned upstream commit into the local cache and
# verify the overlay is still compatible. Never touches upstream files (there
# are none here: this repo is overlay-only by design).
#
#   usage: scripts/sync-upstream.sh [new-ref]     # no arg = verify current pin
#
# With a ref (tag/sha/branch), it fetches, runs the compatibility checks, and —
# only if green — rewrites UPSTREAM.lock to the new commit. That is the entire
# "upgrade Hermes" ritual.
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE=".cache/hermes-agent.git"
mkdir -p .cache

[ -d "$CACHE" ] || git init --bare -q "$CACHE"
git --git-dir="$CACHE" remote add upstream "$(sed -n 's/^upstream *= *//p' UPSTREAM.lock)" 2>/dev/null || true

REF="${1:-$(sed -n 's/^commit *= *//p' UPSTREAM.lock)}"
echo "→ fetching $REF from upstream…"
git --git-dir="$CACHE" fetch -q --depth=1 upstream "$REF" 2>/dev/null \
  || git --git-dir="$CACHE" fetch -q upstream "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*"
SHA=$(git --git-dir="$CACHE" rev-parse "$REF^{commit}")
echo "→ upstream resolves to $SHA"

# --- compatibility checks: the skin engine contract we depend on ------------
WK=".cache/worktree"; rm -rf "$WK"; git --git-dir="$CACHE" worktree add -q --detach "$WK" "$SHA"
PY="${PYTHON:-python3}"
fail=0

check() { # check <desc> <grep-pattern> <file>
  if grep -q "$2" "$WK/$3" 2>/dev/null; then echo "  ✓ $1"
  else echo "  ✗ $1  (missing: $2 in $3)"; fail=1; fi
}
echo "→ checking skin-engine contract…"
check "SkinConfig has banner_logo"      "banner_logo"      hermes_cli/skin_engine.py
check "SkinConfig has branding dict"    "branding"         hermes_cli/skin_engine.py
check "SkinConfig has custom_css"       "custom_css"       hermes_cli/skin_engine.py
check "user skins dir is loaded"        "skins"            hermes_cli/skin_engine.py

# skin file must parse with the real upstream parser
REPO="$(pwd)"
( cd "$WK" && "$PY" - "$REPO/skins/daimon.yaml" <<'EOF'
import sys, yaml, dataclasses
sys.path.insert(0, ".")
from hermes_cli.skin_engine import SkinConfig
data = yaml.safe_load(open(sys.argv[1]))
fields = {f.name for f in dataclasses.fields(SkinConfig)}
unknown = set(data) - fields
assert not unknown, f"skin keys not in upstream SkinConfig: {unknown}"
assert data["name"] == "daimon" and "agent_name" in data["branding"]
assert all(isinstance(v, str) and v.startswith("#") for v in data["colors"].values())
print("  ✓ skins/daimon.yaml valid against upstream SkinConfig schema")
EOF
) || { echo "  ✗ skin parse failed"; fail=1; }

# downstream patch queue (if any) must still apply cleanly
shopt -s nullglob
for p in patches/*.patch; do
  ( cd "$WK" && git apply --check "$OLDPWD/$p" ) \
    && echo "  ✓ $p applies" || { echo "  ✗ $p NO LONGER APPLIES"; fail=1; }
done

git --git-dir="$CACHE" worktree remove --force "$WK" 2>/dev/null || rm -rf "$WK"

if [ "$fail" = 1 ]; then
  echo "SYNC REFUSED — upstream changed the contract or a patch broke. Fix first."
  exit 1
fi

if [ -n "${1:-}" ]; then
  sed -i "s/^commit *= *.*/commit   = $SHA/" UPSTREAM.lock
  sed -i "s/^tag *= *.*/tag      = ${1}/" UPSTREAM.lock
  sed -i "s/^pinned *= *.*/pinned   = $(date -u +%F)/" UPSTREAM.lock
  echo "→ UPSTREAM.lock bumped to $SHA ($1). Commit it together with any overlay fixes."
fi
echo "SYNC GREEN"
