'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_USER_CONFIG,
  normalizeProfile,
  normalizeUserConfig,
  readUserConfig,
  writeUserConfig
} = require('../src/config.cjs');

function directProfile(overrides = {}) {
  return {
    id: 'direct-local',
    label: 'Local model',
    transport: 'direct',
    desiredMode: 'chat',
    httpBase: 'http://127.0.0.1:18000',
    realtimeUrl: 'ws://127.0.0.1:18000/v1/realtime',
    model: 'cpmo',
    ...overrides
  };
}

function sshProfile(overrides = {}) {
  return {
    ...directProfile({ id: 'competition-a', label: 'Competition A', transport: 'ssh' }),
    credentialDir: path.join(os.tmpdir(), 'floating-pet-credentials'),
    sshConfig: 'ssh_config',
    sshTarget: 'competition-a',
    localPort: 18000,
    realtimeLocalPort: 18000,
    remoteHost: '127.0.0.1',
    remotePort: 8000,
    realtimeRemotePort: 8001,
    remoteRoot: '~/MiniCPM-o',
    ...overrides
  };
}

test('malformed config falls back to safe defaults', () => {
  const value = normalizeUserConfig({ preferences: { activeLevel: 'invalid' }, profiles: null });
  assert.equal(value.version, 1);
  assert.equal(value.preferences.activeLevel, 'balanced');
  assert.equal(value.preferences.openAtLogin, false);
  assert.deepEqual(value.profiles, {});
});

test('normalizes bounded memories and restart-safe focus timer', () => {
  const value = normalizeUserConfig({
    memories: [
      { id: 'm-1', kind: 'name', text: '叫我小林', createdAt: 1, updatedAt: 2 },
      { id: 'm-1', kind: 'goal', text: '重复 ID', createdAt: 1, updatedAt: 2 },
      { id: '', kind: 'goal', text: 'bad', createdAt: 1, updatedAt: 2 },
      { id: 'm-2', kind: 'nope', text: 'bad', createdAt: 1, updatedAt: 2 }
    ],
    focusTimer: { state: 'running', durationMs: 1500000, endsAt: 1700000000000, remainingMs: 1 }
  });
  assert.deepEqual(value.memories, [{ id: 'm-1', kind: 'name', text: '叫我小林', createdAt: 1, updatedAt: 2 }]);
  assert.deepEqual(value.focusTimer, { state: 'running', durationMs: 1500000, endsAt: 1700000000000 });
});

test('drops oversized memories and invalid timer states', () => {
  const value = normalizeUserConfig({
    memories: [{ id: 'm-1', kind: 'goal', text: 'x'.repeat(501), createdAt: 1, updatedAt: 1 }],
    focusTimer: { state: 'running', durationMs: 1, endsAt: 0 }
  });
  assert.deepEqual(value.memories, []);
  assert.equal(value.focusTimer, null);
});

test('profile validation rejects shell-shaped paths and unsupported protocols', () => {
  assert.equal(normalizeProfile(sshProfile({ remoteRoot: '/a; rm -rf /' })), null);
  assert.equal(normalizeProfile({ id: 'x', transport: 'direct', httpBase: 'file:///secret' }), null);
});

test('user config write is atomic and readable', async (t) => {
  const file = path.join(os.tmpdir(), `floating-pet-config-${process.pid}.json`);
  t.after(async () => {
    await fs.rm(file, { force: true });
  });
  const config = normalizeUserConfig({ preferences: { voice: false } });
  await writeUserConfig(file, config);
  assert.deepEqual(await readUserConfig(file), config);

  const replacement = normalizeUserConfig({ preferences: { captions: false } });
  await writeUserConfig(file, replacement);
  assert.deepEqual(await readUserConfig(file), replacement);
});

test('normalizes supported direct and SSH profiles without preserving secrets', () => {
  const direct = normalizeProfile({ ...directProfile(), token: 'secret', unknown: true });
  assert.deepEqual(direct, directProfile());

  const ssh = normalizeProfile(sshProfile());
  assert.deepEqual(ssh, sshProfile());
  assert.equal(Object.hasOwn(ssh, 'token'), false);
});

test('rejects invalid port bounds and unsafe SSH arguments', () => {
  assert.equal(normalizeProfile(sshProfile({ localPort: 0 })), null);
  assert.equal(normalizeProfile(sshProfile({ remotePort: 65536 })), null);
  assert.equal(normalizeProfile(sshProfile({ realtimeRemotePort: 0 })), null);
  assert.equal(normalizeProfile(sshProfile({ realtimeUrl: 'ws://127.0.0.1/v1/realtime' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshConfig: '../ssh_config' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshTarget: '-oProxyCommand=bad' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshTarget: '-Ffoo@host' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshConfig: 'C:ssh_config' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshConfig: '\\ssh_config' })), null);
  assert.equal(normalizeProfile(sshProfile({ model: 'bad\nmodel' })), null);
  assert.equal(normalizeProfile(sshProfile({ label: 'bad\nlabel' })), null);
  assert.equal(normalizeProfile(sshProfile({ remoteRoot: '/' })), null);
  assert.equal(normalizeProfile(sshProfile({ remoteRoot: '~' })), null);
  assert.equal(normalizeProfile(sshProfile({ remoteRoot: '~/MiniCPM-o/' })).remoteRoot, '~/MiniCPM-o');
  assert.equal(normalizeProfile(directProfile({ httpBase: 'http://127.0.0.1:0' })), null);
});

test('old SSH profiles reuse the chat remote port for realtime', () => {
  const legacy = sshProfile();
  delete legacy.realtimeRemotePort;
  assert.equal(normalizeProfile(legacy).realtimeRemotePort, legacy.remotePort);
});

test('SSH profile supports optional FRP without an executable override', () => {
  const directSsh = normalizeProfile(sshProfile({ sshPath: 'C:\\Windows\\System32\\calc.exe' }));
  assert.equal(directSsh.transport, 'ssh');
  assert.equal(Object.hasOwn(directSsh, 'sshPath'), false);
  assert.equal(Object.hasOwn(directSsh, 'frpcConfig'), false);

  const stcp = normalizeProfile(sshProfile({ frpcConfig: 'frpc_visitor.toml', visitorPort: 22222 }));
  assert.equal(stcp.frpcConfig, 'frpc_visitor.toml');
  assert.equal(stcp.visitorPort, 22222);
  assert.equal(normalizeProfile(sshProfile({ frpcConfig: 'frpc_visitor.toml' })), null);
  assert.equal(normalizeProfile(sshProfile({ visitorPort: 22222 })), null);
  assert.equal(normalizeProfile(sshProfile({ frpcConfig: '../visitor.toml', visitorPort: 22222 })), null);
});

test('concurrent config writes use independent temporary files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-pet-config-concurrent-'));
  const file = path.join(directory, 'config.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await Promise.all([
    writeUserConfig(file, normalizeUserConfig({ preferences: { activeLevel: 'quiet' } })),
    writeUserConfig(file, normalizeUserConfig({ preferences: { activeLevel: 'active' } }))
  ]);

  const result = await readUserConfig(file);
  assert.equal(result.preferences.activeLevel, 'active');
  assert.deepEqual(await fs.readdir(directory), ['config.json']);
});

test('normalizes window and preference fields and drops invalid profiles', () => {
  const value = normalizeUserConfig({
    version: 999,
    window: { x: -1200, y: Number.POSITIVE_INFINITY, width: 900 },
    preferences: { activeLevel: 'active', voice: false, captions: false, openAtLogin: true, dnd: true },
    activeProfileId: 'direct-local',
    profiles: {
      'direct-local': directProfile(),
      mismatch: directProfile({ id: 'different' }),
      invalid: directProfile({ httpBase: 'ftp://127.0.0.1' })
    },
    conversation: ['secret']
  });

  assert.deepEqual(value, {
    version: 1,
    window: { x: -1200, y: null },
    preferences: { activeLevel: 'active', voice: false, captions: false, openAtLogin: true },
    activeProfileId: 'direct-local',
    profiles: { 'direct-local': directProfile() },
    memories: [],
    focusTimer: null
  });
});

test('missing and malformed files read as independent defaults', async (t) => {
  const file = path.join(os.tmpdir(), `floating-pet-config-invalid-${process.pid}.json`);
  t.after(() => fs.rm(file, { force: true }));
  await fs.rm(file, { force: true });

  const missing = await readUserConfig(file);
  await fs.writeFile(file, '{not json', 'utf8');
  const malformed = await readUserConfig(file);

  assert.deepEqual(missing, DEFAULT_USER_CONFIG);
  assert.deepEqual(malformed, DEFAULT_USER_CONFIG);
  assert.notEqual(missing, malformed);
  assert.notEqual(missing.preferences, malformed.preferences);
});
