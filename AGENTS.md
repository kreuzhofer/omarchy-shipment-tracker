## Agent skills

### Issue tracker

Issues live in GitHub Issues for kreuzhofer/omarchy-shipment-tracker, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Layout

The repo root is the Omarchy plugin folder: `omarchy plugin add <git-url>` clones the whole repo and loads `manifest.json` from the root. The widget's QML/JS sit at the root, the CLI in `cli/`, the pinned mail server in `mail-server/`. Dev-only material lives in `test/`, `docs/`, `scripts/` and `.agents/`; nothing there is loaded by the shell.

- No symlinks anywhere in the tree: `omarchy plugin validate` rejects them. `.claude/skills` is a local, untracked set of links (`scripts/link-claude-skills.sh`).
- Code resolves plugin paths relative to its own file (`import.meta.url`, `Qt.resolvedUrl`), never from the repo layout or the install dir name.
- Runtime data goes to `~/.local/state` and `~/.local/share`, never into the plugin folder; `mail-server/node_modules` is the one exception and is gitignored.
- Check a change with `omarchy plugin validate` on a fresh clone, and live with `scripts/dev-install.sh`.
