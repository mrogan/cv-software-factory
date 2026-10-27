# Sourced by worktree.sh, copilot.sh and verify.sh, and by its test: the repository a work item's key names, and where it is checked out.
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
    [[ -e $checkout/.git ]] || { echo "no checkout of the app at $checkout: set APP_DIR" >&2; exit 2; }
    checkout=$(cd "$checkout" && pwd)
  fi
  repo=$(repo_of "$checkout")
  if [[ $key == app-* && $repo != */cv-worlds-worst-website ]]; then
    echo "$checkout is a checkout of $repo, not the app's: set APP_DIR" >&2; exit 2
  fi
}
# own_commits <worktree>: how many commits its HEAD has that no branch on its origin has. A worktree is made from
# origin/main or, in a stack, from the branch below, which is pushed, so this counts what was added since, either way.
own_commits() {
  git -C "$1" rev-list --count HEAD --not --remotes=origin
}
# repo_of <checkout>: owner/name of its origin on GitHub, read from git rather than asked of GitHub.
repo_of() {
  git -C "$1" remote get-url origin | sed -E 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)##; s#\.git$##'
}
