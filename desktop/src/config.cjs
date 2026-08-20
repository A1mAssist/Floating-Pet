'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const ACTIVE_LEVELS = new Set(['quiet', 'balanced', 'active']);
const DESIRED_MODES = new Set(['chat', 'duplex']);
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_PROFILE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PROFILES = 32;
const MAX_MEMORIES = 50;
const MAX_MEMORY_TEXT = 500;
const MIN_FOCUS_DURATION_MS = 5 * 60 * 1000;
const MAX_FOCUS_DURATION_MS = 120 * 60 * 1000;
const MAX_CONFIG_LENGTH = 1_048_576;
const MAX_PATH_LENGTH = 2048;
const MAX_WINDOW_COORDINATE = 1_000_000;
const writeQueues = new Map();

const DEFAULT_USER_CONFIG = Object.freeze({
  version: 1,
  window: Object.freeze({ x: null, y: null }),
  preferences: Object.freeze({
    activeLevel: 'balanced',
    voice: true,
    captions: true,
    openAtLogin: false
  }),
  activeProfileId: '',
  profiles: Object.freeze({}),
  memories: Object.freeze([]),
  focusTimer: null
});

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isProfileId(value) {
  return typeof value === 'string' && PROFILE_ID.test(value) && !RESERVED_PROFILE_IDS.has(value);
}

function boundedText(value, maxLength, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text && text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text) ? text : fallback;
}

function normalizeEndpoint(value, protocols, { trimTrailingSlash = false } = {}) {
  const text = boundedText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!protocols.has(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    if (url.port && !validPort(Number(url.port))) return null;
    const normalized = url.toString();
    return trimTrailingSlash ? normalized.replace(/\/$/, '') : normalized;
  } catch {
    return null;
  }
}

function normalizeLocalPath(value) {
  const text = boundedText(value, MAX_PATH_LENGTH);
  if (!text) return null;
  const expanded = text === '~'
    ? os.homedir()
    : /^[~][\\/]/.test(text)
      ? path.join(os.homedir(), text.slice(2))
      : text;
  return path.isAbsolute(expanded) || path.win32.isAbsolute(expanded) || path.posix.isAbsolute(expanded)
    ? path.normalize(expanded)
    : null;
}

function normalizeRelativePath(value) {
  const text = boundedText(value, MAX_PATH_LENGTH);
  if (!text || text.startsWith('-') || path.isAbsolute(text) || path.win32.isAbsolute(text) || path.posix.isAbsolute(text)
    || path.win32.parse(text).root) return null;
  const parts = text.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return text;
}

function normalizeRemoteRoot(value) {
  if (value == null || value === '') return null;
  const text = boundedText(value, MAX_PATH_LENGTH);
  if (!text || text === '/' || text === '~' || !(text.startsWith('/') || text.startsWith('~/'))) return false;
  if (!/^[A-Za-z0-9._~/-]+$/.test(text)) return false;
  const normalized = text === '/' || text === '~' ? text : text.replace(/\/+$/, '');
  if (normalized === '/' || normalized === '~') return false;
  const parts = normalized.replace(/^~?\//, '').split('/');
  return parts.some((part) => part === '.' || part === '..' || !part) ? false : normalized;
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function normalizeProfile(value) {
  if (!isRecord(value) || !isProfileId(value.id)) return null;
  if (!['ssh', 'direct'].includes(value.transport) || !DESIRED_MODES.has(value.desiredMode)) return null;

  const label = value.label == null ? value.id : boundedText(value.label, 100);
  const httpBase = normalizeEndpoint(value.httpBase, new Set(['http:', 'https:']), { trimTrailingSlash: true });
  const realtimeUrl = normalizeEndpoint(value.realtimeUrl, new Set(['ws:', 'wss:']));
  const model = value.model == null ? 'cpmo' : boundedText(value.model, 256);
  if (!label || !httpBase || !realtimeUrl || !model) return null;

  const profile = {
    id: value.id,
    label,
    transport: value.transport,
    desiredMode: value.desiredMode,
    httpBase,
    realtimeUrl,
    model
  };
  if (value.transport === 'direct') return profile;

  const credentialDir = normalizeLocalPath(value.credentialDir);
  const sshConfig = normalizeRelativePath(value.sshConfig);
  const sshTarget = boundedText(value.sshTarget, 320);
  const remoteHost = boundedText(value.remoteHost, 253);
  const remoteRoot = normalizeRemoteRoot(value.remoteRoot);
  const realtimeLocalPort = Number(new URL(realtimeUrl).port);
  const realtimeRemotePort = value.realtimeRemotePort == null ? value.remotePort : value.realtimeRemotePort;
  if (!credentialDir || !sshConfig || !sshTarget || !remoteHost || remoteRoot === false) return null;
  if (sshTarget.startsWith('-') || !/^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(sshTarget)) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(remoteHost)) return null;
  if (!validPort(value.localPort) || !validPort(value.remotePort)
      || !validPort(realtimeLocalPort) || !validPort(realtimeRemotePort)) return null;

  Object.assign(profile, {
    credentialDir,
    sshConfig,
    sshTarget,
    localPort: value.localPort,
    realtimeLocalPort,
    remoteHost,
    remotePort: value.remotePort,
    realtimeRemotePort,
    remoteRoot
  });
  const hasFrpcConfig = value.frpcConfig != null;
  const hasVisitorPort = value.visitorPort != null;
  if (hasFrpcConfig !== hasVisitorPort) return null;
  if (hasFrpcConfig) {
    const frpcConfig = normalizeRelativePath(value.frpcConfig);
    if (!frpcConfig || !validPort(value.visitorPort)) return null;
    profile.frpcConfig = frpcConfig;
    profile.visitorPort = value.visitorPort;
  }
  return profile;
}

function normalizeCoordinate(value) {
  return Number.isInteger(value) && Math.abs(value) <= MAX_WINDOW_COORDINATE ? value : null;
}

function normalizeMemory(value) {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id, 100);
  const text = boundedText(value.text, MAX_MEMORY_TEXT);
  if (!id || !text || !['name', 'goal', 'preference'].includes(value.kind)) return null;
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt) return null;
  return { id, kind: value.kind, text, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function normalizeFocusTimer(value) {
  if (!isRecord(value) || !['running', 'paused'].includes(value.state)) return null;
  const durationMs = Number(value.durationMs);
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_FOCUS_DURATION_MS || durationMs > MAX_FOCUS_DURATION_MS) return null;
  if (value.state === 'running') {
    const endsAt = Number(value.endsAt);
    return Number.isSafeInteger(endsAt) && endsAt > 0 ? { state: 'running', durationMs, endsAt } : null;
  }
  const remainingMs = Number(value.remainingMs);
  return Number.isSafeInteger(remainingMs) && remainingMs >= 0 && remainingMs <= durationMs
    ? { state: 'paused', durationMs, remainingMs }
    : null;
}

function normalizeUserConfig(value) {
  const input = isRecord(value) ? value : {};
  const windowValue = isRecord(input.window) ? input.window : {};
  const preferences = isRecord(input.preferences) ? input.preferences : {};
  const profiles = {};

  if (isRecord(input.profiles)) {
    for (const [id, candidate] of Object.entries(input.profiles).slice(0, MAX_PROFILES)) {
      const profile = normalizeProfile(candidate);
      if (profile && id === profile.id) profiles[id] = profile;
    }
  }

  const activeProfileId = isProfileId(input.activeProfileId) && Object.hasOwn(profiles, input.activeProfileId)
    ? input.activeProfileId
    : '';
  const memories = [];
  const memoryIds = new Set();
  if (Array.isArray(input.memories)) {
    for (const candidate of input.memories) {
      if (memories.length >= MAX_MEMORIES) break;
      const memory = normalizeMemory(candidate);
      if (memory && !memoryIds.has(memory.id)) {
        memoryIds.add(memory.id);
        memories.push(memory);
      }
    }
  }
  return {
    version: 1,
    window: {
      x: normalizeCoordinate(windowValue.x),
      y: normalizeCoordinate(windowValue.y)
    },
    preferences: {
      activeLevel: ACTIVE_LEVELS.has(preferences.activeLevel) ? preferences.activeLevel : DEFAULT_USER_CONFIG.preferences.activeLevel,
      voice: typeof preferences.voice === 'boolean' ? preferences.voice : DEFAULT_USER_CONFIG.preferences.voice,
      captions: typeof preferences.captions === 'boolean' ? preferences.captions : DEFAULT_USER_CONFIG.preferences.captions,
      openAtLogin: typeof preferences.openAtLogin === 'boolean' ? preferences.openAtLogin : DEFAULT_USER_CONFIG.preferences.openAtLogin
    },
    activeProfileId,
    profiles,
    memories,
    focusTimer: normalizeFocusTimer(input.focusTimer)
  };
}

async function readUserConfig(filePath, fsImpl = fs) {
  try {
    const text = await fsImpl.readFile(filePath, 'utf8');
    if (text.length > MAX_CONFIG_LENGTH) return normalizeUserConfig(DEFAULT_USER_CONFIG);
    return normalizeUserConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === 'ENOENT') return normalizeUserConfig(DEFAULT_USER_CONFIG);
    throw error;
  }
}

function writeUserConfig(filePath, config, fsImpl = fs) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fsImpl.writeFile(tempPath, `${JSON.stringify(normalizeUserConfig(config), null, 2)}\n`, 'utf8');
      await fsImpl.rename(tempPath, filePath);
    } catch (error) {
      await fsImpl.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  });
  writeQueues.set(filePath, write);
  return write.finally(() => {
    if (writeQueues.get(filePath) === write) writeQueues.delete(filePath);
  });
}

module.exports = {
  DEFAULT_USER_CONFIG,
  normalizeProfile,
  normalizeUserConfig,
  readUserConfig,
  writeUserConfig
};
