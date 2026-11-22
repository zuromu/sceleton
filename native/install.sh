#!/usr/bin/env bash
# Sets up Sceleton's optional helper, so the "notes app" files are written
# straight into a folder of your choice with no download prompts.
#
#   bash native/install.sh <folder> [extension id ...]
#
# <folder> is where deadlines.md, semester.md and courses/ should go, for
# example a folder inside your Obsidian vault. The extension id is on the
# extensions page of your browser (edge://extensions or chrome://extensions).
set -eu
[ $# -ge 1 ] || { echo "usage: bash native/install.sh <folder> [extension id ...]"; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mkdir -p "$1" && cd "$1" && pwd)"; shift

conf="$HOME/.config/sceleton"
mkdir -p "$conf"
cp "$here/sceleton_vault.py" "$conf/sceleton_vault.py"
chmod 755 "$conf/sceleton_vault.py"
python3 - "$dir" "$conf/vault.json" <<'PY'
import json, sys
json.dump({"dir": sys.argv[1]}, open(sys.argv[2], "w"))
PY

origins=""
for id in "$@"; do origins="$origins\"chrome-extension://$id/\","; done
[ -n "$origins" ] || { echo "give at least one extension id"; exit 2; }
for hosts in \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
  "$HOME/.config/google-chrome/NativeMessagingHosts"; do
  case "$hosts" in "$HOME/Library/"*) [ "$(uname)" = Darwin ] || continue ;; *) [ "$(uname)" = Linux ] || continue ;; esac
  mkdir -p "$hosts"
  cat > "$hosts/com.sceleton.vault.json" <<JSON
{
  "name": "com.sceleton.vault",
  "description": "Sceleton: saves your SCeLE notes into a folder",
  "path": "$conf/sceleton_vault.py",
  "type": "stdio",
  "allowed_origins": [${origins%,}]
}
JSON
done
echo "Sceleton will write to: $dir"
echo "Reload the extension, then switch on \"Deadlines file for a notes app\" in its settings."
