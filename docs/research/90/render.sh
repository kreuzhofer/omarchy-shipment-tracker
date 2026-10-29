#!/usr/bin/env bash
# Design study #90 (throwaway): render the opt-in variants A/B/C offscreen
# with synthetic data, the way earlier studies were rendered (real widget QML,
# the installed shell's Commons/Ui, scale 1.25).
#
#   docs/research/90/render.sh            -> docs/research/90-option-*.png
#
# Each variant is a copy of the plugin's QML with the files in
# docs/research/90/<V>/ on top. The Store copy is defanged: it never runs
# `install`, `clear-stale-logins` or systemctl, and XDG_STATE_HOME points at an
# empty temp dir, so nothing of the real state, plugin or timers is touched.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$repo/docs/research"
shell="${OMARCHY_PATH:-/usr/share/omarchy}/shell"
tmp="$(mktemp -d)"
[ -n "${KEEP:-}" ] || trap 'rm -rf "$tmp"' EXIT; echo "tmp=$tmp"

# The quickshell config (qs root) holds only the shell's Commons/Ui; the
# variants sit outside it and load by file URL, like a real plugin folder.
mkdir -p "$tmp/cfg" "$tmp/v"
cp -r "$shell/Commons" "$shell/Ui" "$tmp/cfg/"
cp "$here/shell.qml" "$tmp/cfg/"
mkdir -p "$tmp/state"

for v in main A B C; do
  mkdir -p "$tmp/v/$v"
  cp "$repo"/*.qml "$repo"/*.js "$tmp/v/$v/"
  [ "$v" != main ] && cp "$here/$v"/*.qml "$tmp/v/$v/"
  cp "$here/Scene.qml" "$tmp/v/$v/"
  sed -i \
    -e 's/^\(\s*\)installProcess.running = true/\1\/\/ harness: no install/' \
    -e 's/^\(\s*\)clearStaleProcess.running = true/\1\/\/ harness: no clear-stale-logins/' \
    -e 's/function checkTimer() {.*/function checkTimer() {}/' \
    -e 's/function runTimerCommand(command) {/function runTimerCommand(command) { return/' \
    "$tmp/v/$v/Store.qml"
  if grep -q 'installProcess.running = true\|clearStaleProcess.running = true' "$tmp/v/$v/Store.qml" \
    && ! grep -q 'harness: no install' "$tmp/v/$v/Store.qml"; then
    echo "Store.qml patch failed for $v" >&2; exit 1
  fi
  # Omarchy's shell patches plugin loading so a bare `Color` is the shell's
  # singleton; plain quickshell resolves it to QtQuick's Color. Qualify it.
  for f in "$tmp/v/$v"/*.qml; do
    grep -q '^import qs.Commons$' "$f" || continue
    sed -i -e 's/^import qs.Commons$/import qs.Commons\nimport qs.Commons as Commons/' \
      -e '/^import /!s/\([^.A-Za-z_]\)Color\./\1Commons.Color./g' "$f"
  done
done

shot() { # variant scene name
  XDG_STATE_HOME="$tmp/state" VARIANT="$tmp/v/$1" SCENE="$2" OUT="$tmp/$3.png" \
    QT_QPA_PLATFORM=offscreen QT_SCALE_FACTOR=1.25 \
    timeout 30 quickshell -p "$tmp/cfg/shell.qml" >"$tmp/$3.log" 2>&1 || true
  [ -s "$tmp/$3.png" ] || { echo "no frame for $3:" >&2; tail -20 "$tmp/$3.log" >&2; exit 1; }
  if grep -q 'ERROR\|TypeError\|ReferenceError' "$tmp/$3.log"; then grep 'ERROR\|TypeError\|ReferenceError' "$tmp/$3.log" >&2; fi
}

caption() { # in text out
  magick "$1" -background '#101315' -fill '#cacccc' -font /usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf -pointsize 18 \
    -gravity north -splice 0x40 -annotate +0+10 "$2" "$3"
}

# Baseline from main for reference.
shot main fresh-list main-fresh-list
shot main off-sources main-off-sources

# Per variant: (a) fresh install, (b) connected but off, (c) on.
declare -A frames=(
  [A]="fresh-sources off-list on-sources"
  [B]="fresh-list off-list on-sources"
  [C]="fresh-sources login-done on-sources"
)
declare -A extra=( [A]="" [B]="off-sources" [C]="off-sources" )
labels=("a  fresh install" "b  connected, background refresh off" "c  on")

for v in A B C; do
  i=0; parts=()
  for s in ${frames[$v]}; do
    shot "$v" "$s" "$v-$s"
    cp "$tmp/$v-$s.png" "$out/90-option-$v-$((i + 1))-$s.png"
    caption "$tmp/$v-$s.png" "$v · ${labels[$i]}" "$tmp/$v-cap-$i.png"
    parts+=("$tmp/$v-cap-$i.png"); i=$((i + 1))
  done
  for s in ${extra[$v]}; do
    shot "$v" "$s" "$v-$s"
    cp "$tmp/$v-$s.png" "$out/90-option-$v-x-$s.png"
  done
  magick "${parts[@]}" -background '#101315' -gravity north +append -bordercolor '#101315' -border 12 "$out/90-option-$v.png"
done

caption "$tmp/main-fresh-list.png" "main · fresh install today" "$tmp/m1.png"
caption "$tmp/main-off-sources.png" "main · Sources today" "$tmp/m2.png"
magick "$tmp/m1.png" "$tmp/m2.png" -background '#101315' -gravity north +append -bordercolor '#101315' -border 12 "$out/90-baseline.png"
echo "wrote $out/90-*.png"
