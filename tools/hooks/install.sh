#!/bin/sh
#
# Install the repo's git hooks into .git/hooks/. Run once after cloning:
#
#   tools/hooks/install.sh

set -e

root=$(git rev-parse --show-toplevel)
src="$root/tools/hooks"
dst="$root/$(git rev-parse --git-path hooks)"

for hook in pre-commit; do
  cp "$src/$hook" "$dst/$hook"
  chmod +x "$dst/$hook"
  echo "installed $hook"
done
