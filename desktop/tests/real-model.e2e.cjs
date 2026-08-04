'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');

(async () => {
  let app;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-pet-real-'));
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [root, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        FLOATING_PET_MODEL_URL: process.env.FLOATING_PET_MODEL_URL || 'http://127.0.0.1:18000',
        FLOATING_PET_MODEL_NAME: process.env.FLOATING_PET_MODEL_NAME || 'cpmo'
      }
    });
    const page = await app.firstWindow();
    await page.waitForSelector('#pet');
    await page.focus('#sessionButton');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.dataset.phase === 'SESSION_ACTIVE');
    await page.evaluate(() => document.querySelector('#simulateCue').click());
    await page.waitForFunction(() => document.querySelector('#nudgeBubble').dataset.open === 'true', null, { timeout: 10_000 });
    await page.click('#acceptNudge');
    await page.fill('#messageInput', '只回复：桌宠真实链路已接通');
    await page.click('#sendMessage');
    await page.waitForFunction(() => document.querySelectorAll('.message.assistant').length >= 2, null, { timeout: 120_000 });

    const label = await page.locator('.message.assistant').last().locator('small').textContent();
    const reply = await page.locator('.message.assistant').last().textContent();
    assert.equal(label, 'Ascend MiniCPM-o');
    assert.equal(reply.includes('桌宠真实链路已接通'), true);
    assert.equal(await page.locator('#modelBadge').textContent(), 'Ascend');
    console.log(`PASS ${label}: ${reply}`);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
