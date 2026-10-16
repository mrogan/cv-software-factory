#!/usr/bin/env bash
# Waits for Copilot's one review of a pull request, then lists the unresolved threads: copilot.sh <pr> [minutes]
# The wait counts from when the pull request opened (15 minutes by default). Exit 0 once Copilot has reviewed, 4 if it
# did not in time; the threads are listed either way, one block each: thread id, path:line, url, the first comment.
set -euo pipefail
pr=${1:?usage: copilot.sh <pr> [minutes]} minutes=${2:-15}
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
opened=$(gh pr view "$pr" --json createdAt -q .createdAt)
deadline=$(( $(date -juf %Y-%m-%dT%H:%M:%SZ "$opened" +%s) + minutes * 60 ))
reviewed() {
  gh api "repos/$repo/pulls/$pr/reviews" --paginate \
    -q '[.[] | select(.user.login | startswith("copilot-pull-request-reviewer"))] | length'
}
status=0
until (( $(reviewed) > 0 )); do
  if (( $(date +%s) >= deadline )); then echo "copilot: no review within $minutes minutes of opening"; status=4; break; fi
  sleep 30
done
(( status )) || echo "copilot: reviewed"
gh api graphql -F owner="${repo%/*}" -F name="${repo#*/}" -F n="$pr" -f query='
  query($owner:String!, $name:String!, $n:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$n) {
    reviewThreads(first:100) { nodes { id isResolved path line comments(first:1) { nodes { author { login } url body } } } }
  } } }' -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)
    | "\n\(.id)  \(.path):\(.line // "-")  (\(.comments.nodes[0].author.login))\n\(.comments.nodes[0].url)\n\(.comments.nodes[0].body)"'
exit $status
