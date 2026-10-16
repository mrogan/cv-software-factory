#!/usr/bin/env bash
# Makes a pull request's worktree and prints its path: worktree.sh <key> <type>/<short-name> [base]
# The key is the work item's (278, station-order), or 278-2 for its second pull request. The base is origin/main unless
# the pull request is stacked on another's branch. Refuses (exit 3) if the worktree or the branch already exists, here
# or on origin: someone else owns it.
set -euo pipefail
(( $# == 2 || $# == 3 )) || { echo "usage: worktree.sh <key> <type>/<short-name> [base]" >&2; exit 2; }
key=${1#\#} branch=$2 base=${3:-origin/main}
root=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
wt="$root/scratch/worktrees/$key"
git -C "$root" fetch -q origin
if [[ -e $wt ]]; then echo "blocked: $wt exists" >&2; exit 3; fi
if git -C "$root" show-ref -q --verify "refs/heads/$branch"; then echo "blocked: branch $branch exists" >&2; exit 3; fi
if git -C "$root" ls-remote -q --exit-code --heads origin "$branch" >/dev/null; then
  echo "blocked: branch $branch exists on origin" >&2; exit 3
fi
git -C "$root" worktree add -q "$wt" -b "$branch" "$base"
echo "$wt"
