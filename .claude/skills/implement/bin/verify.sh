#!/usr/bin/env bash
# Checks a sub-agent's report against GitHub and git.
#   verify.sh <key> <pr>   pr-open: the pull request is open, from the worktree's branch at its pushed HEAD, with
#                          nothing uncommitted; an issue's says Closes (or Part of) #<n>; every file it changes that
#                          CODEOWNERS gives Martin has a line in the description's section on them (a heading naming
#                          CODEOWNERS), with words beside the path. Whether those words are a good reason is left to
#                          the reader. Once Copilot has reviewed, a comment on the pull request from us, posted after
#                          its review and beginning "Copilot's review summary:", answers the review's summary; until
#                          Copilot has reviewed, an hour from the opening, the pull request is not ready, as Copilot
#                          can take half an hour. Shows checks and threads. A pull request Martin has merged passes on
#                          what is left to check (its description, checks, threads and summary): its worktree may be
#                          gone, and its branch may have moved under his own update.
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
    ahead=$(git -C "$wt" rev-list --count origin/main..HEAD)
    (( ahead == 0 )) || bad commits "$ahead commit(s) on $branch"
    [[ -z $(git -C "$wt" status --porcelain) ]] || bad worktree "uncommitted changes in $wt"
    if git -C "$root" ls-remote -q --exit-code --heads origin "$branch" >/dev/null; then bad branch "$branch was pushed"; fi
    open=$(gh pr list --head "$branch" --state all --json number -q '[.[].number] | join(" ")')
    [[ -z $open ]] || bad pr "pull request(s) from $branch: $open"
  else
    say worktree "none"
  fi
  exit $fail
fi

IFS=$'\t' read -r state branch head opened < <(gh pr view "$pr" --json state,headRefName,headRefOid,createdAt \
  -q '[.state, .headRefName, .headRefOid, (.createdAt | fromdateiso8601)] | @tsv')
body=$(gh pr view "$pr" --json body -q .body)
say pr "#$pr $state $branch ${head:0:8}"
[[ $state == OPEN || $state == MERGED ]] || bad state "pull request is $state"
if [[ $key =~ ^([0-9]+)(-[0-9]+)?$ ]]; then
  issue=${BASH_REMATCH[1]}
  grep -qiE "(closes|part of) #$issue\b" <<<"$body" || bad body "no 'Closes #$issue' or 'Part of #$issue'"
fi

# Every changed file CODEOWNERS gives Martin has a line in the description's section on them, with its reason beside it.
owners=$(git -C "$root" show origin/main:.github/CODEOWNERS | sed 's/#.*//' | awk 'NF { print $1 }')
files=$(gh pr diff "$pr" --name-only)
owned=()
while IFS= read -r file; do
  while IFS= read -r pattern; do
    # As GitHub reads them: globs, a folder owns what is in it, and a pattern with no slash but a trailing one is
    # unanchored, matching at any depth. Unquoted on purpose: the patterns are globs.
    p=${pattern#/} p=${p//\*\*/*} p=${p%/}
    at=''
    [[ $pattern == /* || $p == */* ]] || at='*/'
    # shellcheck disable=SC2053
    if [[ $file == $p || $file == $p/* || $file == $at$p || $file == $at$p/* ]]; then owned+=("$file"); break; fi
  done <<<"$owners"
done <<<"$files"
say owned "${#owned[@]} file(s) CODEOWNERS gives Martin"
section=$(awk '/^#+ / { inside = /CODEOWNERS/; next } inside' <<<"$body")
if (( ${#owned[@]} )) && [[ -z $section ]]; then bad owned "no section on them: a heading naming CODEOWNERS"; fi
for file in ${owned[@]+"${owned[@]}"}; do
  line=$(grep -F "$file" <<<"$section" | head -1 || true)
  words=$(tr -d '`*' <<<"${line//"$file"/}" | tr -cs '[:alnum:]' '\n' | grep -c . || true)
  if [[ -z $line ]]; then bad owned "$file changes and the section does not name it"
  elif (( words < 3 )); then bad owned "$file is named with no reason beside it"; fi
done

if [[ $state == MERGED ]]; then
  say worktree "not checked: merged"
elif [[ -d $wt ]]; then
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

# Copilot's summary can name findings no thread carries, so the worker answers it once in a comment. Whether the
# answer is right is the reader's to judge; that there is one, after the review, is checked here.
reviewed=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate \
  -q '[.[] | select(.user.login | startswith("copilot-pull-request-reviewer")) | .submitted_at] | last // empty')
if [[ -z $reviewed ]]; then
  if (( $(date +%s) - opened < 3600 )); then
    bad summary "Copilot has not reviewed yet: run copilot.sh $pr again, until an hour from the opening"
  else
    say summary "Copilot did not review within an hour of the opening"
  fi
else
  me=$(gh api user -q .login)
  answer=$(gh api "repos/$repo/issues/$pr/comments" --paginate -q "[.[] | select(.user.login == \"$me\"
    and .created_at > \"$reviewed\" and (.body | startswith(\"Copilot's review summary:\"))) | .html_url] | first // empty")
  if [[ -n $answer ]]; then say summary "answered $answer"
  else bad summary "no comment from $me after Copilot's review begins \"Copilot's review summary:\""; fi
fi
exit $fail
