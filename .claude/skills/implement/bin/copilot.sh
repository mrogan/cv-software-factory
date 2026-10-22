#!/usr/bin/env bash
# Waits for Copilot's one review of a pull request, then lists the unresolved threads: copilot.sh <pr> [minutes]
# The wait counts from when the pull request opened (an hour by default: Copilot has taken half an hour). Exit 0 once Copilot has reviewed, 4 if it
# did not in time; the threads are listed either way, one block each: thread id, path:line, author, url, the first
# comment. A thread someone other than Copilot started is marked NOT COPILOT: it is theirs to resolve, not the worker's.
# Then Copilot's review summary, as written, with only its HTML tags taken out (by name, so `Result<T>` stays): it can
# name findings that have no thread, and its shape changes, so it is printed for the worker to read rather than parsed.
set -euo pipefail
pr=${1:?usage: copilot.sh <pr> [minutes]} minutes=${2:-60}
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
opened=$(gh pr view "$pr" --json createdAt -q '.createdAt | fromdateiso8601')
deadline=$(( opened + minutes * 60 ))
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
    | (.comments.nodes[0].author.login) as $who
    | "\n\(.id)  \(.path):\(.line // "-")  (\($who))\(if ($who | startswith("copilot")) then "" else "  NOT COPILOT" end)\n\(.comments.nodes[0].url)\n\(.comments.nodes[0].body)"'
gh api "repos/$repo/pulls/$pr/reviews" --paginate \
  -q '[.[] | select(.user.login | startswith("copilot-pull-request-reviewer"))] | last | select(. != null)
    | "\n--- Copilot'"'"'s review summary (\(.submitted_at)), \(.html_url)\n\(.body)"' \
  | sed -E -e 's/<!--[^>]*-->//g' \
    -e 's#</?(picture|source|img|details|summary|sub|sup|br|p|div|span|b|strong|em|code|a)( [^>]*)?/?>##g' | cat -s
exit $status
