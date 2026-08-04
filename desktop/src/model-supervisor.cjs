'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const ERROR_STATES = new Set([
  'credentials_missing',
  'ssh_unavailable',
  'connection_refused',
  'connection_reset',
  'remote_start_failed',
  'health_timeout',
  'mode_mismatch'
]);
const MAX_HEALTH_BYTES = 64 * 1024;
const HEALTH_CAPABILITIES = [
  'chat_completions',
  'image_input',
  'audio_input_wav',
  'realtime',
  'audio_input_16k_f32',
  'video_jpeg',
  'audio_output_24k_f32'
];

class SupervisorFailure extends Error {
  constructor(state) {
    super(state);
    this.state = state;
  }
}

class Cancelled extends Error {}

function boundedDuration(value, fallback, minimum = 1) {
  return Number.isInteger(value) && value >= minimum && value <= 300_000 ? value : fallback;
}

function cloneHealth(health) {
  if (!health) return null;
  return {
    ...health,
    capabilities: { ...health.capabilities },
    error: health.error ? { ...health.error } : null
  };
}

function getModelEndpoints(profile, env = process.env) {
  const token = typeof env.FLOATING_PET_MODEL_TOKEN === 'string' ? env.FLOATING_PET_MODEL_TOKEN.trim() : '';
  return {
    endpoint: profile.httpBase,
    realtimeEndpoint: profile.realtimeUrl,
    model: profile.model,
    token: token.length <= 4096 ? token : ''
  };
}

function healthEndpoint(httpBase) {
  const url = new URL(httpBase);
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/v1/chat/completions')) {
    url.pathname = `${pathname.slice(0, -'/v1/chat/completions'.length)}/health`;
  } else if (pathname.endsWith('/v1')) {
    url.pathname = `${pathname.slice(0, -'/v1'.length)}/health`;
  } else {
    url.pathname = `${pathname}/health`.replace(/^\/\//, '/');
  }
  return url.toString();
}

function normalizeHealth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['ready', 'loading', 'degraded'].includes(value.status)) return null;
  if (!['chat', 'duplex'].includes(value.mode)) return null;
  if (typeof value.fake !== 'boolean') return null;
  if (!value.capabilities || typeof value.capabilities !== 'object' || Array.isArray(value.capabilities)) return null;

  const capabilities = {};
  for (const name of HEALTH_CAPABILITIES) capabilities[name] = value.capabilities[name] === true;
  const model = typeof value.model === 'string' && value.model.length <= 256 && !/[\r\n]/.test(value.model)
    ? value.model
    : null;
  const errorCode = typeof value.error?.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value.error.code)
    ? value.error.code
    : null;
  return {
    status: value.status,
    mode: value.mode,
    fake: value.fake,
    model,
    capabilities,
    error: errorCode ? { code: errorCode } : null
  };
}

async function readBoundedText(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_HEALTH_BYTES) throw new Error('response_too_large');
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HEALTH_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function errorCode(error) {
  return error?.code || error?.cause?.code || '';
}

function connectionState(error, fallback = 'connection_refused') {
  const code = String(errorCode(error)).toUpperCase();
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (code === 'ETIMEDOUT' || error?.name === 'AbortError') return 'health_timeout';
  return fallback;
}

function isAbsolute(filePath) {
  return path.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || path.posix.isAbsolute(filePath);
}

function resolveInside(directory, relativePath) {
  const root = path.resolve(directory);
  const candidate = path.resolve(root, relativePath);
  const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  return fold(candidate).startsWith(`${fold(root)}${path.sep}`) ? candidate : null;
}

function createSupervisor(options = {}) {
  const profile = options.profile;
  if (!profile || typeof profile !== 'object' || !['direct', 'ssh'].includes(profile.transport)) {
    throw new TypeError('A normalized profile is required');
  }

  const spawnImpl = options.spawnImpl || spawn;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fsImpl = options.fsImpl || fs;
  const connectImpl = options.connectImpl || net.createConnection;
  const env = options.env || process.env;
  const portTimeoutMs = boundedDuration(options.portTimeoutMs, 15_000);
  const healthTimeoutMs = boundedDuration(options.healthTimeoutMs, 180_000);
  const requestTimeoutMs = boundedDuration(options.requestTimeoutMs, 3_000);
  const remoteStartTimeoutMs = boundedDuration(options.remoteStartTimeoutMs, 10_000);
  const stopTimeoutMs = boundedDuration(options.stopTimeoutMs, 1_000);
  const pollIntervalMs = boundedDuration(options.pollIntervalMs, 500, 0);
  const handlers = new Set();
  const children = { tunnel: null, frpc: null, command: null };
  let snapshot = { state: 'idle', code: null, health: null };
  let currentAttempt = null;
  let sequence = 0;
  let startPromise = null;
  let stopPromise = null;
  let retryPromise = null;

  function publish(state, health = null) {
    snapshot = { state, code: ERROR_STATES.has(state) ? state : null, health: cloneHealth(health) };
    for (const handler of handlers) {
      try {
        handler(getState());
      } catch {
        // A renderer listener cannot break process cleanup or connection state.
      }
    }
  }

  function getState() {
    return { ...snapshot, health: cloneHealth(snapshot.health) };
  }

  function onState(handler) {
    if (typeof handler !== 'function') throw new TypeError('State handler must be a function');
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  function newAttempt() {
    let signal;
    const signalPromise = new Promise((resolve) => {
      signal = resolve;
    });
    return {
      id: ++sequence,
      cancelled: false,
      failure: null,
      signal,
      signalPromise,
      controllers: new Set()
    };
  }

  function cancelAttempt(attempt) {
    if (!attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    for (const controller of attempt.controllers) controller.abort();
    attempt.signal({ cancelled: true });
  }

  function failAttempt(attempt, state) {
    if (currentAttempt !== attempt || attempt.cancelled || attempt.failure) return;
    attempt.failure = state;
    for (const controller of attempt.controllers) controller.abort();
    attempt.signal({ state });
    if (snapshot.state === 'ready') publish(state);
  }

  function ensureActive(attempt) {
    if (currentAttempt !== attempt || attempt.cancelled) throw new Cancelled();
    if (attempt.failure) throw new SupervisorFailure(attempt.failure);
  }

  async function guarded(attempt, promise) {
    ensureActive(attempt);
    const result = await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ type: 'value', value }),
        (error) => ({ type: 'error', error })
      ),
      attempt.signalPromise.then((value) => ({ type: 'signal', value }))
    ]);
    if (result.type === 'signal') {
      if (result.value.cancelled) throw new Cancelled();
      throw new SupervisorFailure(result.value.state);
    }
    if (result.type === 'error') throw result.error;
    ensureActive(attempt);
    return result.value;
  }

  async function isFile(filePath) {
    try {
      return (await fsImpl.stat(filePath)).isFile();
    } catch {
      return false;
    }
  }

  async function isDirectory(filePath) {
    try {
      return (await fsImpl.stat(filePath)).isDirectory();
    } catch {
      return false;
    }
  }

  function watchPersistentChild(attempt, role, child) {
    child.once('error', (error) => {
      if (children[role] !== child) return;
      const fallback = role === 'tunnel' && errorCode(error) === 'ENOENT'
        ? 'ssh_unavailable'
        : role === 'frpc' && errorCode(error) === 'ENOENT'
          ? 'credentials_missing'
          : role === 'tunnel' ? 'connection_reset' : 'connection_refused';
      failAttempt(attempt, connectionState(error, fallback));
    });
    child.once('exit', () => {
      if (children[role] === child) failAttempt(attempt, role === 'tunnel' ? 'connection_reset' : 'connection_refused');
    });
  }

  function spawnPersistent(attempt, role, file, args, spawnOptions = {}) {
    let child;
    try {
      child = spawnImpl(file, args, { windowsHide: true, stdio: 'ignore', ...spawnOptions });
    } catch (error) {
      const fallback = role === 'tunnel' && errorCode(error) === 'ENOENT'
        ? 'ssh_unavailable'
        : role === 'frpc' && errorCode(error) === 'ENOENT'
          ? 'credentials_missing'
          : role === 'tunnel' ? 'connection_reset' : 'connection_refused';
      throw new SupervisorFailure(connectionState(error, fallback));
    }
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      throw new SupervisorFailure(role === 'tunnel' ? 'ssh_unavailable' : 'connection_refused');
    }
    children[role] = child;
    watchPersistentChild(attempt, role, child);
    return child;
  }

  async function captureCommand(attempt, file, args, timeoutMs) {
    let child;
    try {
      child = spawnImpl(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      throw new SupervisorFailure('ssh_unavailable');
    }
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      throw new SupervisorFailure('ssh_unavailable');
    }
    children.command = child;
    let output = '';
    child.stdout?.on('data', (chunk) => {
      if (output.length < 8192) output += chunk.toString('utf8').slice(0, 8192 - output.length);
    });
    const completed = new Promise((resolve) => {
      child.once('error', () => resolve({ ok: false }));
      child.once('exit', (code) => resolve({ ok: code === 0 }));
    });
    let timeoutId;
    const timed = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    });
    let result;
    try {
      result = await guarded(attempt, Promise.race([completed, timed]));
    } finally {
      clearTimeout(timeoutId);
    }
    if (children.command === child) children.command = null;
    if (result.timeout) child.kill();
    if (!result.ok) throw new SupervisorFailure('ssh_unavailable');
    return output;
  }

  async function resolveSsh(attempt) {
    if (typeof options.resolveSshImpl === 'function') {
      let candidate;
      try {
        candidate = await guarded(attempt, Promise.resolve().then(() => options.resolveSshImpl()));
      } catch {
        throw new SupervisorFailure('ssh_unavailable');
      }
      if (typeof candidate !== 'string' || !isAbsolute(candidate) || !(await isFile(candidate))) {
        throw new SupervisorFailure('ssh_unavailable');
      }
      return path.resolve(candidate);
    }
    const output = await captureCommand(attempt, 'where.exe', ['ssh.exe'], 5_000);
    const candidate = output.split(/\r?\n/).map((line) => line.trim()).find((line) => (
      line && isAbsolute(line) && path.basename(line).toLowerCase() === 'ssh.exe'
    ));
    if (!candidate || !(await isFile(candidate))) throw new SupervisorFailure('ssh_unavailable');
    return path.resolve(candidate);
  }

  async function resolveSshFiles(attempt) {
    if (!await isDirectory(profile.credentialDir)) throw new SupervisorFailure('credentials_missing');
    const sshConfig = resolveInside(profile.credentialDir, profile.sshConfig);
    if (!sshConfig || !await isFile(sshConfig)) throw new SupervisorFailure('credentials_missing');
    let frpc = null;
    let frpcConfig = null;
    if (profile.frpcConfig) {
      frpc = resolveInside(profile.credentialDir, 'frpc.exe');
      frpcConfig = resolveInside(profile.credentialDir, profile.frpcConfig);
      if (!frpc || !frpcConfig || !await isFile(frpc) || !await isFile(frpcConfig)) {
        throw new SupervisorFailure('credentials_missing');
      }
    }
    const ssh = await guarded(attempt, resolveSsh(attempt));
    return { ssh, sshConfig, frpc, frpcConfig };
  }

  function connectOnce(port, timeoutMs) {
    return new Promise((resolve) => {
      let socket;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.removeAllListeners?.();
        socket?.destroy?.();
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, code: 'ETIMEDOUT' }), timeoutMs);
      try {
        socket = connectImpl({ host: '127.0.0.1', port });
        socket.once('connect', () => finish({ ok: true }));
        socket.once('error', (error) => finish({ ok: false, code: errorCode(error) }));
      } catch (error) {
        finish({ ok: false, code: errorCode(error) });
      }
    });
  }

  async function waitForPort(attempt, port) {
    const deadline = Date.now() + portTimeoutMs;
    let lastCode = '';
    do {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await guarded(attempt, connectOnce(port, Math.min(500, remaining)));
      if (result.ok) return;
      lastCode = result.code;
      if (Date.now() < deadline) await guarded(attempt, delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
    throw new SupervisorFailure(String(lastCode).toUpperCase() === 'ECONNRESET' ? 'connection_reset' : 'connection_refused');
  }

  async function probeHealth(attempt) {
    const controller = new AbortController();
    attempt.controllers.add(controller);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('health timeout');
        error.code = 'ETIMEDOUT';
        reject(error);
      }, requestTimeoutMs);
    });
    try {
      const token = getModelEndpoints(profile, env).token;
      const response = await guarded(attempt, Promise.race([
        Promise.resolve().then(() => fetchImpl(healthEndpoint(profile.httpBase), {
          method: 'GET',
          headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          signal: controller.signal
        })),
        timeout
      ]));
      if (!response || response.ok !== true) {
        return { health: null, sawResponse: true, errorState: null };
      }
      let payload;
      if (typeof response.text === 'function') {
        const text = await guarded(attempt, Promise.race([readBoundedText(response), timeout]));
        try {
          payload = JSON.parse(text);
        } catch {
          return { health: null, sawResponse: true, errorState: null };
        }
      } else if (typeof response.json === 'function') {
        payload = await guarded(attempt, Promise.race([response.json(), timeout]));
      } else {
        return { health: null, sawResponse: true, errorState: null };
      }
      return { health: normalizeHealth(payload), sawResponse: true, errorState: null };
    } catch (error) {
      if (error instanceof Cancelled || error instanceof SupervisorFailure) throw error;
      return { health: null, sawResponse: false, errorState: connectionState(error, 'connection_refused') };
    } finally {
      clearTimeout(timer);
      attempt.controllers.delete(controller);
    }
  }

  function evaluateHealth(result) {
    const health = result.health;
    if (!health) return null;
    if (health.status === 'ready' && health.mode !== profile.desiredMode) return { state: 'mode_mismatch', health };
    const capabilitiesReady = health.mode === 'chat'
      ? health.capabilities.chat_completions
      : health.capabilities.realtime && health.capabilities.audio_input_16k_f32 && health.capabilities.audio_output_24k_f32;
    return health.status === 'ready' && health.mode === profile.desiredMode && health.fake === false && capabilitiesReady
      ? { state: 'ready', health }
      : null;
  }

  async function pollHealth(attempt, firstResult = null) {
    const deadline = Date.now() + healthTimeoutMs;
    let result = firstResult;
    let sawResponse = false;
    let lastErrorState = 'health_timeout';
    do {
      if (!result) result = await probeHealth(attempt);
      sawResponse ||= result.sawResponse;
      if (result.errorState) lastErrorState = result.errorState;
      const evaluated = evaluateHealth(result);
      if (evaluated) return evaluated;
      result = null;
      if (Date.now() < deadline) await guarded(attempt, delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
    throw new SupervisorFailure(sawResponse ? 'health_timeout' : lastErrorState);
  }

  async function runRemoteStart(attempt, ssh, sshConfig) {
    const rootParts = typeof profile.remoteRoot === 'string'
      ? profile.remoteRoot.replace(/^~?\//, '').split('/')
      : [];
    if (typeof profile.remoteRoot !== 'string'
      || !/^(?:~\/|\/)[A-Za-z0-9._/-]+$/.test(profile.remoteRoot)
      || rootParts.some((part) => !part || part === '.' || part === '..')) {
      throw new SupervisorFailure('remote_start_failed');
    }
    const command = `cd ${profile.remoteRoot} || exit 1; test -f service/start_minicpmo.sh || exit 1; nohup env MINICPM_MODE=chat bash service/start_minicpmo.sh > /tmp/floating-pet-minicpmo-chat.log 2>&1 < /dev/null &`;
    let child;
    try {
      child = spawnImpl(ssh, [
        '-F', sshConfig,
        '-o', 'BatchMode=yes',
        '--',
        profile.sshTarget,
        command
      ], { windowsHide: true, stdio: 'ignore', cwd: profile.credentialDir });
    } catch {
      throw new SupervisorFailure('remote_start_failed');
    }
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      throw new SupervisorFailure('remote_start_failed');
    }
    children.command = child;
    const completed = new Promise((resolve) => {
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    });
    let timeoutId;
    const timed = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), remoteStartTimeoutMs);
    });
    let result;
    try {
      result = await guarded(attempt, Promise.race([completed, timed]));
    } finally {
      clearTimeout(timeoutId);
    }
    if (children.command === child) children.command = null;
    if (result !== true) {
      child.kill();
      throw new SupervisorFailure('remote_start_failed');
    }
  }

  async function connect(attempt) {
    if (profile.transport === 'direct') {
      publish('probing');
      const result = await pollHealth(attempt);
      ensureActive(attempt);
      publish(result.state, result.health);
      return;
    }

    const files = await resolveSshFiles(attempt);
    ensureActive(attempt);
    publish('forwarding');
    if (files.frpc) {
      spawnPersistent(attempt, 'frpc', files.frpc, ['-c', files.frpcConfig], { cwd: profile.credentialDir });
      await waitForPort(attempt, profile.visitorPort);
    }
    spawnPersistent(attempt, 'tunnel', files.ssh, [
      '-F', files.sshConfig,
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-N',
      '-L', `${profile.localPort}:${profile.remoteHost}:${profile.remotePort}`,
      '--',
      profile.sshTarget
    ], { cwd: profile.credentialDir });
    await guarded(attempt, new Promise((resolve) => setImmediate(resolve)));
    publish('probing');
    const first = await probeHealth(attempt);
    const evaluated = evaluateHealth(first);
    if (evaluated) {
      publish(evaluated.state, evaluated.health);
      return;
    }
    if (profile.remoteRoot && profile.desiredMode === 'chat') {
      await runRemoteStart(attempt, files.ssh, files.sshConfig);
      const result = await pollHealth(attempt);
      publish(result.state, result.health);
      return;
    }
    const result = await pollHealth(attempt, first);
    publish(result.state, result.health);
  }

  function start() {
    if (startPromise) return startPromise;
    if (currentAttempt && !currentAttempt.cancelled) return Promise.resolve(getState());
    const attempt = newAttempt();
    currentAttempt = attempt;
    publish('starting');
    const run = (async () => {
      try {
        await connect(attempt);
      } catch (error) {
        if (!(error instanceof Cancelled) && currentAttempt === attempt && !attempt.cancelled) {
          publish(error instanceof SupervisorFailure ? error.state : connectionState(error));
        }
      }
      return getState();
    })();
    const tracked = run.finally(() => {
      if (startPromise === tracked) startPromise = null;
    });
    startPromise = tracked;
    return tracked;
  }

  async function killChild(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    let exited = false;
    const exit = new Promise((resolve) => {
      const done = () => {
        exited = true;
        resolve();
      };
      child.once?.('exit', done);
      child.once?.('close', done);
    });
    try {
      child.kill();
    } catch {
      return;
    }
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, stopTimeoutMs);
    });
    try {
      await Promise.race([exit, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process already exited.
      }
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const run = (async () => {
      const pendingStart = startPromise;
      cancelAttempt(currentAttempt);
      const tunnel = children.tunnel;
      const command = children.command;
      const frpc = children.frpc;
      children.tunnel = null;
      children.command = null;
      children.frpc = null;
      await killChild(tunnel);
      await killChild(command);
      await killChild(frpc);
      if (pendingStart) await pendingStart.catch(() => {});
      currentAttempt = null;
      publish('stopped');
      return getState();
    })();
    const tracked = run.finally(() => {
      if (stopPromise === tracked) stopPromise = null;
    });
    stopPromise = tracked;
    return tracked;
  }

  function retry() {
    if (retryPromise) return retryPromise;
    const run = (async () => {
      await stop();
      return start();
    })();
    const tracked = run.finally(() => {
      if (retryPromise === tracked) retryPromise = null;
    });
    retryPromise = tracked;
    return tracked;
  }

  return { start, stop, retry, getState, onState };
}

module.exports = { createSupervisor, getModelEndpoints };
