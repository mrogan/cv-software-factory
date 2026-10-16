#!/usr/bin/env bash
# Makes a run's directory and prints its path: run.sh <key>...
# A key is an issue's number (278) or a brief's slug (station-order). Runs on one day stay apart: -2, -3.
set -euo pipefail
(( $# )) || { echo "usage: run.sh <key>..." >&2; exit 2; }
root=$(git rev-parse --path-format=absolute --git-common-dir)/..
root=$(cd "$root" && pwd)
keys=$(printf '%s\n' "$@" | tr -d '#' | paste -sd- -)
base="$root/scratch/implement/$(date +%F)-$keys"
dir=$base n=1
while [[ -e $dir ]]; do n=$((n + 1)); dir="$base-$n"; done
mkdir -p "$dir"
echo "$dir"
