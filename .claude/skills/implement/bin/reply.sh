#!/usr/bin/env bash
# Replies to a review thread, and resolves it unless told to leave it open: reply.sh <thread-id> <body> [--open]
# Thread ids (PRRT_…) are the ones copilot.sh lists.
set -euo pipefail
thread=${1:?usage: reply.sh <thread-id> <body> [--open]} body=${2:?reply body} keep=${3:-}
gh api graphql -F thread="$thread" -F body="$body" -f query='
  mutation($thread:ID!, $body:String!) {
    addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread, body:$body}) { comment { url } }
  }' -q .data.addPullRequestReviewThreadReply.comment.url
if [[ $keep != --open ]]; then
  gh api graphql -F thread="$thread" -f query='
    mutation($thread:ID!) { resolveReviewThread(input:{threadId:$thread}) { thread { isResolved } } }' \
    -q '"resolved: \(.data.resolveReviewThread.thread.isResolved)"'
fi
