const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const {
  alignRemoteCacheFile, compressRemoteContent, readRemoteContent,
  restoreRemoteContent, shouldCompressRemoteContent, summarizeRemoteCacheEntry,
} = require('../server');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-gzip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const content = [
    { type: 'session_meta', payload: { id: 'synthetic-thread', cwd: '/example/project' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '测试缓存压缩' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic response' } },
  ].map(JSON.stringify).join('\n') + '\n';
  const entry = { kind: 'codex', host: 'synthetic-host', path: '/example/session.jsonl',
    size: Buffer.byteLength(content), mtimeMs: 1000, cacheFile: path.join(dir, 'session.jsonl') };
  fs.writeFileSync(entry.cacheFile, content, { mode: 0o600 });
  return { dir, content, entry };
}

test('compresses verified history and restores it for a continued session', async t => {
  const { content, entry } = fixture(t);
  const original = entry.cacheFile;
  const summary = summarizeRemoteCacheEntry(entry);
  assert.equal(await compressRemoteContent(entry), true);
  assert.equal(fs.existsSync(original), false);
  assert.equal(readRemoteContent(entry.cacheFile), content);
  assert.equal(fs.statSync(entry.cacheFile).mode & 0o777, 0o600);
  assert.deepEqual(summarizeRemoteCacheEntry(entry), summary);
  assert.equal(await compressRemoteContent(entry), false);
  const gzip = entry.cacheFile;
  restoreRemoteContent(entry);
  assert.equal(entry.cacheFile, original);
  assert.equal(fs.existsSync(gzip), false);
  assert.equal(fs.readFileSync(original, 'utf8'), content);
  fs.appendFileSync(original, JSON.stringify({ type: 'event_msg', payload: {
    type: 'user_message', message: 'Continue synthetic session',
  } }) + '\n');
  entry.size = fs.statSync(original).size;
  assert.equal(summarizeRemoteCacheEntry(entry).turns, summary.turns + 1);
});

test('only archives unchanged caches older than 24 hours without open handles', t => {
  const { entry } = fixture(t);
  const meta = { ...entry };
  const day = 24 * 60 * 60 * 1000;
  assert.equal(shouldCompressRemoteContent(entry, meta, new Set(), entry.mtimeMs + day), true);
  assert.equal(shouldCompressRemoteContent(entry, meta, new Set(), entry.mtimeMs + day - 1), false);
  assert.equal(shouldCompressRemoteContent(entry, meta, new Set([entry.path]), entry.mtimeMs + day), false);
  assert.equal(shouldCompressRemoteContent(entry, { ...meta, size: meta.size + 1 }, new Set(), Infinity), false);
  assert.equal(shouldCompressRemoteContent(entry, { ...meta, mtimeMs: meta.mtimeMs + 1 }, new Set(), Infinity), false);
  assert.equal(shouldCompressRemoteContent(entry, undefined, new Set(), Infinity), false);
});

test('validates uncompressed lengths in gzip caches and repairs duplicated suffixes', async t => {
  const { content, entry } = fixture(t);
  fs.appendFileSync(entry.cacheFile, 'duplicated suffix');
  await compressRemoteContent(entry);
  assert.equal(alignRemoteCacheFile(entry.cacheFile, entry.size), true);
  assert.equal(readRemoteContent(entry.cacheFile), content);
  assert.equal(alignRemoteCacheFile(entry.cacheFile, entry.size + 1), false);
});

test('keeps compressed content intact when restoring a damaged cache fails', async t => {
  const { entry } = fixture(t);
  await compressRemoteContent(entry);
  fs.writeFileSync(entry.cacheFile, 'not gzip');
  assert.throws(() => restoreRemoteContent(entry));
  assert.equal(fs.existsSync(entry.cacheFile), true);
  assert.equal(fs.existsSync(entry.cacheFile.slice(0, -3)), false);
});

test('loads compressed history after restart and serves details with the saved remote title', t => {
  const { dir, content, entry } = fixture(t);
  const digest = crypto.createHash('sha256').update(entry.kind + '\0' + entry.host + '\0' + entry.path).digest('hex');
  fs.writeFileSync(path.join(dir, digest + '.jsonl.gz'), zlib.gzipSync(content));
  fs.writeFileSync(path.join(dir, digest + '.json'), JSON.stringify({ ...entry,
    version: 2, codexTitle: 'Saved remote title' }));
  fs.unlinkSync(entry.cacheFile);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const script = `
    const assert = require('node:assert/strict');
    const server = require(${JSON.stringify(path.resolve(__dirname, '../server'))});
    (async () => {
      const result = await server.remoteAgentSessions();
      assert.equal(result.sessions.length, 1);
      const session = result.sessions[0];
      assert.equal(session.title, 'Saved remote title');
      const detail = server.apiSessionDetail(new URLSearchParams({file: session.file}));
      assert.deepEqual(detail.messages.map(m => m.text), ['测试缓存压缩', 'Synthetic response']);
      console.log('verified');
    })().catch(e => { console.error(e); process.exitCode = 1; });`;
  const output = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, WATCHCAT_REMOTE_HISTORY_DIR: dir, WATCHCAT_SSH_HOSTS: '', PATH: bin + path.delimiter + process.env.PATH },
    encoding: 'utf8', timeout: 10000,
  });
  assert.match(output, /verified/);
});

test('resumes a compressed remote session by fetching only its new bytes and updates its title', t => {
  const { dir, content, entry } = fixture(t);
  const digest = crypto.createHash('sha256').update(entry.kind + '\0' + entry.host + '\0' + entry.path).digest('hex');
  const rawFile = path.join(dir, digest + '.jsonl');
  fs.writeFileSync(rawFile + '.gz', zlib.gzipSync(content));
  fs.writeFileSync(path.join(dir, digest + '.json'), JSON.stringify({ ...entry, version: 2 }));
  fs.unlinkSync(entry.cacheFile);
  const suffix = JSON.stringify({ type: 'event_msg', payload: {
    type: 'user_message', message: 'Continue this synthetic session',
  } }) + '\n';
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const scan = [
    'ROOT\tcodex\t/example',
    `FILE\tcodex\t${Math.floor(Date.now() / 1000)}\t${entry.size + Buffer.byteLength(suffix)}\t${entry.path}`,
    'CODEX_DB_TITLES\t' + Buffer.from(JSON.stringify([{ id: 'synthetic-thread', title: 'Updated remote title' }])).toString('base64'),
  ].join('\n');
  const requestLog = path.join(dir, 'requests.jsonl');
  const fake = path.join(bin, 'fake-ssh.js');
  fs.writeFileSync(fake, `
    const fs = require('node:fs');
    const cmd = process.argv.at(-1);
    if (cmd.includes('CODEX_META')) process.stdout.write(${JSON.stringify(scan)});
    else if (cmd.includes('tail -c') || cmd.includes('head -c')) {
      fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(cmd) + '\\n');
      process.stdout.write(${JSON.stringify(suffix)});
    } else process.stdout.write('/example/project\\n');
  `);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const script = `
    const assert = require('node:assert/strict');
    const server = require(${JSON.stringify(path.resolve(__dirname, '../server'))});
    (async () => {
      const result = await server.remoteAgentSessions();
      assert.deepEqual(result.errors, []);
      assert.equal(result.sessions.length, 1);
      const session = result.sessions[0];
      assert.equal(session.title, 'Updated remote title');
      const detail = server.apiSessionDetail(new URLSearchParams({file: session.file}));
      assert.equal(detail.messages.at(-1).text, 'Continue this synthetic session');
      console.log('verified');
    })().catch(e => { console.error(e); process.exitCode = 1; });`;
  assert.match(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, WATCHCAT_REMOTE_HISTORY_DIR: dir,
      WATCHCAT_SSH_HOSTS: entry.host, PATH: bin + path.delimiter + process.env.PATH },
    encoding: 'utf8', timeout: 10000,
  }), /verified/);
  assert.equal(fs.existsSync(rawFile + '.gz'), false);
  assert.equal(fs.readFileSync(rawFile, 'utf8'), content + suffix);
  const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes('tail -c +' + (entry.size + 1)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, digest + '.json'), 'utf8')).codexTitle, 'Updated remote title');
});
