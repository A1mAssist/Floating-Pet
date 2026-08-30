'use strict';

const { createHash } = require('node:crypto');
const { fakeReply } = require('./core.cjs');

const MAX_MESSAGES = 7;
const MAX_TEXT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_RESPONSE_CHARS = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const INVALID_INPUT = Object.freeze({ ok: false, code: 'invalid_input', message: '模型请求无效。' });
const INVALID_CONFIG = Object.freeze({ ok: false, code: 'invalid_config', message: '模型配置无效。' });
const NO_CAPABILITIES = Object.freeze({
  chatCompletions: false,
  imageInput: false,
  chatAudioInput: false,
  realtime: false,
  audioInput: false,
  video: false,
  audioOutput: false
});
const SCREEN_CUE_PROMPT = [
  '只提取当前屏幕中与用户当前任务直接相关的线索：反复错误、反复失败操作、会议或页面中的关键要求、当前页面缺少的要求。',
  '没有明确线索时只输出 null。',
  '有明确线索时只输出一行 JSON。kind 只能是 repeated_error、repeated_attempt、meeting_fact、missing_requirement。',
  '除 missing_requirement 外只能包含 kind、anchor、summary；missing_requirement 必须额外包含 nextStep。anchor 只能用小写字母、数字、点、下划线、短横线。',
  'summary 和 nextStep 各不超过 160 个字符；不要输出解释、路径、网址、命令或 Markdown。'
].join('');

async function readBoundedText(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_CHARS) throw new Error('response_too_large');
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
      if (size > MAX_RESPONSE_CHARS) {
        await reader.cancel().catch(() => undefined);
        throw new Error('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGES) return null;
  if (!Number.isInteger(input.turn) || input.turn < 1 || input.turn > 1_000_000) return null;

  const messages = [];
  let lastUserIndex = -1;
  for (const [index, message] of input.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') return null;
    if (message.role === 'system' && index !== 0) return null;
    if (typeof message.content !== 'string') return null;
    const content = message.content.trim();
    if (!content || content.length > MAX_TEXT_CHARS) return null;
    messages.push({ role: message.role, content });
    if (message.role === 'user') lastUserIndex = messages.length - 1;
  }
  if (lastUserIndex < 0) return null;

  let imageDataUrl = null;
  if (input.imageDataUrl != null) {
    imageDataUrl = validateImageDataUrl(input.imageDataUrl);
    if (!imageDataUrl) return null;
  }

  let audioDataUrl = null;
  if (input.audioDataUrl != null) {
    audioDataUrl = validateAudioDataUrl(input.audioDataUrl);
    if (!audioDataUrl) return null;
  }

  return { messages, turn: input.turn, lastUserIndex, imageDataUrl, audioDataUrl };
}

function validateImageDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  const encoded = match[2];
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return null;

  const bytes = Buffer.from(encoded, 'base64');
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || canonical !== encoded.replace(/=+$/, '')) return null;
  const png = match[1].toLowerCase() === 'png';
  const validMagic = png
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return validMagic ? `data:image/${png ? 'png' : 'jpeg'};base64,${encoded}` : null;
}

function validateAudioDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:audio\/wav;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  if (match[1].length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4) return null;
  const bytes = Buffer.from(match[1], 'base64');
  const canonical = bytes.toString('base64').replace(/=+$/, '');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || canonical !== match[1].replace(/=+$/, '')) return null;
  if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') return null;
  return { dataUrl: value, encoded: match[1] };
}

function validateConfig(config, fetchImpl) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof fetchImpl !== 'function') return null;
  if (typeof config.endpoint !== 'string' || config.endpoint.length > 2048) return null;
  if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 256 || /[\r\n]/.test(config.model)) return null;
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300_000) return null;
  if (config.token != null && (typeof config.token !== 'string' || config.token.length > 4096 || /[\r\n]/.test(config.token))) return null;
  if (config.signal != null && (typeof config.signal !== 'object'
      || typeof config.signal.aborted !== 'boolean'
      || typeof config.signal.addEventListener !== 'function'
      || typeof config.signal.removeEventListener !== 'function')) return null;

  let url;
  try {
    url = new URL(config.endpoint);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1/chat/completions')) url.pathname = path;
  else if (path.endsWith('/v1')) url.pathname = `${path}/chat/completions`;
  else url.pathname = `${path}/v1/chat/completions`.replace(/^\/\//, '/');

  let realtimeEndpoint = null;
  if (config.realtimeEndpoint != null) {
    try {
      realtimeEndpoint = new URL(config.realtimeEndpoint);
    } catch {
      return null;
    }
    if (!['ws:', 'wss:'].includes(realtimeEndpoint.protocol) || realtimeEndpoint.username || realtimeEndpoint.password
        || realtimeEndpoint.search || realtimeEndpoint.hash) return null;
  }

  return {
    endpoint: url.toString(),
    realtimeEndpoint: realtimeEndpoint?.toString() || null,
    model: config.model.trim(),
    token: config.token?.trim() || '',
    timeoutMs: config.timeoutMs,
    signal: config.signal || null,
    fetchImpl
  };
}

function degradedReply(lastUser, turn, reason) {
  const result = fakeReply(lastUser, turn);
  return result.ok
    ? { ok: true, text: result.text, source: 'fake', degraded: true, reason, visualUsed: false, audioUsed: false }
    : { ...result, source: 'fake', degraded: true, reason, visualUsed: false, audioUsed: false };
}

function fakeChat(input) {
  const validInput = validateInput(input);
  if (!validInput) return { ...INVALID_INPUT };
  const lastUser = validInput.messages[validInput.lastUserIndex].content;
  const result = fakeReply(lastUser, validInput.turn);
  return result.ok
    ? { ok: true, text: result.text, source: 'fake', degraded: false, visualUsed: false, audioUsed: false }
    : { ...result, source: 'fake', degraded: false, visualUsed: false, audioUsed: false };
}

function fallbackChat(input) {
  const validInput = validateInput(input);
  if (!validInput) return { ...INVALID_INPUT };
  const lastUser = validInput.messages[validInput.lastUserIndex].content;
  return { ...degradedReply(lastUser, validInput.turn, 'capability_missing'), remoteAttempted: false };
}

function parseCueCandidate(text) {
  if (typeof text !== 'string' || !text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (!['anchor,kind,summary', 'anchor,kind,nextStep,summary'].includes(keys)) return null;
  if (!['repeated_error', 'repeated_attempt', 'meeting_fact', 'missing_requirement'].includes(value.kind)) return null;
  if (value.kind === 'missing_requirement' && keys !== 'anchor,kind,nextStep,summary') return null;
  if (value.kind !== 'missing_requirement' && keys !== 'anchor,kind,summary') return null;
  if (typeof value.anchor !== 'string' || !/^[a-z0-9._-]{1,80}$/.test(value.anchor)) return null;
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 160) return null;
  if (value.kind === 'missing_requirement' && (typeof value.nextStep !== 'string' || !value.nextStep.trim() || value.nextStep.length > 160)) return null;
  if (/[\u0000-\u001f\u007f]|https?:\/\/|\bwww\.|file:|[\\/]/i.test(value.summary)) return null;
  if (value.kind === 'missing_requirement' && (/[\u0000-\u001f\u007f]/.test(value.nextStep) || /https?:\/\/|\bwww\.|file:/i.test(value.nextStep) || /[\\/]/.test(value.nextStep))) return null;
  const digest = createHash('sha256').update(value.anchor).digest('hex').slice(0, 16);
  return {
    eventKey: `screen-${digest}`,
    kind: value.kind,
    source: 'screen',
    summary: value.summary.trim(),
    nextStep: value.kind === 'missing_requirement' ? value.nextStep.trim() : null
  };
}

async function analyzeScreen(imageDataUrl, config, fetchImpl = globalThis.fetch) {
  const result = await chat({
    messages: [{ role: 'user', content: SCREEN_CUE_PROMPT }],
    imageDataUrl,
    turn: 1
  }, config, fetchImpl);
  if (!result.ok || result.source !== 'remote' || result.degraded === true || result.visualUsed !== true) {
    return { ok: false, code: result.code || 'model_unavailable' };
  }
  if (result.text === 'null') return { ok: true, observation: null };
  const observation = parseCueCandidate(result.text);
  return observation ? { ok: true, observation } : { ok: false, code: 'invalid_observation' };
}

function fakeCapabilities() {
  return {
    state: 'fake',
    mode: 'fake',
    chatCompletions: true,
    imageInput: false,
    chatAudioInput: false,
    realtime: true,
    audioInput: true,
    video: true,
    audioOutput: true,
    serviceFake: false,
    reason: null
  };
}

function unavailableCapabilities(state, reason) {
  return {
    state,
    mode: null,
    ...NO_CAPABILITIES,
    serviceFake: false,
    reason
  };
}

function healthUrl(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  const pathname = url.pathname.replace(/\/+$/, '');
  const suffix = ['/v1/chat/completions', '/v1/realtime', '/realtime', '/v1']
    .find((candidate) => pathname.endsWith(candidate));
  url.pathname = suffix ? `${pathname.slice(0, -suffix.length)}/health` : `${pathname}/health`;
  return url;
}

async function probeCapabilities(validConfig, url) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('timeout'));
    }, Math.min(validConfig.timeoutMs, 3_000));
  });

  let response;
  let raw;
  try {
    response = await Promise.race([
      validConfig.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(validConfig.token ? { authorization: `Bearer ${validConfig.token}` } : {})
        },
        signal: controller.signal
      }),
      timeout
    ]);
    if (!response || response.ok !== true || typeof response.text !== 'function') {
      return unavailableCapabilities('degraded', 'http_error');
    }
    raw = await Promise.race([readBoundedText(response), timeout]);
  } catch (error) {
    const reason = error?.message === 'response_too_large'
      ? 'response_too_large'
      : timedOut ? 'timeout' : 'network_error';
    return unavailableCapabilities(reason === 'timeout' || reason === 'network_error' ? 'offline' : 'degraded', reason);
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return unavailableCapabilities('degraded', 'invalid_json');
  }
  if (payload?.status === 'ready'
      && typeof payload?.model === 'string'
      && payload.model.trim()
      && payload.mode == null
      && payload.capabilities == null) {
    const isLegacyMinicpm = payload.model.trim().toLowerCase() === 'cpmo';
    // ponytail: legacy cpmo health omits capability flags; keep Duplex disabled until advertised.
    return {
      state: 'chat',
      mode: 'chat',
      chatCompletions: true,
      imageInput: isLegacyMinicpm,
      chatAudioInput: isLegacyMinicpm,
      realtime: false,
      audioInput: false,
      video: false,
      audioOutput: false,
      serviceFake: false,
      reason: 'legacy_health'
    };
  }
  const status = ['ready', 'degraded', 'loading'].includes(payload?.status) ? payload.status : null;
  const mode = ['chat', 'duplex'].includes(payload?.mode) ? payload.mode : null;
  const advertised = payload?.capabilities;
  if (!status || !mode || !advertised || typeof advertised !== 'object' || Array.isArray(advertised)) {
    return unavailableCapabilities('degraded', 'invalid_response');
  }
  const reason = typeof payload?.error?.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(payload.error.code)
    ? payload.error.code
    : null;
  const normalized = {
    mode,
    chatCompletions: advertised.chat_completions === true,
    imageInput: advertised.image_input === true,
    chatAudioInput: advertised.audio_input_wav === true,
    realtime: advertised.realtime === true,
    audioInput: advertised.audio_input_16k_f32 === true,
    video: advertised.video_jpeg === true,
    audioOutput: advertised.audio_output_24k_f32 === true,
    serviceFake: payload.fake === true,
    reason
  };
  if (status !== 'ready') return { ...normalized, state: 'degraded' };
  if (mode === 'chat' && normalized.chatCompletions) return { ...normalized, state: 'chat' };
  if (normalized.serviceFake) return { ...normalized, state: 'degraded' };
  if (mode === 'duplex' && normalized.realtime && normalized.audioInput && normalized.audioOutput) {
    return { ...normalized, state: 'duplex' };
  }
  return unavailableCapabilities('degraded', 'capability_mismatch');
}

async function capabilities(config, fetchImpl = globalThis.fetch) {
  const validConfig = validateConfig(config, fetchImpl);
  if (!validConfig) return unavailableCapabilities('degraded', 'invalid_config');
  const chat = await probeCapabilities(validConfig, healthUrl(validConfig.endpoint));
  if (!validConfig.realtimeEndpoint || chat.state !== 'chat') return chat;

  const duplex = await probeCapabilities(validConfig, healthUrl(validConfig.realtimeEndpoint));
  if (duplex.state !== 'duplex' || duplex.serviceFake) return chat;
  return {
    ...chat,
    state: 'duplex',
    mode: 'duplex',
    realtime: true,
    audioInput: true,
    video: duplex.video,
    audioOutput: true
  };
}

async function chat(input, config, fetchImpl = globalThis.fetch) {
  const validInput = validateInput(input);
  if (!validInput) return { ...INVALID_INPUT };
  const validConfig = validateConfig(config, fetchImpl);
  if (!validConfig) return { ...INVALID_CONFIG };

  const requestMessages = validInput.messages.map((message) => ({ ...message }));
  if (validInput.imageDataUrl) {
    const lastUser = requestMessages[validInput.lastUserIndex];
    lastUser.content = [
      { type: 'text', text: lastUser.content },
      { type: 'image_url', image_url: { url: validInput.imageDataUrl } }
    ];
  }
  if (validInput.audioDataUrl) {
    const lastUser = requestMessages[validInput.lastUserIndex];
    if (typeof lastUser.content === 'string') lastUser.content = [{ type: 'text', text: lastUser.content }];
    lastUser.content.push({ type: 'input_audio', input_audio: { data: validInput.audioDataUrl.encoded, format: 'wav' } });
  }

  const lastUser = validInput.messages[validInput.lastUserIndex].content;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (validConfig.signal?.aborted) controller.abort();
  else validConfig.signal?.addEventListener('abort', abortFromCaller, { once: true });
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('timeout'));
    }, validConfig.timeoutMs);
  });

  let response;
  let raw;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => validConfig.fetchImpl(validConfig.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(validConfig.token ? { authorization: `Bearer ${validConfig.token}` } : {})
        },
        body: JSON.stringify({ model: validConfig.model, messages: requestMessages, stream: false }),
        signal: controller.signal
      })),
      timeout
    ]);
    if (!response || response.ok !== true || typeof response.text !== 'function') {
      return degradedReply(lastUser, validInput.turn, 'http_error');
    }
    raw = await Promise.race([readBoundedText(response), timeout]);
  } catch (error) {
    const reason = error?.message === 'response_too_large'
      ? 'response_too_large'
      : timedOut ? 'timeout' : 'network_error';
    return degradedReply(lastUser, validInput.turn, reason);
  } finally {
    clearTimeout(timer);
    validConfig.signal?.removeEventListener('abort', abortFromCaller);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return degradedReply(lastUser, validInput.turn, 'invalid_json');
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) return degradedReply(lastUser, validInput.turn, 'empty_output');
  if (text.trim().length > MAX_OUTPUT_CHARS) return degradedReply(lastUser, validInput.turn, 'output_too_large');

  return {
    ok: true,
    text: text.trim(),
    source: 'remote',
    degraded: false,
    visualUsed: Boolean(validInput.imageDataUrl),
    audioUsed: Boolean(validInput.audioDataUrl)
  };
}

module.exports = {
  chat,
  fakeChat,
  fallbackChat,
  analyzeScreen,
  parseCueCandidate,
  capabilities,
  fakeCapabilities
};
