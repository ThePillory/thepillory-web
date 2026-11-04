#!/usr/bin/env bash
# Commit a data workflow's files and push them, for every workflow that commits to
# the repository (.github/workflows/*.yml, "Commit the data"):
#
#   bash tools/commit_data.sh "Refresh X from Y" data/x data/y.json
#
# Nothing staged: nothing to do. Otherwise one commit, then pull --rebase and push,
# up to 3 tries with a short wait, so another workflow's push at the same moment
# ("rejected (fetch first)") doesn't fail the run. The workflows also share one
# concurrency group (data-commit), so two of them rarely get here together.
set -euo pipefail

message="$1"
shift
branch="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -- "$@"
if git diff --cached --quiet; then
  echo "Nothing changed."
  exit 0
fi
git commit -q -m "$message"

for try in 1 2 3; do
  if git pull --rebase -q origin "$branch" && git push -q origin "HEAD:$branch"; then
    echo "Pushed to $branch (try $try)."
    exit 0
  fi
  # A rebase that stopped on a conflict is undone before the next try.
  git rebase --abort 2>/dev/null || true
  if [ "$try" -lt 3 ]; then
    echo "Push didn't go through (try $try); trying again in $((try * 10)) s."
    sleep $((try * 10))
  fi
done
echo "Couldn't push after 3 tries." >&2
exit 1
