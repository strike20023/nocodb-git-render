'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  bootstrapRepository,
  extractCommitMessage,
  restoreSnapshot,
  sanitizeMessage,
  saveVersion,
  verifyBearer,
} = require('../service/server');

function command(binary, args, cwd, env = process.env) {
  return execFileSync(binary, args, { cwd, env, encoding: 'utf8' }).trim();
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nocodb-git-test-'));
  const remote = path.join(root, 'remote.git');
  const repoDir = path.join(root, 'repo');
  const liveDir = path.join(root, 'live');
  command('git', ['init', '--bare', '--initial-branch=main', remote], root);
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  const sqlite = path.join(fakeBin, 'sqlite3');
  fs.writeFileSync(
    sqlite,
    `#!/bin/sh
src="$1"
shift
for arg in "$@"; do
  case "$arg" in
    .backup*) dst=$(printf "%s" "$arg" | sed "s/^\\.backup '\\(.*\\)'$/\\1/"); cp "$src" "$dst";;
  esac
done
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;

  return {
    root,
    remote,
    cfg: {
      repoDir,
      liveDir,
      remoteUrl: remote,
      branch: 'main',
      authorName: 'Test Bot',
      authorEmail: 'test@example.com',
    },
  };
}

test('message extraction handles custom and default webhook bodies', () => {
  assert.equal(extractCommitMessage({ message: ' finish batch 13 ' }), 'finish batch 13');
  assert.equal(
    extractCommitMessage({ data: { rows: [{ CommitMessage: 'row message' }] } }),
    'row message',
  );
  assert.match(extractCommitMessage({}), /^NocoDB snapshot /);
  assert.equal(sanitizeMessage('one\n\ntwo\u0000'), 'one two');
});

test('bearer verification is strict', () => {
  assert.equal(verifyBearer('Bearer secret', 'secret'), true);
  assert.equal(verifyBearer('Bearer wrong', 'secret'), false);
  assert.equal(verifyBearer(undefined, 'secret'), false);
  assert.equal(verifyBearer('Bearer secret', ''), false);
});

test('save creates a consistent data commit and restore materializes it', () => {
  const { root, cfg } = makeFixture();
  try {
    bootstrapRepository(cfg);
    fs.mkdirSync(path.join(cfg.liveDir, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(cfg.liveDir, 'noco.db'), 'sqlite-v1');
    fs.writeFileSync(path.join(cfg.liveDir, 'noco.db-wal'), 'do-not-commit');
    fs.writeFileSync(path.join(cfg.liveDir, 'storage', 'image.txt'), 'image-v1');

    const saved = saveVersion(cfg, 'first snapshot');
    assert.equal(saved.changed, true);
    assert.equal(command('git', ['show', '-s', '--format=%s'], cfg.repoDir), 'first snapshot');
    assert.equal(fs.readFileSync(path.join(cfg.repoDir, 'data', 'noco.db'), 'utf8'), 'sqlite-v1');
    assert.equal(fs.existsSync(path.join(cfg.repoDir, 'data', 'noco.db-wal')), false);

    fs.writeFileSync(path.join(cfg.liveDir, 'noco.db'), 'damaged-local');
    restoreSnapshot(cfg);
    assert.equal(fs.readFileSync(path.join(cfg.liveDir, 'noco.db'), 'utf8'), 'sqlite-v1');

    const unchanged = saveVersion(cfg, 'no changes');
    assert.equal(unchanged.changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('save rejects a stale checkout after the remote advances', () => {
  const { root, remote, cfg } = makeFixture();
  try {
    bootstrapRepository(cfg);
    fs.mkdirSync(cfg.liveDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.liveDir, 'noco.db'), 'v1');
    saveVersion(cfg, 'initial');

    const other = path.join(root, 'other');
    command('git', ['clone', '--branch', 'main', remote, other], root);
    command('git', ['config', 'user.name', 'Other'], other);
    command('git', ['config', 'user.email', 'other@example.com'], other);
    fs.writeFileSync(path.join(other, 'README.md'), 'remote update');
    command('git', ['add', 'README.md'], other);
    command('git', ['commit', '-m', 'remote update'], other);
    command('git', ['push', 'origin', 'main'], other);

    fs.writeFileSync(path.join(cfg.liveDir, 'noco.db'), 'v2');
    assert.throws(() => saveVersion(cfg, 'stale'), /Remote has changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
