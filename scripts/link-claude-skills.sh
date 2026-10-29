#!/usr/bin/env bash
# Point Claude Code at the agent skills in .agents/skills by linking each one
# into .claude/skills. The links are not committed: the repo root is the
# Omarchy plugin folder, and the plugin validator refuses any symlink in it.
# Safe to run again; it only adds missing links.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.claude/skills"
for skill in "$root"/.agents/skills/*/; do
  name="$(basename "$skill")"
  link="$root/.claude/skills/$name"
  [[ -e $link || -L $link ]] || ln -s "../../.agents/skills/$name" "$link"
done
echo "Linked $(ls "$root/.claude/skills" | wc -l) skills into .claude/skills"
