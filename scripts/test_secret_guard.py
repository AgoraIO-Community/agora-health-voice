#!/usr/bin/env python3
"""Exercise hooks in an isolated disposable repository. Never touch the real index."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

SOURCE = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='health-voice-hook-test-') as directory:
        root = Path(directory)
        env = os.environ.copy()
        for key in list(env):
            if key.startswith('GIT_'):
                env.pop(key)
        env['GIT_CONFIG_GLOBAL'] = os.devnull
        env['GIT_CONFIG_NOSYSTEM'] = '1'

        def run(*args, expected=0, data=None):
            result = subprocess.run(args, cwd=root, env=env, input=data,
                                    text=True, capture_output=True)
            if result.returncode != expected:
                raise RuntimeError('Unexpected test result for ' + args[0] + '; output withheld.')
            return result.stdout.strip()

        for relative in ('.githooks', 'scripts'):
            shutil.copytree(SOURCE / relative, root / relative)
        shutil.copy2(SOURCE / '.gitleaks.toml', root / '.gitleaks.toml')
        shutil.copy2(SOURCE / '.gitignore', root / '.gitignore')
        run('git', 'init', '-q')
        run('git', 'config', 'user.name', 'Secret guard test')
        run('git', 'config', 'user.email', 'secret-guard-test@example.invalid')
        run('git', 'config', 'core.hooksPath', '.githooks')
        (root / 'safe.txt').write_text('safe content\n')
        run('git', 'add', '.')
        run('git', 'commit', '-qm', 'Clean baseline')
        baseline = run('git', 'rev-parse', 'HEAD')
        print('PASS: clean commit succeeds through the installed pre-commit hook')

        for path in ('.env', '.env.local', 'credentials.json', 'config/credentials.json',
                     '.npmrc', 'service-account.json', 'private.pem', 'node_modules/probe',
                     'dist/probe', 'coverage/probe', 'build/probe'):
            run('git', 'check-ignore', '-q', path)
        run('git', 'check-ignore', '-q', '.env.example', expected=1)
        print('PASS: credential, dependency and artifact exclusions; example stays trackable')

        # Construct a disposable token at runtime so the test source has no literal secret.
        token = 'gh' + 'p_' + uuid.uuid4().hex + uuid.uuid4().hex[:4]
        (root / 'ordinary.txt').write_text('provider_value=' + token + '\n')
        run('git', 'add', 'ordinary.txt')
        (root / 'ordinary.txt').write_text('safe working copy\n')
        run('git', 'commit', '-qm', 'Must be blocked', expected=1)
        assert run('git', 'rev-parse', 'HEAD') == baseline
        print('PASS: synthetic secret rejected from staged content even with a clean working copy')

        # Bypass only in this disposable repo to create a leaked-then-removed history.
        run('git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic historical test')
        leaked = run('git', 'rev-parse', 'HEAD')
        run('git', 'add', 'ordinary.txt')
        run('git', 'commit', '-qm', 'Remove synthetic token')
        tip = run('git', 'rev-parse', 'HEAD')
        zeros = '0' * len(tip)
        run('.githooks/pre-push', data=f'refs/heads/main {tip} refs/heads/main {baseline}\n', expected=1)
        print('PASS: outgoing range rejects a secret removed before the tip commit')
        run('.githooks/pre-push', data=f'refs/heads/new {tip} refs/heads/new {zeros}\n', expected=1)
        print('PASS: new branch push scans complete ancestry')
        run('.githooks/pre-push', data=f'refs/heads/clean {baseline} refs/heads/clean {zeros}\n')
        run('.githooks/pre-push', data=f'(delete) {zeros} refs/heads/old {leaked}\n')
        print('PASS: clean outgoing history and ref deletion succeed')
        run('.githooks/pre-push', data=(f'refs/heads/clean {baseline} refs/heads/clean {zeros}\n'
                                     f'refs/heads/main {tip} refs/heads/main {baseline}\n'), expected=1)
        run('.githooks/pre-push', data='malformed input\n', expected=1)
        print('PASS: multiple ref updates are scanned; malformed input fails closed')
        run('python3', 'scripts/secret_guard.py', 'history', expected=1)
        print('PASS: full history audit rejects synthetic historical secret')

        # Annotated tag messages are inspected even when the target commit is clean.
        run('git', 'tag', '-a', 'synthetic-tag', baseline, '-m', 'provider_value=' + token)
        tag = run('git', 'rev-parse', 'synthetic-tag')
        run('.githooks/pre-push', data=f'refs/tags/synthetic-tag {tag} refs/tags/synthetic-tag {zeros}\n', expected=1)
        print('PASS: annotated tag message secret is rejected')

        (root / 'ordinary.txt').write_text('AGORA_APP_CERTIFICATE=' + uuid.uuid4().hex + '\n')
        run('git', 'add', 'ordinary.txt')
        run('.githooks/pre-commit', expected=1)
        print('PASS: provider credential without a vendor token prefix is rejected')
        (root / 'ordinary.txt').write_text('safe content\n')
        run('git', 'add', 'ordinary.txt')
        fakebin = root / 'fakebin'
        fakebin.mkdir()
        fake = fakebin / 'gitleaks'
        fake.write_text('#!/bin/sh\necho 0.0.0\n')
        fake.chmod(0o755)
        env['PATH'] = str(fakebin) + os.pathsep + env['PATH']
        run('.githooks/pre-commit', expected=1)
        print('PASS: unusable scanner fails closed')
        print('All checks passed; no network push or changes to the project index/history.')


if __name__ == '__main__':
    main()
