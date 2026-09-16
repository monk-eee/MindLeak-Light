# Changelog Fragments

Adapted from MindLeak's per-change fragment workflow. Add one uniquely named
`<section>-<slug>.md` file per user/operator change, containing Markdown bullets.
Sections: added, changed, deprecated, removed, fixed, security.

Use `node scripts/changelog.mjs --check` to validate and `--preview` to inspect
the next release. A maintainer runs `--release X.Y.Z` to fold fragments into a
dated section of `CHANGELOG.md` and remove only the consumed fragments.
Commit that release preparation before creating the matching version tag.
