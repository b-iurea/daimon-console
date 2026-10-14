# patches/ — the last-resort queue

Files here are `git format-patch` / `git diff` patches against the exact commit in
`UPSTREAM.lock`. `scripts/sync-upstream.sh` refuses to bump the pin while any patch
fails `git apply --check`.

Rules for admitting a patch (all three, no exceptions):
1. It is impossible as a skin key, widget, plugin or config value. (Ask first; the
   skin engine + plugin SDK cover far more than people expect.)
2. It ships as an upstream-ready PR to NousResearch/hermes-agent — if we need it,
   the feature is usually general and upstream wants it too.
3. It has a one-line header comment: `# why: …` + `# upstream-pr: <url|pending>`.

Empty queue = healthy. If this dir stays empty for a whole release cycle, the
architecture is holding.
