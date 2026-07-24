'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { analyzeScreen } = require('../src/model-client.cjs');
const { PHASES, decideNudge } = require('../src/core.cjs');

const config = {
  endpoint: process.env.FLOATING_PET_MODEL_URL || 'http://127.0.0.1:18000',
  model: process.env.FLOATING_PET_MODEL_NAME || 'cpmo',
  token: process.env.FLOATING_PET_MODEL_TOKEN || '',
  timeoutMs: Number(process.env.FLOATING_PET_MODEL_TIMEOUT_MS || 120_000)
};

const fixtures = {
  normal: {
    title: 'Visual Studio Code - Build output',
    lines: ['PS D:\\project> npm test', 'PASS 64 tests', 'Build completed successfully', 'All checks passed']
  },
  repeatedError: {
    title: 'Visual Studio Code - Terminal',
    lines: [
      '14:01:03  npm test',
      'TypeError: task.steps.map is not a function',
      '14:02:18  npm test',
      'TypeError: task.steps.map is not a function',
      '14:03:41  npm test',
      'TypeError: task.steps.map is not a function'
    ]
  },
  repeatedAttempt: {
    title: 'Device connection activity',
    lines: [
      '10:41:02  Clicked Connect device    No connection',
      '10:41:29  Clicked Connect device    No connection',
      '10:42:11  Clicked Connect device    No connection',
      '10:42:48  Clicked Connect device    No connection'
    ]
  }
};

const RENDER_SCRIPT = `
import io, json, sys
from PIL import Image, ImageDraw, ImageFont

fixture = json.load(sys.stdin)
image = Image.new("RGB", (1280, 720), "#eef1f5")
draw = ImageDraw.Draw(image)
try:
    title_font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 28)
    body_font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 24)
except OSError:
    title_font = body_font = ImageFont.load_default()
draw.rectangle((0, 0, 1280, 72), fill="white", outline="#c8ced8")
draw.text((40, 20), fixture["title"], font=title_font, fill="#17202a")
draw.rounded_rectangle((48, 108, 1232, 668), radius=8, fill="#15191f")
for index, line in enumerate(fixture["lines"]):
    color = "#ff8f8f" if "TypeError" in line else "#f4f7fb"
    draw.text((80, 145 + index * 58), line, font=body_font, fill=color)
output = io.BytesIO()
image.save(output, format="JPEG", quality=90)
sys.stdout.buffer.write(output.getvalue())
`;

function capture(fixture) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', RENDER_SCRIPT], {
    input: JSON.stringify(fixture),
    maxBuffer: 5 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr.toString('utf8'));
  assert.deepEqual([...result.stdout.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  return `data:image/jpeg;base64,${result.stdout.toString('base64')}`;
}

async function evaluate(fixture, expectedKind) {
  const imageDataUrl = capture(fixture);
  const startedAt = Date.now();
  const result = await analyzeScreen(imageDataUrl, config);
  const latencyMs = Date.now() - startedAt;
  assert.equal(result.ok, true, result.code || 'screen analysis failed');
  if (expectedKind === null) assert.equal(result.observation, null);
  else assert.equal(result.observation?.kind, expectedKind);
  return { latencyMs, observedAtMs: Date.now(), observation: result.observation };
}

(async () => {
    const normal = await evaluate(fixtures.normal, null);
    const errorFirst = await evaluate(fixtures.repeatedError, 'repeated_error');
    const errorSecond = await evaluate(fixtures.repeatedError, 'repeated_error');
    const attempt = await evaluate(fixtures.repeatedAttempt, 'repeated_attempt');
    assert.equal(errorFirst.observation.eventKey, errorSecond.observation.eventKey);

    const decision = decideNudge({
      phase: PHASES.ACTIVE,
      activeLevel: 'balanced',
      dnd: false,
      presentationMode: false,
      cooldownUntilMs: 0,
      seenEventKeys: [],
      nowMs: errorSecond.observedAtMs,
      observations: [
        { ...errorFirst.observation, observedAtMs: errorFirst.observedAtMs },
        { ...errorSecond.observation, observedAtMs: errorSecond.observedAtMs }
      ]
    });
    assert.deepEqual(decision, {
      action: 'nudge',
      eventKey: errorFirst.observation.eventKey,
      reason: 'two_observations'
    });

    console.log(`PASS ${JSON.stringify({
      normal_ms: normal.latencyMs,
      repeated_error_ms: [errorFirst.latencyMs, errorSecond.latencyMs],
      repeated_attempt_ms: attempt.latencyMs,
      event_key: errorFirst.observation.eventKey,
      decision: decision.reason
    })}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
