#!/usr/bin/env bash
# Copy this working tree into the user's Omarchy plugin dir for a live check.
# The repo root is the plugin folder, so this copies what a `git clone` would
# ship (everything but .git and what .gitignore excludes, such as the
# .claude/skills symlinks the plugin validator would reject).
# Copies instead of symlinking: symlinked plugin files don't hot-reload, and
# the plugin validator rejects symlinks. New files or IPC targets need
# `omarchy restart shell`; edits to existing files reload on their own.
set -euo pipefail
id=kreuzhofer.shipment-tracker
src="$(cd "$(dirname "$0")/.." && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/$id"
# A git-managed install (`omarchy plugin add`) updates with
# `omarchy plugin update`; copying a working tree over it would leave it with
# local changes that block the next update.
if [[ -e $dest/.git ]]; then
  echo "$dest is a git-managed install (omarchy plugin add)." >&2
  echo "Update it with: omarchy plugin update $id" >&2
  echo "Or, to switch back to a dev copy: omarchy plugin remove $id, then run this again." >&2
  exit 1
fi
mkdir -p "$dest"
# The mail server installs itself into mail-server/node_modules on first use;
# node_modules is in .gitignore, and excluded files are kept across installs.
rsync -a --delete --exclude=/.git --filter=':- .gitignore' "$src/" "$dest/"
if command -v omarchy-plugin-validate >/dev/null; then
  omarchy-plugin-validate "$dest"
fi
echo "Copied to $dest"
echo "First time: omarchy-shell shell rescanPlugins && omarchy plugin enable $id"
