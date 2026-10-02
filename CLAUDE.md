# code-sketch

A Claude Code skill (shipped as a plugin) that explains code by drawing it as an editable Excalidraw diagram.
Claude writes a small JSON **spec**; `sketch.mjs` turns it into `.excalidraw` + PNG + an editor page. Keep this file short and true; update it when the layout or the release routine changes.

## Layout

```
.claude-plugin/plugin.json        plugin manifest; "version" drives updates (see Releasing)
.claude-plugin/marketplace.json   makes this repo installable as a marketplace
skills/code-sketch/SKILL.md       what a Claude using the skill reads: workflow, spec format, patterns
skills/code-sketch/scripts/       sketch.mjs (the whole generator), smoke-test.mjs, fonts/, package.json
skills/code-sketch/references/examples/*.json   example specs; the smoke test builds every one
docs/                             generated example diagrams used by the README (rebuild when output changes)
.github/                          CI (smoke test on Linux/macOS/Windows) and the bug report template
```

## Commands

```bash
cd skills/code-sketch/scripts
npm install                       # elkjs + @resvg/resvg-js (the script also installs them itself on first run)
npm test                          # builds every example, checks scene integrity, checks bad specs are refused
node sketch.mjs ../references/examples/hit-to-levelup.json --out /tmp/out
SKETCH_DEBUG=1 node sketch.mjs spec.json --out /tmp/out     # prints every layout candidate and its size
```

Always pass `--out` to a temp dir when testing; the default is the user's `~/code-sketch-diagrams/`. Never pass `--open` while testing unless you want a browser tab.

## How `sketch.mjs` works (read before changing it)

1. Validates the spec (structure, then `LIMITS` at the top: nodes, arrows, groups, branches/loops, text length, canvas).
2. Measures boxes, then tries several layouts and keeps the best that fits: a "snake" grid for plain chains, ELK left-to-right and top-down otherwise. Group boxes are drawn *after* layout around their members; a layout whose group box covers an outside node is penalised.
3. Places arrow labels, builds Excalidraw elements (arrows are bound to boxes), renders the SVG itself and rasterises it with resvg for the PNG, and writes the editor `.html`.

The guardrails are the point of the project: they keep diagrams small enough to understand. Do not raise a limit just to make one example pass; change the example, or improve the advice in the error message.

## Conventions

- Everything in the repo (code, docs, commit messages, release notes, issues) is in **English**, even though the maintainer chats in Portuguese.
- Commits: small and separate by purpose, imperative subject with a type prefix (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), a body that says *why*. Commit straight to `main`.
- Commit and PR bodies end with the attribution line Claude Code is configured to add.
- When output changes (layout, colours, labels), rebuild `docs/*` from the examples and check the PNGs by eye (open them; a script can't tell if a label sits on a line).
- When the spec format or the advice for the model changes, update `SKILL.md` in the same change. `SKILL.md` is read by Claude on every use, so keep it tight and explain *why* rather than shouting rules.
- New spec fields need: validation, a line in the `SKILL.md` table, an example that uses them, and a smoke-test check.

## Pitfalls we already hit

- Claude must never write Excalidraw JSON by hand; that is what the spec and script are for.
- Two arrows A→B and B→A are rejected on purpose (they overlap); use one arrow with `"both": true`.
- ELK compound groups stretched group boxes into empty space; that is why groups are drawn post-layout.
- `plugin update` only sees a new version when `plugin.json`'s `version` changes. Forgetting the bump means users never get the fix.
- The editor page loads Excalidraw from esm.sh (pinned version in `EXCALIDRAW_VERSION`). The diagram itself is embedded and never uploaded.
- `file://` pages render as static snapshots in the Claude desktop app's built-in browser; verify the editor page over `http://localhost` instead.

## Releasing

1. Make sure `npm test` passes and CI is green on `main`.
2. Bump `"version"` in `.claude-plugin/plugin.json` (semver: features = minor, fixes = patch), commit `chore: bump plugin version to X.Y.Z`, push.
3. Create the GitHub release **with a written post, not just a tag**: `gh release create vX.Y.Z --target main --title "vX.Y.Z: <headline>" --notes-file <file>`.
   The post is in English and has: a one-paragraph headline of what changed for users, **What's new** / **Fixes** (user-visible, grouped, no commit hashes), **Upgrade** (`/plugin marketplace update code-sketch`, then `/plugin update code-sketch@code-sketch`, then restart Claude Code), and **Known limitations** if any changed.
4. Check it: `gh release view vX.Y.Z` and `claude plugin update code-sketch@code-sketch` shows the new version.
