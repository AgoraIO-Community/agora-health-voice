#!/usr/bin/env python3
"""Scan Git object contents; never display matched text or scanner diagnostics."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / '.gitleaks.toml'


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True)
    if result.returncode:
        raise RuntimeError('Git inspection failed; operation blocked.')
    return result.stdout


def scanner():
    executable = shutil.which('gitleaks')
    if not executable:
        for candidate in ('/opt/homebrew/bin/gitleaks', '/usr/local/bin/gitleaks'):
            if os.access(candidate, os.X_OK):
                executable = candidate
                break
    if not executable:
        raise RuntimeError('Gitleaks is missing. Install with brew install gitleaks; operation blocked.')
    result = subprocess.run([executable, 'version'], capture_output=True, text=True)
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', result.stdout)
    if result.returncode or not match or tuple(map(int, match.groups())) < (8, 30, 1):
        raise RuntimeError('Gitleaks 8.30.1 or newer is required; operation blocked.')
    return executable


def safe_path(name):
    path = Path(os.fsdecode(name))
    if path.is_absolute() or '..' in path.parts:
        raise RuntimeError('Unsafe Git path; operation blocked.')
    return path


def snapshot(folder, revision=None):
    if revision is None:
        records = git('ls-files', '--stage', '-z').split(b'\0')
    else:
        records = git('ls-tree', '-r', '-z', revision).split(b'\0')
    for record in records:
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        if revision is None:
            mode, oid, stage = metadata.split()
            if stage != b'0':
                raise RuntimeError('Unmerged index; operation blocked.')
        else:
            mode, kind, oid = metadata.split()
        if mode == b'160000':
            raise RuntimeError('Submodules need a separate audit; operation blocked.')
        dest = folder / safe_path(name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Symlink blobs are inspected as text, never followed on disk.
        dest.write_bytes(git('cat-file', 'blob', oid.decode('ascii')))


def scan(executable, folder, label, temp):
    report = temp / 'report.json'
    report.unlink(missing_ok=True)
    env = os.environ.copy()
    env.pop('GITLEAKS_CONFIG', None)
    env.pop('GITLEAKS_CONFIG_TOML', None)
    result = subprocess.run([
        executable, 'dir', str(folder), '--config', str(CONFIG),
        '--redact=100', '--no-banner', '--no-color', '--ignore-gitleaks-allow',
        '--gitleaks-ignore-path', str(temp / 'no-ignores'),
        '--max-archive-depth', '3', '--max-decode-depth', '5',
        '--report-format', 'json', '--report-path', str(report),
    ], cwd=temp, env=env, capture_output=True)
    if result.returncode not in (0, 1) or not report.exists():
        raise RuntimeError('Secret scanner failed; operation blocked. Raw diagnostics withheld.')
    findings = json.loads(report.read_text()) or []
    for finding in findings:
        # Deliberately whitelist metadata fields; never print Match, Secret, or source.
        path = Path(finding['File']).relative_to(folder)
        print(json.dumps({'scope': label, 'type': finding['RuleID'],
                          'file': str(path), 'line': finding['StartLine']}), file=sys.stderr)
    if result.returncode or findings:
        raise RuntimeError('Possible secret detected; operation blocked. No credential or history changes made.')


def outgoing():
    commits = set()
    for line in sys.stdin:
        fields = line.split()
        if len(fields) != 4:
            raise RuntimeError('Invalid pre-push input; operation blocked.')
        local_ref, local_oid, remote_ref, remote_oid = fields
        if not all(re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', oid)
                   for oid in (local_oid, remote_oid)):
            raise RuntimeError('Invalid push object ID; operation blocked.')
        if set(local_oid) == {'0'}:
            continue  # Ref deletion sends no new content.
        # Peel annotated tags. Non-commit tags are blocked rather than silently skipped.
        tip = git('rev-parse', '--verify', local_oid + '^{commit}').decode().strip()
        args = ['rev-list', tip]
        if set(remote_oid) != {'0'}:
            check = subprocess.run(['git', 'rev-parse', '--verify', remote_oid + '^{commit}'],
                                   cwd=ROOT, capture_output=True)
            if check.returncode == 0:
                args += ['--not', check.stdout.decode().strip()]
            # Unknown remote tip: conservatively scan all local ancestry.
        commits.update(git(*args).decode().splitlines())
        # Annotated tag messages can contain secrets too.
        if git('cat-file', '-t', local_oid).strip() == b'tag':
            commits.add('tag:' + local_oid)
    return sorted(commits)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['staged', 'history', 'pre-push'])
    mode = parser.parse_args().mode
    executable = scanner()
    with tempfile.TemporaryDirectory(prefix='health-voice-secrets-') as directory:
        temp = Path(directory)
        if mode == 'staged':
            folder = temp / 'content'
            folder.mkdir()
            snapshot(folder)
            scan(executable, folder, 'staged index', temp)
            print('Secret scan passed: staged index contents.')
            return
        if git('rev-parse', '--is-shallow-repository').strip() == b'true':
            raise RuntimeError('History is shallow; full audit cannot be completed.')
        revisions = (git('rev-list', '--all', '--reflog').decode().splitlines()
                     if mode == 'history' else outgoing())
        if mode == 'history':
            for ref in git('for-each-ref', '--format=%(objecttype) %(objectname)').decode().splitlines():
                kind, oid = ref.split()
                if kind == 'tag':
                    revisions.append('tag:' + oid)
        for revision in revisions:
            folder = temp / 'content'
            folder.mkdir()
            if revision.startswith('tag:'):
                (folder / 'TAG_MESSAGE').write_bytes(git('cat-file', 'tag', revision[4:]))
            else:
                snapshot(folder, revision)
                # Keep metadata separate to avoid overwriting a tracked filename.
                messages = temp / 'metadata'
                messages.mkdir(exist_ok=True)
                (messages / 'COMMIT_MESSAGE').write_bytes(git('show', '-s', '--format=%B', revision))
                scan(executable, messages, revision + ' commit message', temp)
            scan(executable, folder, revision, temp)
            shutil.rmtree(folder)
        print(f'Secret scan passed: {len(revisions)} history/push objects.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        # Exception details from parsers/filesystems could contain content; show only our errors.
        print(str(error) if isinstance(error, RuntimeError) else
              'Secret protection failed; operation blocked. Raw diagnostics withheld.', file=sys.stderr)
        sys.exit(1)
