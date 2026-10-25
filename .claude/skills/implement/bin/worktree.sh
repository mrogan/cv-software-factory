#!/usr/bin/env bash
# Makes a pull request's worktree and prints its path: worktree.sh <key> <type>/<short-name> [base]
# The key is the work item's (278, station-order), or 278-2 for its second pull request; one that begins app-
# (app-flag-context) makes a worktree of the app's repository, from its checkout (repo.sh). The base is origin/main, of
# that repository, unless the pull request is stacked on another's branch. Refuses (exit 3) if the worktree or the
# branch already exists, in that checkout or on its origin: someone else owns it.
set -euo pipefail
(( $# == 2 || $# == 3 )) || { echo "usage: worktree.sh <key> <type>/<short-name> [base]" >&2; exit 2; }
branch=$2 base=${3:-origin/main}
. "$(dirname "$0")/repo.sh"
for_key "$1"
git -C "$checkout" fetch -q origin
if [[ -e $wt ]]; then echo "blocked: $wt exists" >&2; exit 3; fi
if git -C "$checkout" show-ref -q --verify "refs/heads/$branch"; then echo "blocked: branch $branch exists" >&2; exit 3; fi
if git -C "$checkout" ls-remote -q --exit-code --heads origin "$branch" >/dev/null; then
  echo "blocked: branch $branch exists on origin" >&2; exit 3
fi
git -C "$checkout" worktree add -q --no-track "$wt" -b "$branch" "$base"
echo "$wt"
