const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installManagedBackendSafely } = require('../dist/managed-backend-install');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, 'npm-global');
  const modules = process.platform === 'win32' ? 'node_modules' : 'lib/node_modules';
  const main = path.join(modules, '@anthropic-ai/claude-code');
  const stale = path.join(modules, '@anthropic-ai/.claude-code-old');
  const other = path.join(modules, '@openai/codex');
  for (const dir of [main, stale, other]) {
    fs.mkdirSync(path.join(prefix, dir), { recursive: true });
    fs.writeFileSync(path.join(prefix, dir, 'file'), dir === other ? 'working codex' : 'broken');
  }
  return { root, prefix, main, stale, other };
}

test('repair bypasses npm leftovers, preserves other backend, and cleans its cache', async t => {
  const f = fixture(t);
  await installManagedBackendSafely({ prefix: f.prefix, packageName: '@anthropic-ai/claude-code',
    installAndVerify: async (candidate, cache) => {
      assert.equal(fs.existsSync(path.join(candidate, f.main)), false);
      assert.equal(fs.existsSync(path.join(candidate, f.stale)), false);
      assert.equal(fs.readFileSync(path.join(candidate, f.other, 'file'), 'utf8'), 'working codex');
      assert.equal(fs.readFileSync(path.join(f.prefix, f.main, 'file'), 'utf8'), 'broken');
      fs.mkdirSync(path.join(candidate, f.main), { recursive: true });
      fs.writeFileSync(path.join(candidate, f.main, 'file'), 'verified');
      fs.mkdirSync(cache); fs.writeFileSync(path.join(cache, 'large-download'), 'bytes');
    } });
  assert.equal(fs.readFileSync(path.join(f.prefix, f.main, 'file'), 'utf8'), 'verified');
  assert.equal(fs.readFileSync(path.join(f.prefix, f.other, 'file'), 'utf8'), 'working codex');
  assert.deepEqual(fs.readdirSync(f.root), ['npm-global']);
});

for (const failure of ['download ENOSPC', 'executable probe failed', 'cancelled']) {
  test(`${failure} leaves installed packages untouched`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    await assert.rejects(installManagedBackendSafely({ prefix: f.prefix, packageName: '@anthropic-ai/claude-code', signal: controller.signal,
      installAndVerify: async (candidate, cache) => {
        fs.mkdirSync(cache); fs.writeFileSync(path.join(cache, 'partial'), 'download');
        if (failure === 'cancelled') controller.abort();
        else throw new Error(failure);
      } }));
    assert.equal(fs.readFileSync(path.join(f.prefix, f.main, 'file'), 'utf8'), 'broken');
    assert.equal(fs.readFileSync(path.join(f.prefix, f.other, 'file'), 'utf8'), 'working codex');
    assert.deepEqual(fs.readdirSync(f.root), ['npm-global']);
  });
}

test('concurrent repair cannot replace an install being prepared', async t => {
  const f = fixture(t);
  await installManagedBackendSafely({ prefix: f.prefix, packageName: '@anthropic-ai/claude-code',
    installAndVerify: async () => {
      await assert.rejects(installManagedBackendSafely({ prefix: f.prefix, packageName: '@openai/codex',
        installAndVerify: async () => assert.fail('must not install') }), /Another backend install/);
    } });
});

test('interrupted promotion restores the previous prefix before another attempt', async t => {
  const f = fixture(t);
  fs.renameSync(f.prefix, `${f.prefix}.previous`);
  await assert.rejects(installManagedBackendSafely({ prefix: f.prefix, packageName: '@anthropic-ai/claude-code',
    installAndVerify: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(fs.readFileSync(path.join(f.prefix, f.other, 'file'), 'utf8'), 'working codex');
});

test('low disk space rejects repair before touching the live installation', async t => {
  const f = fixture(t);
  t.mock.method(fs.promises, 'statfs', async () => ({ bavail: 1, bsize: 4096 }));
  await assert.rejects(installManagedBackendSafely({ prefix: f.prefix, packageName: '@anthropic-ai/claude-code',
    installAndVerify: async () => assert.fail('must not install') }), /Not enough free space/);
  assert.equal(fs.readFileSync(path.join(f.prefix, f.main, 'file'), 'utf8'), 'broken');
});

test('a failed promotion restores the original prefix', async t => {
  const f = fixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, dest) => {
    if (path.basename(source) === 'prefix') throw new Error('promotion denied');
    return rename(source, dest);
  });
  await assert.rejects(installManagedBackendSafely({ prefix: f.prefix, packageName: '@anthropic-ai/claude-code',
    installAndVerify: async () => {} }), /promotion denied/);
  assert.equal(fs.readFileSync(path.join(f.prefix, f.main, 'file'), 'utf8'), 'broken');
  assert.deepEqual(fs.readdirSync(f.root), ['npm-global']);
});

test('disk filling while writing the lock cannot leave repair permanently locked', async t => {
  const f = fixture(t);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (typeof target === 'number') throw new Error('ENOSPC');
    return write(target, ...args);
  });
  await assert.rejects(installManagedBackendSafely({ prefix: f.prefix, packageName: '@anthropic-ai/claude-code',
    installAndVerify: async () => assert.fail('must not install') }), /ENOSPC/);
  assert.deepEqual(fs.readdirSync(f.root), ['npm-global']);
});
