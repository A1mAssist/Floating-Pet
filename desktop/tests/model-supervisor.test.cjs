'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { normalizeProfile } = require('../src/config.cjs');
const { createSupervisor, getModelEndpoints } = require('../src/model-supervisor.cjs');

function health(mode = 'chat', overrides = {}) {
  return {
    status: 'ready',
    mode,
    model: 'cpmo',
    fake: false,
    capabilities: mode === 'chat'
      ? {
          chat_completions: true,
          image_input: true,
          audio_input_wav: true,
          realtime: false,
          audio_input_16k_f32: false,
          video_jpeg: false,
          audio_output_24k_f32: false
        }
      : {
          chat_completions: false,
          image_input: false,
          audio_input_wav: false,
          realtime: true,
          audio_input_16k_f32: true,
          video_jpeg: true,
          audio_output_24k_f32: true
        },
    ...overrides
  };
}

function response(payload, ok = true) {
  return { ok, text: async () => JSON.stringify(payload) };
}

class FakeChild extends EventEmitter {
  constructor(file, args, spawnOptions) {
    super();
    this.file = file;
    this.args = args;
    this.spawnOptions = spawnOptions;
    this.killCount = 0;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal = 'SIGTERM') {
    this.killCount += 1;
    this.killed = true;
    this.signalCode = signal === 'SIGKILL' ? 'SIGKILL' : null;
    if (this.exitCode == null) {
      this.exitCode = signal === 'SIGKILL' ? null : 0;
      queueMicrotask(() => this.emit('exit', this.exitCode, this.signalCode));
    }
    return true;
  }
}

function fakeSpawn({ throwError = null, autoExitRemote = true } = {}) {
  const children = [];
  const spawnImpl = (file, args, spawnOptions) => {
    if (throwError) throw Object.assign(new Error(throwError), { code: throwError });
    const child = new FakeChild(file, args, spawnOptions);
    children.push(child);
    if (autoExitRemote && args.at(-1)?.startsWith('cd ')) {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    }
    return child;
  };
  spawnImpl.children = children;
  return spawnImpl;
}

function fakeConnect() {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}

function directProfile(overrides = {}) {
  return normalizeProfile({
    id: 'local',
    label: 'Local',
    transport: 'direct',
    desiredMode: 'chat',
    httpBase: 'http://127.0.0.1:18000',
    realtimeUrl: 'ws://127.0.0.1:18000/v1/realtime',
    model: 'cpmo',
    ...overrides
  });
}

function sshProfile(credentialDir, overrides = {}) {
  return normalizeProfile({
    id: 'competition-a',
    label: 'Competition A',
    transport: 'ssh',
    desiredMode: 'chat',
    httpBase: 'http://127.0.0.1:18000',
    realtimeUrl: 'ws://127.0.0.1:18000/v1/realtime',
    model: 'cpmo',
    credentialDir,
    sshConfig: 'ssh_config',
    sshTarget: 'competition-a',
    localPort: 18000,
    remoteHost: '127.0.0.1',
    remotePort: 8000,
    remoteRoot: null,
    ...overrides
  });
}

async function credentials(t, withFrp = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'floating-pet-supervisor-'));
  await fs.writeFile(path.join(directory, 'ssh_config'), 'Host competition-a\n', 'utf8');
  if (withFrp) {
    await fs.writeFile(path.join(directory, 'frpc.exe'), '', 'utf8');
    await fs.writeFile(path.join(directory, 'frpc_visitor.toml'), '[common]\n', 'utf8');
  }
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('ssh profile reaches ready after forwarding and chat health', async (t) => {
  const directory = await credentials(t);
  const spawnImpl = fakeSpawn();
  const supervisor = createSupervisor({
    profile: sshProfile(directory),
    resolveSshImpl: () => process.execPath,
    spawnImpl,
    fetchImpl: async () => response(health()),
    requestTimeoutMs: 20,
    healthTimeoutMs: 40,
    pollIntervalMs: 1
  });

  await supervisor.start();
  assert.equal(supervisor.getState().state, 'ready');
  assert.equal(supervisor.getState().health.mode, 'chat');
  assert.equal(spawnImpl.children.length, 1);
  assert.equal(spawnImpl.children[0].spawnOptions.cwd, directory);
  assert.deepEqual(spawnImpl.children[0].args.slice(-2), ['--', 'competition-a']);
  await supervisor.stop();
  assert.equal(spawnImpl.children.every((child) => child.killed), true);
});

test('connection reset is user-safe and does not throw through start', async (t) => {
  const directory = await credentials(t);
  const supervisor = createSupervisor({
    profile: sshProfile(directory),
    resolveSshImpl: () => process.execPath,
    spawnImpl: fakeSpawn({ throwError: 'ECONNRESET' })
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'connection_reset');
});

test('running duplex service is not killed for a chat profile', async (t) => {
  const directory = await credentials(t);
  const spawnImpl = fakeSpawn();
  const supervisor = createSupervisor({
    profile: sshProfile(directory),
    resolveSshImpl: () => process.execPath,
    spawnImpl,
    fetchImpl: async () => response(health('duplex')),
    requestTimeoutMs: 20,
    healthTimeoutMs: 40,
    pollIntervalMs: 1
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'mode_mismatch');
  assert.equal(spawnImpl.children.every((child) => child.killCount === 0), true);
  await supervisor.stop();
});

test('optional FRP visitor is started before SSH forwarding', async (t) => {
  const directory = await credentials(t, true);
  const spawnImpl = fakeSpawn();
  const supervisor = createSupervisor({
    profile: sshProfile(directory, { frpcConfig: 'frpc_visitor.toml', visitorPort: 22222 }),
    resolveSshImpl: () => process.execPath,
    spawnImpl,
    connectImpl: fakeConnect,
    fetchImpl: async () => response(health()),
    portTimeoutMs: 40,
    requestTimeoutMs: 20,
    healthTimeoutMs: 40,
    pollIntervalMs: 1
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'ready');
  assert.equal(path.basename(spawnImpl.children[0].file), 'frpc.exe');
  assert.equal(spawnImpl.children[0].spawnOptions.cwd, directory);
  assert.deepEqual(spawnImpl.children[0].args.slice(0, 1), ['-c']);
  await supervisor.stop();
  assert.equal(spawnImpl.children.every((child) => child.killed), true);
});

test('system SSH lookup accepts only an existing ssh.exe result', async (t) => {
  const directory = await credentials(t);
  const ssh = path.join(directory, 'ssh.exe');
  await fs.writeFile(ssh, '', 'utf8');
  const tunnelSpawn = fakeSpawn();
  const spawnImpl = (file, args, options) => {
    if (file !== 'where.exe') return tunnelSpawn(file, args, options);
    const child = new FakeChild(file, args);
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`${ssh}\r\n`, 'utf8'));
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return child;
  };
  const supervisor = createSupervisor({
    profile: sshProfile(directory),
    spawnImpl,
    fetchImpl: async () => response(health()),
    requestTimeoutMs: 20,
    healthTimeoutMs: 40,
    pollIntervalMs: 1
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'ready');
  assert.equal(tunnelSpawn.children[0].file, ssh);
  await supervisor.stop();
});

test('missing SSH credentials becomes an offline state before spawning', async () => {
  const spawnImpl = fakeSpawn();
  const supervisor = createSupervisor({
    profile: sshProfile(path.join(os.tmpdir(), 'floating-pet-no-such-credentials')),
    resolveSshImpl: () => process.execPath,
    spawnImpl
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'credentials_missing');
  assert.equal(spawnImpl.children.length, 0);
});

test('remote start uses a fixed chat command and keeps the remote service detached', async (t) => {
  const directory = await credentials(t);
  const spawnImpl = fakeSpawn();
  let calls = 0;
  const supervisor = createSupervisor({
    profile: sshProfile(directory, { remoteRoot: '~/MiniCPM-o' }),
    resolveSshImpl: () => process.execPath,
    spawnImpl,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })) : response(health());
    },
    requestTimeoutMs: 20,
    remoteStartTimeoutMs: 40,
    healthTimeoutMs: 80,
    pollIntervalMs: 1
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'ready');
  const commandChild = spawnImpl.children[1];
  assert.equal(commandChild.spawnOptions.cwd, directory);
  assert.deepEqual(commandChild.args.slice(-3, -1), ['--', 'competition-a']);
  assert.match(commandChild.args.at(-1), /^cd ~\/MiniCPM-o \|\| exit 1;/);
  assert.match(commandChild.args.at(-1), /MINICPM_MODE=chat/);
  await supervisor.stop();
});

test('direct endpoint health timeout remains bounded', async () => {
  const supervisor = createSupervisor({
    profile: directProfile(),
    fetchImpl: async () => Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' })),
    requestTimeoutMs: 5,
    healthTimeoutMs: 20,
    pollIntervalMs: 1
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'connection_reset');
});

test('retry waits for an in-flight start before creating one replacement tunnel', async (t) => {
  const directory = await credentials(t);
  const spawnImpl = fakeSpawn();
  let fetchCalls = 0;
  const supervisor = createSupervisor({
    profile: sshProfile(directory),
    resolveSshImpl: () => process.execPath,
    spawnImpl,
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? new Promise(() => {}) : response(health());
    },
    requestTimeoutMs: 1_000,
    healthTimeoutMs: 1_000,
    pollIntervalMs: 1,
    stopTimeoutMs: 20
  });

  const firstStart = supervisor.start();
  while (spawnImpl.children.length === 0 || fetchCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  await supervisor.retry();
  await firstStart;
  assert.equal(supervisor.getState().state, 'ready');
  assert.equal(spawnImpl.children.length, 2);
  assert.equal(spawnImpl.children[0].killed, true);
  assert.equal(spawnImpl.children[1].killed, false);
  await supervisor.stop();
});

test('model endpoints use profile values and environment token only', () => {
  const profile = directProfile({
    httpBase: 'https://models.example.test/api',
    realtimeUrl: 'wss://models.example.test/api/v1/realtime',
    model: 'custom-model'
  });
  assert.deepEqual(getModelEndpoints(profile, { FLOATING_PET_MODEL_TOKEN: 'secret' }), {
    endpoint: 'https://models.example.test/api',
    realtimeEndpoint: 'wss://models.example.test/api/v1/realtime',
    model: 'custom-model',
    token: 'secret'
  });
});

test('health fakes may provide json without weakening the response contract', async () => {
  const supervisor = createSupervisor({
    profile: directProfile(),
    fetchImpl: async () => ({ ok: true, json: async () => health() }),
    requestTimeoutMs: 20,
    healthTimeoutMs: 40,
    pollIntervalMs: 1
  });
  await supervisor.start();
  assert.equal(supervisor.getState().state, 'ready');
});
