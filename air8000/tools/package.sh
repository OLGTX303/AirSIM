#!/usr/bin/env sh
set -eu
out=${1:-airsim-air8000-bundle.zip}
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
rm -f "$out"
(cd "$root" && zip -qr "$OLDPWD/$out" . -x 'config.lua' 'tests/*')
echo "Created $out; flash with LuatTools after reviewing config.lua."
