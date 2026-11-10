#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
current=$(git config --get core.hooksPath || :)
if [ -n "$current" ] && [ "$current" != '.githooks' ]; then
  echo 'An existing hooks path is configured; installation stopped to preserve it.' >&2
  exit 1
fi
if [ -z "$current" ]; then
  hooks=$(git rev-parse --git-path hooks)
  for name in pre-commit pre-push; do
    if [ -f "$hooks/$name" ]; then
      echo 'An existing hook needs review; installation stopped to preserve it.' >&2
      exit 1
    fi
  done
fi
python3 scripts/secret_guard.py staged
chmod +x .githooks/pre-commit .githooks/pre-push
git config --local core.hooksPath .githooks
echo 'Health Voice pre-commit and pre-push protection installed for this repository.'
