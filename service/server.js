'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULTS = Object.freeze({
  publicPort: 10000,
  internalPort: 8080,
  gitInternalPort: 9000,
  repoDir: '/var/lib/nocodb-git/repository',
  liveDir: '/var/lib/nocodb-live',
  branch: 'main',
  maxBodyBytes: 32 * 1024,
});

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function configFromEnv(env = process.env) {
  const publicPort = Number.parseInt(env.PORT || String(DEFAULTS.publicPort), 10);
  const internalPort = Number.parseInt(
    env.NOCODB_INTERNAL_PORT || String(DEFAULTS.internalPort),
    10,
  );
  const gitInternalPort = Number.parseInt(
    env.GIT_INTERNAL_PORT || String(DEFAULTS.gitInternalPort),
    10,
  );

  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535) {
    throw new Error('NOCODB_INTERNAL_PORT must be an integer from 1 to 65535');
  }
  if (!Number.isInteger(gitInternalPort) || gitInternalPort < 1 || gitInternalPort > 65535) {
    throw new Error('GIT_INTERNAL_PORT must be an integer from 1 to 65535');
  }
  if (publicPort === internalPort) {
    throw new Error('PORT and NOCODB_INTERNAL_PORT must be different');
  }
  if (gitInternalPort === internalPort) {
    throw new Error('GIT_INTERNAL_PORT and NOCODB_INTERNAL_PORT must be different');
  }

  return {
    publicPort,
    internalPort,
    gitInternalPort,
    repoDir: path.resolve(env.GIT_REPO_DIR || DEFAULTS.repoDir),
    liveDir: path.resolve(env.NC_APP_DATA_DIR || DEFAULTS.liveDir),
    remoteUrl: env.GIT_REMOTE_URL || '',
    branch: env.GIT_BRANCH || DEFAULTS.branch,
    webhookSecret: env.GIT_WEBHOOK_SECRET || '',
    authorName: env.GIT_AUTHOR_NAME || 'NocoDB Version Bot',
    authorEmail:
      env.GIT_AUTHOR_EMAIL || 'nocodb-version-bot@users.noreply.github.com',
    maxBodyBytes: DEFAULTS.maxBodyBytes,
  };
}

function gitEnv(env = process.env) {
  return {
    ...env,
    GIT_ASKPASS: '/opt/nocodb-git/git-askpass.sh',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`);
  }
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function git(cfg, args, options = {}) {
  return run('git', args, {
    ...options,
    cwd: cfg.repoDir,
    env: gitEnv(),
  });
}

function ensureSafeBranch(branch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..')) {
    throw new Error('GIT_BRANCH contains unsupported characters');
  }
}

function remoteRefExists(cfg) {
  return git(cfg, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${cfg.branch}`], {
    allowFailure: true,
  }).status === 0;
}

function localHead(cfg) {
  const result = git(cfg, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  return result.status === 0 ? result.stdout : null;
}

function remoteHead(cfg) {
  const result = git(
    cfg,
    ['rev-parse', '--verify', `refs/remotes/origin/${cfg.branch}`],
    { allowFailure: true },
  );
  return result.status === 0 ? result.stdout : null;
}

function bootstrapRepository(cfg) {
  ensureSafeBranch(cfg.branch);
  if (!cfg.remoteUrl) throw new Error('GIT_REMOTE_URL is required');

  fs.mkdirSync(cfg.repoDir, { recursive: true });
  if (!fs.existsSync(path.join(cfg.repoDir, '.git'))) {
    run('git', ['init', '--initial-branch', cfg.branch, cfg.repoDir], { env: gitEnv() });
    git(cfg, ['remote', 'add', 'origin', cfg.remoteUrl]);
  } else {
    const currentRemote = git(cfg, ['remote', 'get-url', 'origin'], {
      allowFailure: true,
    });
    if (currentRemote.status !== 0) git(cfg, ['remote', 'add', 'origin', cfg.remoteUrl]);
    else if (currentRemote.stdout !== cfg.remoteUrl) {
      git(cfg, ['remote', 'set-url', 'origin', cfg.remoteUrl]);
    }
  }

  git(cfg, ['config', 'user.name', cfg.authorName]);
  git(cfg, ['config', 'user.email', cfg.authorEmail]);
  fetchRemote(cfg);

  if (remoteRefExists(cfg)) {
    git(cfg, ['checkout', '-B', cfg.branch, `refs/remotes/origin/${cfg.branch}`]);
  } else {
    git(cfg, ['checkout', '-B', cfg.branch]);
  }
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'noco.db-wal' || entry.name === 'noco.db-shm') continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

function restoreSnapshot(cfg) {
  const snapshotDir = path.join(cfg.repoDir, 'data');
  fs.rmSync(cfg.liveDir, { recursive: true, force: true });
  fs.mkdirSync(cfg.liveDir, { recursive: true });
  copyTree(snapshotDir, cfg.liveDir);
}

function sqliteBackup(source, destination) {
  if (!fs.existsSync(source)) return false;
  const escaped = destination.replaceAll("'", "''");
  run('sqlite3', [source, `.timeout 30000`, `.backup '${escaped}'`]);
  return true;
}

function buildSnapshot(cfg) {
  const stageRoot = path.join(cfg.repoDir, '.nocodb-snapshot-stage');
  const stageData = path.join(stageRoot, 'data');
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageData, { recursive: true });

  copyTree(cfg.liveDir, stageData);
  fs.rmSync(path.join(stageData, 'noco.db'), { force: true });
  fs.rmSync(path.join(stageData, 'noco.db-wal'), { force: true });
  fs.rmSync(path.join(stageData, 'noco.db-shm'), { force: true });
  sqliteBackup(path.join(cfg.liveDir, 'noco.db'), path.join(stageData, 'noco.db'));

  const dataDir = path.join(cfg.repoDir, 'data');
  const previousDir = path.join(cfg.repoDir, '.nocodb-snapshot-previous');
  fs.rmSync(previousDir, { recursive: true, force: true });
  if (fs.existsSync(dataDir)) fs.renameSync(dataDir, previousDir);
  try {
    fs.renameSync(stageData, dataDir);
    fs.rmSync(previousDir, { recursive: true, force: true });
    fs.rmSync(stageRoot, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (fs.existsSync(previousDir)) fs.renameSync(previousDir, dataDir);
    throw error;
  }
}

function sanitizeMessage(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function extractCommitMessage(body) {
  const direct = sanitizeMessage(body?.message || body?.commit_message || body?.commitMessage);
  if (direct) return direct;

  const row = body?.data?.rows?.[0] || body?.event?.data?.rows?.[0];
  const fromRow = sanitizeMessage(
    row?.CommitMessage || row?.['Commit Message'] || row?.message,
  );
  if (fromRow) return fromRow;
  return `NocoDB snapshot ${new Date().toISOString()}`;
}

function verifyBearer(header, expected) {
  if (!expected) return false;
  const supplied = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7)
    : '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fetchRemote(cfg) {
  const result = git(
    cfg,
    ['fetch', '--prune', 'origin', `+refs/heads/${cfg.branch}:refs/remotes/origin/${cfg.branch}`],
    { allowFailure: true },
  );
  // An empty remote has no branch yet. Other failures are operational errors.
  if (result.status !== 0 && !/couldn't find remote ref|could not find remote ref/i.test(result.stderr)) {
    throw new HttpError(502, 'Could not fetch the Git remote', result.stderr);
  }
}

function assertRemoteUnchanged(cfg) {
  fetchRemote(cfg);
  const local = localHead(cfg);
  const remote = remoteHead(cfg);
  if (local !== remote) {
    throw new HttpError(409, 'Remote has changed. Restart/redeploy to load the latest version.', {
      local,
      remote,
    });
  }
  return local;
}

function rollbackCommit(cfg, previousHead) {
  if (previousHead) {
    git(cfg, ['reset', '--mixed', previousHead], { allowFailure: true });
  } else {
    git(cfg, ['update-ref', '-d', `refs/heads/${cfg.branch}`], { allowFailure: true });
    git(cfg, ['rm', '-r', '--cached', '--ignore-unmatch', '--', 'data'], {
      allowFailure: true,
    });
  }
}

function saveVersion(cfg, message) {
  const previousHead = assertRemoteUnchanged(cfg);
  buildSnapshot(cfg);
  git(cfg, ['add', '--all', '--', 'data']);

  const changed = git(cfg, ['diff', '--cached', '--quiet', '--', 'data'], {
    allowFailure: true,
  }).status !== 0;
  if (!changed) {
    return { ok: true, changed: false, commit: previousHead, message: 'Nothing to save' };
  }

  git(cfg, ['commit', '-m', sanitizeMessage(message) || `NocoDB snapshot ${new Date().toISOString()}`, '--', 'data']);
  const commit = localHead(cfg);
  const push = git(cfg, ['push', 'origin', `HEAD:refs/heads/${cfg.branch}`], {
    allowFailure: true,
  });
  if (push.status !== 0) {
    rollbackCommit(cfg, previousHead);
    const conflict = /non-fast-forward|fetch first|rejected/i.test(push.stderr);
    throw new HttpError(
      conflict ? 409 : 502,
      conflict ? 'Remote changed while saving. Restart/redeploy and try again.' : 'Git push failed',
      push.stderr,
    );
  }

  return { ok: true, changed: true, commit, message: 'Saved successfully' };
}

function sendJson(response, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  response.end(data);
}

function readJson(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function proxyHttp(request, response, cfg) {
  const headers = { ...request.headers };
  headers.host = `127.0.0.1:${cfg.internalPort}`;
  headers['x-forwarded-host'] = request.headers.host || '';
  headers['x-forwarded-proto'] = request.headers['x-forwarded-proto'] || 'https';

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: cfg.internalPort,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    if (!response.headersSent) sendJson(response, 502, { ok: false, error: 'NocoDB is starting' });
    else response.destroy(error);
  });
  request.pipe(upstream);
}

function proxyUpgrade(request, socket, head, cfg) {
  const upstream = net.connect(cfg.internalPort, '127.0.0.1', () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

function findNocoCommand(env = process.env, cwd = process.cwd()) {
  const candidates = [
    env.NOCODB_START && { type: 'start', file: env.NOCODB_START },
    env.NOCODB_MAIN && { type: 'main', file: env.NOCODB_MAIN },
    { type: 'start', file: '/usr/src/appEntry/start.sh' },
    { type: 'main', file: '/usr/src/app/docker/index.js' },
    { type: 'main', file: '/usr/src/app/docker/main.js' },
    { type: 'main', file: path.join(cwd, 'docker/index.js') },
    { type: 'main', file: path.join(cwd, 'docker/main.js') },
  ].filter(Boolean);
  const selected = candidates.find((candidate) => fs.existsSync(candidate.file));
  if (!selected) return null;

  if (selected.type === 'start') {
    const workdir = env.NOCODB_WORKDIR
      || (fs.existsSync('/usr/src/app') ? '/usr/src/app' : cwd);
    return { command: selected.file, args: [], cwd: workdir };
  }

  return {
    command: process.execPath,
    args: [selected.file],
    cwd: path.dirname(path.dirname(selected.file)),
  };
}

function startNocoDB(cfg) {
  const noco = findNocoCommand();
  if (!noco) {
    throw new Error(
      'Could not find the NocoDB start script or docker entry module; set NOCODB_START or NOCODB_MAIN',
    );
  }
  const env = {
    ...process.env,
    PORT: String(cfg.internalPort),
    NC_APP_DATA_DIR: cfg.liveDir.endsWith(path.sep) ? cfg.liveDir : `${cfg.liveDir}${path.sep}`,
    NC_TOOL_DIR: cfg.liveDir.endsWith(path.sep) ? cfg.liveDir : `${cfg.liveDir}${path.sep}`,
  };
  if (!env.NC_SITE_URL && env.RENDER_EXTERNAL_URL) env.NC_SITE_URL = env.RENDER_EXTERNAL_URL;
  return spawn(noco.command, noco.args, { cwd: noco.cwd, env, stdio: 'inherit' });
}

async function checkNocoDB(cfg) {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: '127.0.0.1', port: cfg.internalPort, path: '/api/v1/health', timeout: 1500 },
      (response) => {
        response.resume();
        resolve((response.statusCode || 500) < 500);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function createServer(cfg, state) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (pathname === '/healthz') {
      const healthy = state.nocodb && !state.nocodb.killed && await checkNocoDB(cfg);
      return sendJson(response, healthy ? 200 : 503, { ok: healthy });
    }

    if (pathname === '/__git/status' || pathname === '/git-status') {
      if (!verifyBearer(request.headers.authorization, cfg.webhookSecret)) {
        return sendJson(response, 401, { ok: false, error: 'Unauthorized' });
      }
      return sendJson(response, 200, {
        ok: true,
        busy: state.saveInProgress,
        branch: cfg.branch,
        commit: localHead(cfg),
      });
    }

    if (pathname === '/__git/save' || pathname === '/git-save') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST');
        return sendJson(response, 405, { ok: false, error: 'Method not allowed' });
      }
      if (!verifyBearer(request.headers.authorization, cfg.webhookSecret)) {
        return sendJson(response, 401, { ok: false, error: 'Unauthorized' });
      }
      if (state.saveInProgress) {
        return sendJson(response, 423, { ok: false, error: 'A save is already in progress' });
      }

      state.saveInProgress = true;
      try {
        const body = await readJson(request, cfg.maxBodyBytes);
        const result = saveVersion(cfg, extractCommitMessage(body));
        return sendJson(response, 200, result);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        console.error('[git-wrapper] save failed:', error.message);
        return sendJson(response, status, {
          ok: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      } finally {
        state.saveInProgress = false;
      }
    }

    return proxyHttp(request, response, cfg);
  });

  server.on('upgrade', (request, socket, head) => proxyUpgrade(request, socket, head, cfg));
  return server;
}

function main() {
  const cfg = configFromEnv();
  if (!cfg.webhookSecret) {
    console.warn('[git-wrapper] GIT_WEBHOOK_SECRET is missing; save/status endpoints will reject every request');
  }
  bootstrapRepository(cfg);
  restoreSnapshot(cfg);

  const state = { saveInProgress: false, nocodb: null };
  state.nocodb = startNocoDB(cfg);
  state.nocodb.on('exit', (code, signal) => {
    console.error(`[git-wrapper] NocoDB exited (code=${code}, signal=${signal})`);
    process.exitCode = code || 1;
  });

  const server = createServer(cfg, state);
  server.listen(cfg.publicPort, '0.0.0.0', () => {
    console.log(`[git-wrapper] proxy listening on 0.0.0.0:${cfg.publicPort}; NocoDB on 127.0.0.1:${cfg.internalPort}`);
  });

  const internalServer = cfg.gitInternalPort === cfg.publicPort
    ? null
    : createServer(cfg, state);
  if (internalServer) {
    internalServer.listen(cfg.gitInternalPort, '127.0.0.1', () => {
      console.log(`[git-wrapper] internal webhook listening on 127.0.0.1:${cfg.gitInternalPort}`);
    });
  }

  const shutdown = (signal) => {
    console.log(`[git-wrapper] received ${signal}, shutting down`);
    server.close();
    if (internalServer) internalServer.close();
    if (state.nocodb && !state.nocodb.killed) state.nocodb.kill(signal);
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  HttpError,
  bootstrapRepository,
  buildSnapshot,
  configFromEnv,
  createServer,
  extractCommitMessage,
  findNocoCommand,
  localHead,
  restoreSnapshot,
  sanitizeMessage,
  saveVersion,
  verifyBearer,
};

if (require.main === module) main();
