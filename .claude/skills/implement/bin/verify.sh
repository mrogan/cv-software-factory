#!/usr/bin/env bash
# Checks a sub-agent's report against GitHub and git.
#   verify.sh <key> <pr>   pr-open: the pull request is open, from the worktree's branch at its pushed HEAD, with
#                          nothing uncommitted; an issue's says Closes (or Part of) #<n>; every file it changes that
#                          CODEOWNERS gives Martin has a line in the description's section on them (a heading naming
#                          CODEOWNERS), with words beside the path. Whether those words are a good reason is left to
#                          the reader. Shows checks and threads.
#   verify.sh <key>        skipped: nothing was left behind, no branch pushed and no pull request opened.
# A key of 278-2 is issue 278's second pull request. Exit 1 on any mismatch.
set -euo pipefail
key=${1:?usage: verify.sh <key> [pr]} key=${key#\#} pr=${2:-}
root=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
wt="$root/scratch/worktrees/$key"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fail=0
say() { printf '%-9s %s\n' "$1" "$2"; }
bad() { say "$1" "MISMATCH: $2"; fail=1; }

if [[ -z $pr ]]; then
  if [[ -d $wt ]]; then
    branch=$(git -C "$wt" branch --show-current)
    say worktree "$wt on $branch"
    if git -C "$root" ls-remote -q --exit-code --heads origin "$branch" >/dev/null; then bad branch "$branch was pushed"; fi
    open=$(gh pr list --head "$branch" --state all --json number -q '[.[].number] | join(" ")')
    [[ -z $open ]] || bad pr "pull request(s) from $branch: $open"
  else
    say worktree "none"
  fi
  exit $fail
fi

IFS=$'\t' read -r state branch head < <(gh pr view "$pr" --json state,headRefName,headRefOid \
  -q '[.state, .headRefName, .headRefOid] | @tsv')
body=$(gh pr view "$pr" --json body -q .body)
say pr "#$pr $state $branch ${head:0:8}"
[[ $state == OPEN ]] || bad state "pull request is $state"
if [[ $key =~ ^([0-9]+)(-[0-9]+)?$ ]]; then
  issue=${BASH_REMATCH[1]}
  grep -qiE "(closes|part of) #$issue\b" <<<"$body" || bad body "no 'Closes #$issue' or 'Part of #$issue'"
fi

# Every changed file CODEOWNERS gives Martin has a line in the description's section on them, with its reason beside it.
owners=$(git -C "$root" show origin/main:.github/CODEOWNERS | sed 's/#.*//' | awk 'NF { print $1 }')
owned=()
while IFS= read -r file; do
  while IFS= read -r pattern; do
    p=${pattern#/}
    if [[ $file == "$p" || ( $p == */ && $file == "$p"* ) || $file == "$p/"* ]]; then owned+=("$file"); break; fi
  done <<<"$owners"
done < <(gh pr diff "$pr" --name-only)
say owned "${#owned[@]} file(s) CODEOWNERS gives Martin"
section=$(awk '/^#+ / { inside = /CODEOWNERS/; next } inside' <<<"$body")
if (( ${#owned[@]} )) && [[ -z $section ]]; then bad owned "no section on them: a heading naming CODEOWNERS"; fi
for file in ${owned[@]+"${owned[@]}"}; do
  line=$(grep -F "$file" <<<"$section" | head -1 || true)
  words=$(tr -d '`*' <<<"${line//"$file"/}" | tr -cs '[:alnum:]' '\n' | grep -c . || true)
  if [[ -z $line ]]; then bad owned "$file changes and the section does not name it"
  elif (( words < 3 )); then bad owned "$file is named with no reason beside it"; fi
done

if [[ -d $wt ]]; then
  wt_branch=$(git -C "$wt" branch --show-current)
  wt_head=$(git -C "$wt" rev-parse HEAD)
  [[ $wt_branch == "$branch" ]] || bad branch "worktree on $wt_branch, pull request from $branch"
  [[ $wt_head == "$head" ]] || bad head "worktree at ${wt_head:0:8}, pull request at ${head:0:8}"
  [[ -z $(git -C "$wt" status --porcelain) ]] || bad worktree "uncommitted changes in $wt"
else
  bad worktree "no worktree at $wt"
fi

say checks "$(gh pr checks "$pr" --json state -q '[.[].state] | group_by(.) | map("\(.[0]) \(length)") | join(", ")')"
say threads "$(gh api graphql -F owner="${repo%/*}" -F name="${repo#*/}" -F n="$pr" -f query='
  query($owner:String!, $name:String!, $n:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$n) {
    reviewThreads(first:100) { nodes { isResolved } } } } }' \
  -q '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length') unresolved"
exit $fail
