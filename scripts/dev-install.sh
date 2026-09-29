#!/usr/bin/env bash
# Copy the plugin into the user's Omarchy plugin dir for a live check.
# Copies instead of symlinking: symlinked plugin files don't hot-reload, and
# the plugin validator rejects symlinks. New files or IPC targets need
# `omarchy restart shell`; edits to existing files reload on their own.
set -euo pipefail
id=kreuzhofer.shipment-tracker
src="$(cd "$(dirname "$0")/../plugin" && pwd)"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/$id"
mkdir -p "$dest"
# The mail server installs itself into mail-server/node_modules on first use;
# keep that copy across installs.
rsync -a --delete --exclude node_modules/ "$src/" "$dest/"
echo "Copied to $dest"
echo "First time: omarchy-shell shell rescanPlugins && omarchy plugin enable $id"
