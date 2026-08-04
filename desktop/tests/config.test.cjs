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
    remoteHost: '127.0.0.1',
    remotePort: 8000,
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
  assert.equal(normalizeProfile(sshProfile({ sshConfig: '../ssh_config' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshTarget: '-oProxyCommand=bad' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshConfig: 'C:ssh_config' })), null);
  assert.equal(normalizeProfile(sshProfile({ sshConfig: '\\ssh_config' })), null);
  assert.equal(normalizeProfile(sshProfile({ model: 'bad\nmodel' })), null);
  assert.equal(normalizeProfile(sshProfile({ label: 'bad\nlabel' })), null);
  assert.equal(normalizeProfile(sshProfile({ remoteRoot: '/' })), null);
  assert.equal(normalizeProfile(sshProfile({ remoteRoot: '~' })), null);
  assert.equal(normalizeProfile(sshProfile({ remoteRoot: '~/MiniCPM-o/' })).remoteRoot, '~/MiniCPM-o');
  assert.equal(normalizeProfile(directProfile({ httpBase: 'http://127.0.0.1:0' })), null);
});

test('SSH profile does not require Modelers-specific FRP metadata', () => {
  const profile = normalizeProfile(sshProfile({ frp: undefined, frpcConfig: undefined, visitorPort: undefined }));
  assert.equal(profile.transport, 'ssh');
  assert.equal(Object.hasOwn(profile, 'frp'), false);
  assert.equal(Object.hasOwn(profile, 'frpcConfig'), false);
  assert.equal(Object.hasOwn(profile, 'visitorPort'), false);
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
  assert.ok(['quiet', 'active'].includes(result.preferences.activeLevel));
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
    profiles: { 'direct-local': directProfile() }
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
