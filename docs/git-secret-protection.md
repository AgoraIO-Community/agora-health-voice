# Git secret protection

Health Voice uses Gitleaks 8.30.1 or newer and Python 3 through native Git hooks.
There are no application dependencies or runtime changes. Gitleaks uses its built-in
rules plus a provider credential/password assignment rule in `.gitleaks.toml`.
Only code references and two exact existing test placeholders are allowlisted;
no source directories, real findings, or baseline reports are excluded.

## Refreshed local audit — 10 November 2026

- Gitleaks **8.30.1** passed the complete non-shallow local history scan: three
  commits reachable from refs/reflogs, including each tree and commit message.
  The current tip is `9f89fdf`. `git fsck --full --no-reflogs --unreachable`
  reported no unreachable objects.
- The existing `secret_guard.py staged` check passed the current index. A separate
  working-file snapshot, scanned through the same guard and configuration, passed
  for all **27 tracked/unignored files**, including modified documentation and the
  untracked draft `LICENSE` and license review document. The staged scan alone
  does not include unstaged edits or untracked files.
- `scripts/test_secret_guard.py` passed all **11 reported checks** in disposable
  repositories. Intentional dummy findings were rejected as expected; none was
  exposed. These tests do not commit to or push this project.
- Confirmed `.env` is ignored and untracked. Common credential/key containers,
  dependency directories, generated `dist/`, build/coverage output and logs are
  ignored. `.env.example` remains tracked and was included in scanning.
- Reviewed the health fixture as explicitly fictional. No personal health-data
  file or session artifact is included in the tracked/unignored file inventory;
  the owner's spoken-steps validation is documented without a personal count,
  exact prompt or date. Secret-pattern scanning is not a general detector for
  personal health data, so future publication contents still need human review.
- Ignored local credentials, dependency contents and generated output are outside
  the publication snapshot; they are not claimed to be secret-free. No ignored
  `.env` values were printed or copied into the snapshot. The earlier baseline's
  credential-equality check was not repeated in this review.
- No application code, configuration, dependency or test source was modified.
  Offline application tests regenerated ignored `dist/` output. No live service
  calls, project commits, pushes or visibility changes were performed.

This refresh supersedes the earlier one-commit/17-file audit scope. Any later
change needs a new working-file check; run the installed staged guard after
staging and before an authorized commit. Hooks are local, bypassable protections.

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
Ignored local files are not part of the Git audit (the `.env` equality check above
does not validate those credentials). Ignore patterns do not untrack files already
committed and can be overridden by `git add -f`.

Local hooks can be bypassed with `--no-verify` or changed/disabled in local Git
configuration. They protect clients that honor Git hooks, not remote servers or
other clones. Review changes to these security files, reinstall in each clone,
and use server-side checks if enforcement beyond this machine is required.
