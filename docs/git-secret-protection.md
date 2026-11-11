# Git secret protection

Health Voice uses Gitleaks 8.30.1 or newer and Python 3 through native Git hooks.
There are no application dependencies or runtime changes. Gitleaks uses its built-in
rules plus a provider credential/password assignment rule in `.gitleaks.toml`.
Only code references and two exact existing test placeholders are allowlisted;
no source directories, real findings, or baseline reports are excluded.

## Final publication review — 11 November 2026

- Verified in authenticated GitHub: `AgoraIO-Community/agora-health-voice` is
  private, with one branch (`main`) and no tags. Remote `main`, local `main`,
  `HEAD` and the local tracking ref match
  `100104247f58adf98231b8401ec7550fe43a9200`. The working tree was clean before
  this review; the final documentation edits remain unstaged and uncommitted.
- Gitleaks **8.30.1** passed the complete non-shallow local history scan: all
  **four commits** reachable from refs/reflogs, including every tree and commit
  message. `git fsck --full --no-reflogs --unreachable` reported no unreachable
  objects. GitHub's visible history also reports four commits.
- `secret_guard.py staged` passed the existing index. A separate working-file
  snapshot passed the same guard/configuration for all **27 tracked/unignored
  files**, including the final documentation edits. The staged scan alone does
  not cover unstaged edits or untracked files.
- `scripts/test_secret_guard.py` passed all **11 reported checks** in disposable
  repositories. No project commits or pushes were performed by those tests.
- `npm run check` passed and `npm test` passed **32/32 tests**, with no failures,
  skips or cancellations. Agora/Garmin requests were mocked; no live Agora or
  Garmin tests were repeated. Tests regenerated only ignored `dist/` output.
- Reviewed the current files and historical file inventory: no personal health
  files, credential files, session recordings or private artifacts were found
  in the publication content. The health fixture is fictional. The documented
  owner-confirmed live result includes no personal count, exact prompt or date.
  Pattern scanning cannot generally detect personal health data.
- `.env` is ignored and untracked; dependencies, generated output, logs and common
  credential containers are excluded. `.env.example` is tracked and scanned.
  Ignored local credentials and generated files are outside the publication
  snapshot and are not claimed to be secret-free. No credential values were
  printed or copied. Publish reviewed Git contents, not a local-folder archive.
- Only README/provider/license-status/audit documentation changed. The standard
  MIT `LICENSE` already contains `Copyright (c) 2026 Agora, Inc.`. No application
  code, configuration, dependency, test source, index, remote URL or history was
  changed. No visibility change or Recipes submission was performed.

This review supersedes the earlier three-commit audit. Any later changes need a
new working-file scan; run the staged guard after staging and before an authorized
commit. Hooks are local, bypassable protections and must be installed per clone.

## Install after cloning

```sh
brew install gitleaks  # only if not already installed
sh scripts/install_secret_hooks.sh
git config --local --get core.hooksPath  # expected: .githooks
```

Installation applies only to this repository and refuses to replace other hooks.
Git does not automatically install hooks when cloning. The hook scripts also locate
Homebrew Gitleaks when a graphical Git client has a restricted PATH. Python 3 and Git
must be available to that client. Missing tools, scan failures, and malformed push
input block the operation.

## Verify before future commits and pushes

```sh
git add <intended-files>
python3 scripts/secret_guard.py staged
git commit
python3 scripts/secret_guard.py history
python3 scripts/test_secret_guard.py
```

Normal `git commit` scans the complete staged index, including partially staged
files, without reading unstaged replacements. Normal `git push` invokes the
pre-push hook: every outgoing commit tree and commit message is scanned, including
secrets introduced and subsequently removed. All updates on pre-push stdin are
handled. New branches and unavailable remote tips conservatively scan all local
ancestry. Ref deletions send no content. Annotated tag messages are also scanned.
No network push is needed to run the verification tests.

The test procedure uses only temporary repositories with runtime-generated dummy
tokens. It checks clean commits, staged-content rejection, removed historical
secrets, new branches, multiple ref updates, tags, ignore patterns, and failure
with an unusable scanner. It does not change this project's index or history.
Reports expose only rule, path, line, and commit; matched content is withheld.

If a scan reports a possible real secret, stop and review its location privately.
Do not commit, push, add a broad exclusion, rewrite history, or change credentials
as part of this verification procedure.

## Limits

Pattern scanning cannot prove the absence of every secret. Binary/encrypted
content, LFS payloads, unusual encodings, unknown credential formats, archives
beyond three nested levels, and encodings beyond five decoding levels need
additional review. Submodules and tags pointing to non-commit objects are blocked
for separate review; shallow history also blocks a full history/push scan.
Ignored local files are not part of the Git audit; their credentials were not
validated by this review. Ignore patterns do not untrack files already
committed and can be overridden by `git add -f`.

Local hooks can be bypassed with `--no-verify` or changed/disabled in local Git
configuration. They protect clients that honor Git hooks, not remote servers or
other clones. Review changes to these security files, reinstall in each clone,
and use server-side checks if enforcement beyond this machine is required.
