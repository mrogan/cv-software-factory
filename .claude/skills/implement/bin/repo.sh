# Sourced by worktree.sh, copilot.sh and verify.sh: the repository a work item's key names, and where it is checked out.
# A key that begins app- (app-flag-context) is a work item in the app's repository, checked out at APP_DIR, by default
# beside this one; any other key is this repository's. Every worktree lives under this checkout's
# scratch/worktrees/<key>, whichever repository it belongs to. `root` is this checkout, found from where the scripts
# are rather than from the current directory, so they work from either repository's worktrees.
root=$(cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
# for_key <key>: sets key (without a leading #), wt (its worktree), checkout (its repository's main checkout) and repo
# (owner/name, for gh's -R).
for_key() {
  key=${1#\#}
  wt="$root/scratch/worktrees/$key"
  checkout=$root
  if [[ $key == app-* ]]; then
    checkout=${APP_DIR:-$root/../cv-worlds-worst-website}
    [[ -d $checkout/.git ]] || { echo "no checkout of the app at $checkout: set APP_DIR" >&2; exit 2; }
    checkout=$(cd "$checkout" && pwd)
  fi
  repo=$(cd "$checkout" && gh repo view --json nameWithOwner -q .nameWithOwner)
}
