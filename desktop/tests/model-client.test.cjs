'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chat,
  fakeChat,
  fallbackChat,
  analyzeScreen,
  parseCueCandidate,
  capabilities,
  fakeCapabilities
} = require('../src/model-client.cjs');
const { normalizeProfile } = require('../src/config.cjs');
const { getModelEndpoints } = require('../src/model-supervisor.cjs');

const config = {
  endpoint: 'http://127.0.0.1:18000',
  model: 'cpmo',
  token: 'TOKEN_SECRET',
  timeoutMs: 100
};
const input = { messages: [{ role: 'user', content: '你好' }], turn: 1 };

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('sends a bounded OpenAI chat completion and returns remote text', async () => {
  let request;
  const result = await chat(input, config, async (url, options) => {
    request = { url, options };
    return jsonResponse({ choices: [{ message: { content: '  远端回复  ' } }] });
  });

  assert.deepEqual(result, { ok: true, text: '远端回复', source: 'remote', degraded: false, visualUsed: false, audioUsed: false });
  assert.equal(request.url, 'http://127.0.0.1:18000/v1/chat/completions');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, 'Bearer TOKEN_SECRET');
  assert.equal(request.options.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'cpmo',
    messages: [{ role: 'user', content: '你好' }],
    stream: false
  });
});

test('uses a selected profile endpoint and model without serializing its token', async () => {
  const profile = normalizeProfile({
    id: 'direct-other',
    label: 'Other service',
    transport: 'direct',
    desiredMode: 'chat',
    httpBase: 'https://model.example.test/api',
    realtimeUrl: 'wss://model.example.test/realtime',
    model: 'selected-model'
  });
  const endpoints = getModelEndpoints(profile, { FLOATING_PET_MODEL_TOKEN: 'PROFILE_TOKEN_SECRET' });
  let request;
  const result = await chat(input, { ...endpoints, timeoutMs: 100 }, async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return jsonResponse({ choices: [{ message: { content: 'profile reply' } }] });
  });

  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://model.example.test/api/v1/chat/completions');
  assert.equal(request.body.model, 'selected-model');
  const publicState = { state: 'ready', code: null, health: { mode: profile.desiredMode } };
  assert.equal(JSON.stringify(publicState).includes(endpoints.token), false);
});

test('attaches one validated image only to the last user message', async () => {
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`;
  let body;
  const result = await chat({
    messages: [
      { role: 'user', content: '第一张上下文' },
      { role: 'assistant', content: '继续' },
      { role: 'user', content: '看看当前画面' }
    ],
    turn: 2,
    imageDataUrl: png
  }, { ...config, endpoint: 'http://127.0.0.1:18000/v1' }, async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ choices: [{ message: { content: '看到了' } }] });
  });

  assert.equal(result.visualUsed, true);
  assert.equal(body.messages[0].content, '第一张上下文');
  assert.equal(body.messages[1].content, '继续');
  assert.deepEqual(body.messages[2].content, [
    { type: 'text', text: '看看当前画面' },
    { type: 'image_url', image_url: { url: png } }
  ]);
});

test('accepts a JPEG data URL', async () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  const result = await chat({ ...input, imageDataUrl: jpeg }, config, async () => jsonResponse({ choices: [{ message: { content: 'JPEG' } }] }));
  assert.deepEqual(result, { ok: true, text: 'JPEG', source: 'remote', degraded: false, visualUsed: true, audioUsed: false });
});

test('attaches one validated WAV input to the last user message', async () => {
  const wav = `data:audio/wav;base64,${Buffer.from('RIFF0000WAVE', 'ascii').toString('base64')}`;
  let body;
  const result = await chat({ ...input, audioDataUrl: wav }, config, async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ choices: [{ message: { content: '听到了' } }] });
  });
  assert.equal(result.audioUsed, true);
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: '你好' },
    { type: 'input_audio', input_audio: { data: wav.split(',')[1], format: 'wav' } }
  ]);
});

test('network, timeout, HTTP, JSON, and output failures degrade through fakeReply', async (t) => {
  const cases = [
    ['network_error', async () => { throw new Error('http://SECRET TOKEN_SECRET RAW_BODY'); }],
    ['timeout', async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }), { timeoutMs: 5 }],
    ['http_error', async () => new Response('RAW_HTTP_SECRET', { status: 503 })],
    ['invalid_json', async () => new Response('RAW_JSON_SECRET', { status: 200 })],
    ['empty_output', async () => jsonResponse({ choices: [{ message: { content: '   ' } }] })],
    ['output_too_large', async () => jsonResponse({ choices: [{ message: { content: 'x'.repeat(4001) } }] })]
  ];

  for (const [reason, fetchImpl, override = {}] of cases) {
    await t.test(reason, async () => {
      const result = await chat(input, { ...config, ...override }, fetchImpl);
      assert.deepEqual(result, {
        ok: true,
        text: '这是本机离线回应。请继续描述当前问题，模型服务恢复后可以获得完整回答。',
        source: 'fake',
        degraded: true,
        reason,
        visualUsed: false,
        audioUsed: false
      });
      const serialized = JSON.stringify(result);
      for (const secret of ['127.0.0.1', 'TOKEN_SECRET', 'RAW_']) assert.equal(serialized.includes(secret), false);
    });
  }
});

test('preserves fakeReply failure while marking the degradation source', async () => {
  const result = await chat({ messages: [{ role: 'user', content: '/fail' }], turn: 1 }, config, async () => new Response('', { status: 500 }));
  assert.deepEqual(result, {
    ok: false,
    code: 'fake_backend_error',
    message: '本机离线回应暂不可用，已保留文字输入。',
    source: 'fake',
    degraded: true,
    reason: 'http_error',
    visualUsed: false,
    audioUsed: false
  });
});

test('timeout covers a response body that never finishes', async () => {
  const result = await chat(input, { ...config, timeoutMs: 5 }, async () => ({
    ok: true,
    text: () => new Promise(() => {})
  }));
  assert.equal(result.reason, 'timeout');
  assert.equal(result.degraded, true);
});

test('runs explicit Fake Adapter mode without marking it as degraded', () => {
  assert.deepEqual(fakeChat(input), {
    ok: true,
    text: '这是本机离线回应。请继续描述当前问题，模型服务恢复后可以获得完整回答。',
    source: 'fake',
    degraded: false,
    visualUsed: false,
    audioUsed: false
  });
});

test('uses an explicit local fallback without pretending a remote attempt', () => {
  assert.deepEqual(fallbackChat(input), {
    ok: true,
    text: '这是本机离线回应。请继续描述当前问题，模型服务恢复后可以获得完整回答。',
    source: 'fake',
    degraded: true,
    reason: 'capability_missing',
    visualUsed: false,
    audioUsed: false,
    remoteAttempted: false
  });
});

test('parses only a bounded screen cue schema', () => {
  const valid = parseCueCandidate(JSON.stringify({
    kind: 'repeated_error',
    anchor: 'typeerror.map',
    summary: '同一个 TypeError 重复出现'
  }));
  assert.equal(valid.kind, 'repeated_error');
  assert.equal(valid.source, 'screen');
  assert.match(valid.eventKey, /^screen-[a-f0-9]{16}$/);
  const invalid = [
    'null',
    '{not-json',
    JSON.stringify({ kind: 'task_complete', anchor: 'done', summary: '完成' }),
    JSON.stringify({ kind: 'repeated_error', anchor: 'UPPER', summary: '重复' }),
    JSON.stringify({ kind: 'repeated_error', anchor: 'same', summary: '打开 https://example.com' }),
    JSON.stringify({ kind: 'repeated_error', anchor: 'same', summary: '打开 www.example.com' }),
    JSON.stringify({ kind: 'repeated_error', anchor: 'same', summary: '读取 /home/user/secret.txt' }),
    JSON.stringify({ kind: 'repeated_error', anchor: 'same', summary: '重复', command: 'run' })
  ];
  for (const value of invalid) assert.equal(parseCueCandidate(value), null);
});

test('screen analysis uses one JPEG and accepts only remote structured output', async () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  let body;
  const result = await analyzeScreen(jpeg, config, async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({
      kind: 'repeated_attempt',
      anchor: 'npm.test',
      summary: '相同测试连续失败'
    }) } }] });
  });
  assert.equal(body.messages.length, 1);
  assert.equal(Array.isArray(body.messages[0].content), true);
  assert.equal(body.messages[0].content[1].image_url.url, jpeg);
  assert.equal(result.ok, true);
  assert.equal(result.observation.kind, 'repeated_attempt');

  const none = await analyzeScreen(jpeg, config, async () => jsonResponse({ choices: [{ message: { content: 'null' } }] }));
  assert.deepEqual(none, { ok: true, observation: null });
  const degraded = await analyzeScreen(jpeg, config, async () => { throw new Error('offline'); });
  assert.deepEqual(degraded, { ok: false, code: 'model_unavailable' });
});

test('screen analysis aborts an in-flight model request', async () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  const controller = new AbortController();
  let requestSignal;
  const pending = analyzeScreen(jpeg, { ...config, signal: controller.signal }, async (_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) return reject(new Error('cancelled'));
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'model_unavailable' });
  assert.equal(requestSignal.aborted, true);
});

test('reads and normalizes the service capability contract', async () => {
  let request;
  const result = await capabilities(config, async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({
      status: 'ready',
      mode: 'duplex',
      fake: false,
      capabilities: {
      chat_completions: false,
      image_input: false,
      audio_input_wav: false,
        realtime: true,
        audio_input_16k_f32: true,
        video_jpeg: true,
        audio_output_24k_f32: true
      },
      error: null
    });
  });
  assert.deepEqual(result, {
    state: 'duplex',
    mode: 'duplex',
    chatCompletions: false,
    imageInput: false,
    chatAudioInput: false,
    realtime: true,
    audioInput: true,
    video: true,
    audioOutput: true,
    serviceFake: false,
    reason: null
  });
  assert.equal(request.url, 'http://127.0.0.1:18000/health');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.authorization, 'Bearer TOKEN_SECRET');
  assert.equal(request.options.signal instanceof AbortSignal, true);
});

test('merges verified Duplex health without dropping chat capabilities', async () => {
  const calls = [];
  const result = await capabilities({
    ...config,
    realtimeEndpoint: 'ws://127.0.0.1:18001/v1/realtime'
  }, async (url) => {
    calls.push(String(url));
    return jsonResponse(String(url).includes(':18001')
      ? {
          status: 'ready',
          mode: 'duplex',
          fake: false,
          capabilities: {
            realtime: true,
            audio_input_16k_f32: true,
            video_jpeg: true,
            audio_output_24k_f32: true
          }
        }
      : {
          status: 'ready',
          mode: 'chat',
          fake: false,
          capabilities: {
            chat_completions: true,
            image_input: true,
            audio_input_wav: true
          }
        });
  });

  assert.deepEqual(calls, [
    'http://127.0.0.1:18000/health',
    'http://127.0.0.1:18001/health'
  ]);
  assert.deepEqual(result, {
    state: 'duplex',
    mode: 'duplex',
    chatCompletions: true,
    imageInput: true,
    chatAudioInput: true,
    realtime: true,
    audioInput: true,
    video: true,
    audioOutput: true,
    serviceFake: false,
    reason: null
  });
});

test('fake or unavailable Duplex health leaves working chat available', async (t) => {
  const chatHealth = {
    status: 'ready',
    mode: 'chat',
    fake: false,
    capabilities: { chat_completions: true, image_input: true, audio_input_wav: true }
  };
  const realtimeConfig = { ...config, realtimeEndpoint: 'ws://127.0.0.1:18001/v1/realtime' };
  const cases = [
    ['fake', async (url) => jsonResponse(String(url).includes(':18001') ? {
      status: 'ready', mode: 'duplex', fake: true,
      capabilities: { realtime: true, audio_input_16k_f32: true, audio_output_24k_f32: true }
    } : chatHealth)],
    ['network', async (url) => {
      if (String(url).includes(':18001')) throw new Error('duplex offline');
      return jsonResponse(chatHealth);
    }]
  ];
  for (const [name, fetchImpl] of cases) {
    await t.test(name, async () => {
      const result = await capabilities(realtimeConfig, fetchImpl);
      assert.equal(result.state, 'chat');
      assert.equal(result.chatCompletions, true);
      assert.equal(result.realtime, false);
      assert.equal(result.audioOutput, false);
    });
  }
});

test('maps valid health responses to one product mode', async () => {
  const cases = [
    [{ status: 'ready', mode: 'chat', fake: false, capabilities: { chat_completions: true } }, 'chat'],
    [{ status: 'ready', mode: 'chat', fake: true, capabilities: { chat_completions: true } }, 'chat'],
    [{ status: 'ready', mode: 'duplex', fake: true, capabilities: {
      realtime: true, audio_input_16k_f32: true, audio_output_24k_f32: true
    } }, 'degraded'],
    [{ status: 'degraded', mode: 'duplex', fake: false, capabilities: {}, error: { code: 'capability_missing' } }, 'degraded'],
    [{ status: 'ready', mode: 'chat', fake: false, capabilities: { chat_completions: false } }, 'degraded']
  ];
  for (const [payload, state] of cases) {
    const result = await capabilities(config, async () => jsonResponse(payload));
    assert.equal(result.state, state);
    if (payload.fake === true) assert.equal(result.serviceFake, true);
  }
});

test('accepts legacy cpmo health with chat, image, and WAV input only', async () => {
  const result = await capabilities(config, async () => jsonResponse({
    status: 'ready',
    model: 'cpmo',
    device: 'Ascend910'
  }));
  assert.deepEqual(result, {
    state: 'chat',
    mode: 'chat',
    chatCompletions: true,
    imageInput: true,
    chatAudioInput: true,
    realtime: false,
    audioInput: false,
    video: false,
    audioOutput: false,
    serviceFake: false,
    reason: 'legacy_health'
  });
});

test('capability failures are bounded and expose no endpoint details', async (t) => {
  await t.test('invalid response', async () => {
    const result = await capabilities(config, async () => jsonResponse({ status: 'ready' }));
    assert.equal(result.state, 'degraded');
    assert.equal(result.reason, 'invalid_response');
    assert.equal(result.realtime, false);
  });
  await t.test('body timeout', async () => {
    const result = await capabilities({ ...config, timeoutMs: 5 }, async () => ({
      ok: true,
      text: () => new Promise(() => {})
    }));
    assert.equal(result.state, 'offline');
    assert.equal(result.reason, 'timeout');
  });
  await t.test('network error', async () => {
    const result = await capabilities(config, async () => { throw new Error('ENDPOINT_SECRET'); });
    assert.equal(result.state, 'offline');
    assert.equal(result.reason, 'network_error');
    assert.equal(JSON.stringify(result).includes('ENDPOINT_SECRET'), false);
  });
});

test('Fake Adapter advertises both local interaction paths', () => {
  const result = fakeCapabilities();
  assert.equal(result.mode, 'fake');
  assert.equal(result.chatCompletions, true);
  assert.equal(result.realtime, true);
});

test('rejects invalid input before fetch with one stable error', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({}); };
  const tooMany = Array.from({ length: 8 }, () => ({ role: 'user', content: 'x' }));
  const oversizedImage = `data:image/png;base64,${'A'.repeat(7_000_000)}`;
  const cases = [
    null,
    { messages: [], turn: 1 },
    { messages: tooMany, turn: 1 },
    { messages: [{ role: 'system', content: 'x' }], turn: 1 },
    { messages: [{ role: 'user', content: 'x' }, { role: 'system', content: 'x' }], turn: 1 },
    { messages: [{ role: 'assistant', content: 'x' }], turn: 1 },
    { messages: [{ role: 'user', content: '' }], turn: 1 },
    { messages: [{ role: 'user', content: 'x'.repeat(4001) }], turn: 1 },
    { messages: [{ role: 'user', content: 'x' }], turn: 0 },
    { ...input, imageDataUrl: 'data:image/gif;base64,R0lGODlh' },
    { ...input, imageDataUrl: 'data:image/png;base64,bm90LXBuZw==' },
    { ...input, imageDataUrl: oversizedImage },
    { ...input, audioDataUrl: 'data:audio/mp3;base64,SUQz' },
    { ...input, audioDataUrl: 'data:audio/wav;base64,bm90LXdhdg==' }
  ];

  for (const value of cases) {
    assert.deepEqual(await chat(value, config, fetchImpl), { ok: false, code: 'invalid_input', message: '模型请求无效。' });
  }
  assert.equal(calls, 0);
});

test('accepts one bounded system memory message before user chat', async () => {
  let body;
  const result = await chat({
    messages: [{ role: 'system', content: '已确认记忆：叫我小林' }, { role: 'user', content: '你好' }],
    turn: 1
  }, config, async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ choices: [{ message: { content: '你好，小林' } }] });
  });
  assert.equal(result.ok, true);
  assert.equal(body.messages[0].role, 'system');
});

test('rejects invalid config without exposing its values', async () => {
  let calls = 0;
  const result = await chat(input, {
    endpoint: 'ftp://ENDPOINT_SECRET',
    model: 'MODEL_SECRET',
    token: 'TOKEN_SECRET',
    timeoutMs: 100
  }, async () => { calls += 1; });

  assert.deepEqual(result, { ok: false, code: 'invalid_config', message: '模型配置无效。' });
  assert.equal(calls, 0);
  const serialized = JSON.stringify(result);
  for (const secret of ['ENDPOINT_SECRET', 'MODEL_SECRET', 'TOKEN_SECRET']) assert.equal(serialized.includes(secret), false);
});
