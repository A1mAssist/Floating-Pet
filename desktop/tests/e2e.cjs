'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');

async function waitForRealtimeAppend(page, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    value = await page.evaluate(() => window.pet.test.getRealtimeAppend());
    if (predicate(value)) return value;
    await page.waitForTimeout(50);
  }
  return value;
}

test('desktop pet completes the Fake Adapter preview flow', { timeout: 90000 }, async () => {
  let app;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-pet-e2e-'));
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [
        root,
        `--user-data-dir=${userDataDir}`,
        '--fake-model',
        '--test-mode',
        '--force-device-scale-factor=2',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream'
      ],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });
    const page = await app.firstWindow();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.waitForSelector('#pet');
  await page.waitForFunction(() => document.body.dataset.liquidGlass === 'ready');
  const liquidGlass = await page.evaluate(() => {
    const element = document.querySelector('#quickGlass');
    const canvas = element?.shadowRoot?.querySelector('canvas');
    if (!canvas) return null;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let nonTransparent = 0;
    let min = 255;
    let max = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue;
      nonTransparent += 1;
      const luminance = Math.round((pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000);
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
    }
    return {
      css: [element.clientWidth, element.clientHeight],
      backing: [canvas.width, canvas.height],
      dpr: window.devicePixelRatio,
      configuredDpr: element.getAttribute('dpr'),
      nonTransparent,
      luminanceRange: max - min
    };
  });
  assert.ok(liquidGlass, 'liquid glass canvas is missing');
  assert.deepEqual(liquidGlass.css, [328, 80]);
  assert.equal(liquidGlass.configuredDpr, '0');
  assert.deepEqual(liquidGlass.backing, liquidGlass.css.map((size) => Math.round(size * liquidGlass.dpr)));
  assert.ok(liquidGlass.nonTransparent > 1000, `liquid glass canvas is blank: ${JSON.stringify(liquidGlass)}`);
  assert.ok(liquidGlass.luminanceRange > 20, `liquid glass canvas is flat: ${JSON.stringify(liquidGlass)}`);
  assert.equal(await page.locator('#quickControls').getAttribute('role'), 'group');
  assert.equal(await page.locator('#simulateCue').isHidden(), true);
  assert.equal(await page.locator('#dndButton').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#settingsButton').getAttribute('aria-expanded'), 'false');
  const commandWidths = await page.evaluate(() => ['sessionButton', 'dndButton', 'settingsButton'].map((id) => document.getElementById(id).getBoundingClientRect().width));
  assert.ok(commandWidths[0] > commandWidths[1] && commandWidths[1] === commandWidths[2], `invalid command hierarchy: ${commandWidths}`);
  const petPartIds = ['pet-tail', 'pet-body', 'pet-head', 'pet-ear-left', 'pet-ear-right', 'pet-eye-left', 'pet-eye-right', 'pet-pupil-left', 'pet-pupil-right', 'pet-eyelids', 'pet-mouth-neutral', 'pet-mouth-talk', 'pet-mouth-worry', 'pet-paw', 'pet-sensor-core'];
  await page.waitForFunction((ids) => ids.every((id) => {
    const part = document.getElementById(id);
    if (!part) return false;
    const box = part.getBBox();
    return box.width > 0 && box.height > 0;
  }), petPartIds);
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'idle');
  const statusLegibility = await page.evaluate(() => {
    const rgba = (value) => value.match(/[\d.]+/g).map(Number);
    const overBlack = ([red, green, blue, alpha = 1], opacity) => [red, green, blue].map((value) => value * alpha * opacity);
    const luminance = (rgb) => rgb
      .map((value) => value / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const contrast = (foreground, background) => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (lighter + .05) / (darker + .05);
    };
    const status = document.querySelector('#petStatus');
    const statusStyle = getComputedStyle(status);
    const opacity = Number(statusStyle.opacity);
    const background = overBlack(rgba(statusStyle.backgroundColor), opacity);
    const ratio = (selector) => contrast(overBlack(rgba(getComputedStyle(document.querySelector(selector)).color), opacity), background);
    return { text: ratio('#statusText'), badge: ratio('#modelBadge'), fontSize: getComputedStyle(status).fontSize };
  });
  assert.ok(statusLegibility.text >= 4.5, `low-contrast status text: ${JSON.stringify(statusLegibility)}`);
  assert.ok(statusLegibility.badge >= 4.5, `low-contrast model badge: ${JSON.stringify(statusLegibility)}`);
  assert.equal(statusLegibility.fontSize, '12px');

  await page.waitForFunction(() => window.pet.test.getShell().then((value) => value.alwaysOnTop), null, { timeout: 3000 });
  await page.waitForTimeout(200);
  const shell = await page.evaluate(() => window.pet.test.getShell());
  assert.deepEqual(shell, { transparent: true, alwaysOnTop: true, skipTaskbar: true, fakeModel: true });
  let snapshot = await page.evaluate(() => window.__floatingPetTest.getState());
  assert.equal(snapshot.phase, 'IDLE_VISIBLE');
  assert.equal(snapshot.mediaCalls, 0);
  assert.deepEqual(snapshot.activeInputs, []);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const beforeDragLayout = await page.evaluate(() => {
    const pet = document.querySelector('.pet-art').getBoundingClientRect();
    const controls = document.querySelector('#quickControls').getBoundingClientRect();
    const status = document.querySelector('#petStatus').getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      controlsOffset: [controls.x - pet.x, controls.y - pet.y],
      statusOffset: [status.x - pet.x, status.y - pet.y]
    };
  });
  const petBox = await page.locator('#pet').boundingBox();
  assert.ok(petBox, 'pet has no pointer target');
  const beforeDrag = await page.evaluate(() => window.pet.test.getBounds());
  await page.mouse.move(petBox.x + petBox.width / 2, petBox.y + petBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.move(petBox.x + petBox.width / 2 - 42, petBox.y + petBox.height / 2 - 18);
  await page.waitForTimeout(50);
  const duringDrag = await page.evaluate(() => window.pet.test.getBounds());
  assert.notDeepEqual({ x: duringDrag.x, y: duringDrag.y }, { x: beforeDrag.x, y: beforeDrag.y });
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'drag');
  await page.mouse.up();
  await page.waitForTimeout(40);
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'idle');
  const afterReducedSnap = await page.evaluate(() => window.pet.test.getBounds());
  await page.waitForTimeout(180);
  const stableReducedSnap = await page.evaluate(() => window.pet.test.getBounds());
  assert.deepEqual({ x: stableReducedSnap.x, y: stableReducedSnap.y }, { x: afterReducedSnap.x, y: afterReducedSnap.y });
  const afterDragLayout = await page.evaluate(() => {
    const pet = document.querySelector('.pet-art').getBoundingClientRect();
    const controls = document.querySelector('#quickControls').getBoundingClientRect();
    const status = document.querySelector('#petStatus').getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      controlsOffset: [controls.x - pet.x, controls.y - pet.y],
      statusOffset: [status.x - pet.x, status.y - pet.y]
    };
  });
  assert.deepEqual(afterDragLayout, beforeDragLayout, 'drag changes the pet-relative layout');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const normalPetBox = await page.locator('#pet').boundingBox();
  await page.mouse.move(normalPetBox.x + normalPetBox.width / 2, normalPetBox.y + normalPetBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.move(normalPetBox.x + normalPetBox.width / 2 - 220, normalPetBox.y + normalPetBox.height / 2 - 36, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(480);
  const beforeSnapDeadline = await page.evaluate(() => window.pet.test.getBounds());
  await page.waitForTimeout(70);
  const afterSnapDeadline = await page.evaluate(() => window.pet.test.getBounds());
  assert.ok(Math.abs(afterSnapDeadline.x - beforeSnapDeadline.x) <= 1 && Math.abs(afterSnapDeadline.y - beforeSnapDeadline.y) <= 1, 'edge snap jumps at its deadline');

  await page.focus('#pet');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__floatingPetTest.getState().phase === 'SESSION_ACTIVE');
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'listening');
  assert.equal((await page.locator('#caption').textContent()).length > 0, true);
  const captionClearsStatus = await page.evaluate(() => {
    const caption = document.querySelector('#caption').getBoundingClientRect();
    const status = document.querySelector('#petStatus').getBoundingClientRect();
    return caption.right <= status.left || caption.left >= status.right || caption.bottom <= status.top || caption.top >= status.bottom;
  });
  assert.equal(captionClearsStatus, true, 'caption overlaps the pet status');
  const keyboardDurations = await page.locator('#caption').evaluate((element) => getComputedStyle(element).transitionDuration.split(',').map((value) => value.trim()));
  assert.equal(keyboardDurations.every((value) => value === '0s'), true);

  await page.click('#pet', { button: 'right' });
  await page.click('#contextSettings');
  await page.waitForFunction(() => document.querySelector('#settingsPanel').dataset.open === 'true');
  assert.equal(await page.locator('#settingsButton').getAttribute('aria-expanded'), 'true');
  await page.waitForFunction(() => document.querySelector('#screenSource').options.length > 1);
  assert.equal(await page.locator('#activeBalanced').isChecked(), true);
  await page.check('#activeQuiet');
  assert.equal((await page.evaluate(() => window.__floatingPetTest.getState())).activeLevel, 'quiet');
  assert.equal(await page.locator('#simulateCue').isDisabled(), true);
  await page.check('#activeBalanced');
  await page.click('label[for="micToggle"]');
  await page.waitForFunction(() => window.__floatingPetTest.getState().activeInputs.includes('microphone'));
  await page.click('label[for="cameraToggle"]');
  try {
    await page.waitForFunction(() => {
      const active = window.__floatingPetTest.getState().activeInputs;
      return active.includes('microphone') && active.includes('camera');
    }, null, { timeout: 8000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ state: window.__floatingPetTest.getState(), toast: document.querySelector('#toast').textContent, media: Boolean(navigator.mediaDevices) }));
    throw new Error(`media activation failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await page.click('label[for="cameraToggle"]');
  await page.waitForFunction(() => !window.__floatingPetTest.getState().activeInputs.includes('camera'));
  const screenSource = await page.locator('#screenSource option').evaluateAll((options) => {
    return options.find((option) => option.value.startsWith('screen:'))?.value
      || options.find((option) => option.value)?.value
      || '';
  });
  assert.notEqual(screenSource, '', 'no capturable screen or window source');
  await page.selectOption('#screenSource', screenSource);
  await page.click('label[for="screenToggle"]');
  try {
    await page.waitForFunction(() => window.__floatingPetTest.getState().activeInputs.includes('screen'), null, { timeout: 8000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ state: window.__floatingPetTest.getState(), toast: document.querySelector('#toast').textContent, selectedSource: document.querySelector('#screenSource').value }));
    throw new Error(`screen activation failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  assert.equal(await page.locator('#screenStatus').textContent() !== '已关闭', true);

  await page.click('label[for="micToggle"]');
  snapshot = await page.evaluate(() => window.__floatingPetTest.getState());
  assert.equal(snapshot.activeInputs.includes('microphone'), false);
  assert.equal(snapshot.activeInputs.includes('camera'), false);
  assert.equal(snapshot.activeInputs.includes('screen'), true);
  await page.click('#closeSettings');
  assert.equal(await page.locator('#settingsButton').getAttribute('aria-expanded'), 'false');

  assert.equal(await page.evaluate(() => window.__floatingPetTest.emitCue()), false);
  await page.evaluate(() => window.__floatingPetTest.advanceClock(5100));
  assert.equal(await page.evaluate(() => window.__floatingPetTest.emitCue()), true);
  await page.waitForFunction(() => document.querySelector('#nudgeBubble').dataset.open === 'true');
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'nudge');
  await page.waitForFunction(() => document.activeElement?.id === 'acceptNudge');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__floatingPetTest.getState().phase === 'ENGAGED');
  await page.fill('#messageInput', 'steps 为什么报错');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.message.assistant').length >= 2);
  await page.fill('#messageInput', '那下一步呢');
  await page.click('#sendMessage');
  await page.waitForFunction(() => document.querySelectorAll('.message.assistant').length >= 3);
  assert.equal((await page.locator('#conversation').textContent()).includes('补上空数组后重新运行'), true);
  const screenshot = path.join(root, 'release-preview.png');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: screenshot, omitBackground: false });
  assert.ok(fs.statSync(screenshot).size > 10000);

  await page.fill('#messageInput', '<img src=x onerror=window.__injected=1>');
  await page.click('#sendMessage');
  await page.waitForFunction(() => document.querySelectorAll('.message.user').length >= 3);
  assert.equal(await page.locator('#conversation img').count(), 0);
  assert.equal(await page.evaluate(() => window.__injected), undefined);

  await page.fill('#messageInput', '/fail');
  await page.click('#sendMessage');
  await page.waitForSelector('.message.error');
  assert.equal((await page.locator('.message.error').textContent()).includes('暂不可用'), true);
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'error');

  const stopMs = await page.evaluate(() => window.__floatingPetTest.stopAllInputs());
  assert.ok(stopMs <= 1000, `capture stop took ${stopMs}ms`);
  assert.deepEqual((await page.evaluate(() => window.__floatingPetTest.getState())).activeInputs, []);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.id === 'pet');
  await page.focus('#sessionButton');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__floatingPetTest.getState().phase === 'IDLE_VISIBLE');

  await page.focus('#pet');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__floatingPetTest.emitCue()), false);
  await page.evaluate(() => window.__floatingPetTest.advanceClock(5100));
  assert.equal(await page.evaluate(() => window.__floatingPetTest.emitCue()), true);
  await page.waitForFunction(() => document.activeElement?.id === 'acceptNudge');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'pet');
  assert.equal(await page.evaluate(() => window.__floatingPetTest.emitCue()), false);
  assert.equal(await page.locator('#nudgeBubble').getAttribute('data-open'), 'false');
  await page.click('#dndButton');
  assert.equal(await page.locator('#dndButton').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#dndButton').getAttribute('aria-label'), '关闭勿扰');
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'dnd');
  assert.notEqual(await page.locator('#dndButton').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.evaluate(() => window.__floatingPetTest.emitCue()), false);
  await page.click('#dndButton');
  assert.equal(await page.locator('#dndButton').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#dndButton').getAttribute('aria-label'), '开启勿扰');
  assert.equal(await page.locator('body').getAttribute('data-pet-state'), 'listening');

  await page.evaluate(() => window.pet.test.setSize(390, 640));
  await page.waitForTimeout(100);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, `horizontal overflow: ${overflow}px`);
  const compactLayout = await page.evaluate(() => {
    const rail = document.querySelector('#quickControls').getBoundingClientRect();
    const controls = ['sessionButton', 'dndButton', 'settingsButton'].map((id) => {
      const element = document.getElementById(id);
      const rect = element.getBoundingClientRect();
      return { id, width: rect.width, height: rect.height, textFits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight };
    });
    return { viewportWidth: innerWidth, rail: { left: rail.left, right: rail.right }, controls };
  });
  assert.ok(compactLayout.rail.left >= 0 && compactLayout.rail.right <= compactLayout.viewportWidth, `command rail is clipped: ${JSON.stringify(compactLayout)}`);
  assert.equal(compactLayout.controls.every(({ width, height, textFits }) => width >= 44 && height >= 44 && textFits), true, `invalid compact controls: ${JSON.stringify(compactLayout.controls)}`);

  const unnamed = await page.locator('button').evaluateAll((buttons) => buttons.filter((button) => !button.getAttribute('aria-label') && !button.textContent.trim()).length);
  assert.equal(unnamed, 0);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('desktop pet completes the Fake realtime audio path', { timeout: 45000 }, async () => {
  let app;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-pet-realtime-e2e-'));
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [
        root,
        `--user-data-dir=${userDataDir}`,
        '--fake-model',
        '--test-mode',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream'
      ],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForSelector('#pet');
    await page.click('#pet');
    await page.waitForFunction(() => window.__floatingPetTest.getState().phase === 'SESSION_ACTIVE');
    await page.click('#pet', { button: 'right' });
    await page.click('#contextSettings');
    await page.waitForFunction(() => document.querySelector('#settingsPanel').dataset.open === 'true');
    await page.click('label[for="micToggle"]');
    await page.waitForFunction(() => window.__floatingPetTest.getState().activeInputs.includes('microphone'));
    await page.waitForFunction(() => document.querySelector('#screenSource').options.length > 1);
    const screenSource = await page.locator('#screenSource option').evaluateAll((options) => {
      return options.find((option) => option.value.startsWith('screen:'))?.value
        || options.find((option) => option.value)?.value
        || '';
    });
    assert.notEqual(screenSource, '');
    await page.selectOption('#screenSource', screenSource);
    await page.click('label[for="screenToggle"]');
    try {
      await page.waitForFunction(() => window.__floatingPetTest.getState().activeInputs.includes('screen'), null, { timeout: 8000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        state: window.__floatingPetTest.getState(),
        toast: document.querySelector('#toast').textContent,
        selectedSource: document.querySelector('#screenSource').value,
        checked: document.querySelector('#screenToggle').checked
      }));
      throw new Error(`realtime screen activation failed: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    await page.evaluate(() => window.__floatingPetTest.setModelCapabilities({
      state: 'chat', mode: 'chat', chatCompletions: true, realtime: false,
      audioInput: false, video: false, audioOutput: false
    }));
    assert.equal(await page.locator('#realtimeToggle').isDisabled(), true);
    assert.equal(await page.locator('#realtimeStatus').textContent(), '当前为文字模式');
    assert.equal(await page.locator('#messageInput').isDisabled(), false);
    await page.evaluate(() => window.__floatingPetTest.setModelCapabilities({ state: 'offline' }));
    assert.equal(await page.locator('#realtimeToggle').isDisabled(), true);
    assert.equal(await page.locator('#realtimeStatus').textContent(), '模型服务未连接');
    await page.evaluate(() => window.__floatingPetTest.setModelCapabilities({
      state: 'fake', mode: 'fake', chatCompletions: true, realtime: true,
      audioInput: true, video: false, audioOutput: true
    }));
    assert.equal(await page.locator('#realtimeToggle').isDisabled(), false);
    await page.evaluate(() => {
      const voice = document.querySelector('#voiceToggle');
      voice.checked = true;
      voice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('#closeSettings');
    await page.evaluate(() => document.querySelector('#simulateCue').click());
    await page.evaluate(() => window.__floatingPetTest.advanceClock(5100));
    await page.evaluate(() => document.querySelector('#simulateCue').click());
    await page.waitForFunction(() => document.querySelector('#nudgeBubble').dataset.open === 'true');
    await page.click('#acceptNudge');
    await page.waitForFunction(() => window.__floatingPetTest.getState().phase === 'ENGAGED');
    const audioOnlyVisualCalls = await page.evaluate(() => window.__floatingPetTest.getState().visualCaptureCalls);
    await page.click('#realtimeToggle');
    await page.waitForFunction(() => window.__floatingPetTest.getState().realtimeActive === true, null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('#conversation').textContent.includes('local realtime demo response'), null, { timeout: 8000 });
    await page.waitForFunction(() => window.__floatingPetTest.getState().realtimePlaybackAccepted > 0, null, { timeout: 8000 });
    const realtimeButton = await page.locator('#realtimeToggle').evaluate((button) => ({
      background: getComputedStyle(button).backgroundColor,
      color: getComputedStyle(button).color,
      disabled: button.disabled,
      label: button.textContent.trim()
    }));
    assert.deepEqual(realtimeButton, {
      background: 'rgb(22, 140, 125)',
      color: 'rgb(255, 255, 255)',
      disabled: false,
      label: '停止实时'
    });
    assert.equal(await page.locator('#messageInput').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__floatingPetTest.getState().visualCaptureCalls), audioOnlyVisualCalls);
    assert.deepEqual(await page.evaluate(() => window.pet.test.getRealtimeAppend()), {
      hasAudio: true,
      videoFrameCount: 0,
      jpegOnly: true
    });
    const realtimeScreenshot = path.join(root, 'release-realtime-preview.png');
    await page.screenshot({ path: realtimeScreenshot, omitBackground: false });
    assert.ok(fs.statSync(realtimeScreenshot).size > 10000);
    const staleRequestId = await page.evaluate(() => window.__floatingPetTest.getState().realtimeRequestId);
    await page.click('#settingsButton');
    await page.waitForFunction(() => window.__floatingPetTest.getState().realtimeActive === false);
    assert.equal(await page.locator('#settingsPanel').getAttribute('data-open'), 'true');
    if (!(await page.evaluate(() => window.__floatingPetTest.getState().activeInputs.includes('screen')))) {
      await page.click('label[for="screenToggle"]');
      await page.waitForFunction(() => window.__floatingPetTest.getState().activeInputs.includes('screen'), null, { timeout: 8000 });
    }
    await page.click('#closeSettings');
    await page.click('#pet');
    await page.waitForFunction(() => document.querySelector('#assistCard').dataset.open === 'true');
    await page.evaluate(() => window.__floatingPetTest.setModelCapabilities({
      state: 'fake', mode: 'fake', chatCompletions: true, realtime: true,
      audioInput: true, video: true, audioOutput: true
    }));
    await page.click('#realtimeToggle');
    await page.waitForFunction(() => window.__floatingPetTest.getState().realtimeActive === true, null, { timeout: 8000 });
    try {
      await page.waitForFunction((baseline) => window.__floatingPetTest.getState().visualCaptureCalls > baseline, audioOnlyVisualCalls, { timeout: 8000 });
    } catch (error) {
      const diagnostic = await page.evaluate(async () => ({
        state: window.__floatingPetTest.getState(),
        append: await window.pet.test.getRealtimeAppend(),
        capabilityText: document.querySelector('#modelPrivacy').textContent,
        realtimeDisabled: document.querySelector('#realtimeToggle').disabled
      }));
      throw new Error(`video capture did not start: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const videoAppend = await waitForRealtimeAppend(page, (meta) => meta?.videoFrameCount > 0);
    assert.deepEqual(videoAppend, {
      hasAudio: true,
      videoFrameCount: 1,
      jpegOnly: true
    });
    const currentRequestId = await page.evaluate(() => window.__floatingPetTest.getState().realtimeRequestId);
    assert.ok(currentRequestId > staleRequestId);
    await app.evaluate(({ BrowserWindow }, requestId) => {
      BrowserWindow.getAllWindows()[0].webContents.send('realtime:event', {
        type: 'closed',
        reason: 'stale_session',
        requestId
      });
    }, staleRequestId);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__floatingPetTest.getState().realtimeActive), true);
    await page.click('#realtimeToggle');
    await page.waitForFunction(() => window.__floatingPetTest.getState().realtimeActive === false);
    assert.deepEqual(pageErrors, []);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('desktop pet turns two remote screen observations into one proactive nudge', { timeout: 45000 }, async () => {
  let app;
  const requests = [];
  let markFirstRequestStarted;
  let markFirstRequestClosed;
  const firstRequestStarted = new Promise((resolve) => { markFirstRequestStarted = resolve; });
  const firstRequestClosed = new Promise((resolve) => { markFirstRequestClosed = resolve; });
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'ready',
        mode: 'chat',
        fake: true,
        capabilities: {
          chat_completions: true,
          image_input: true,
          audio_input_wav: false,
          realtime: false,
          audio_input_16k_f32: false,
          video_jpeg: false,
          audio_output_24k_f32: false
        },
        error: null
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 3 * 1024 * 1024) chunks.push(chunk);
      });
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        if (requests.length === 1) {
          response.once('close', markFirstRequestClosed);
          markFirstRequestStarted();
          return;
        }
        if (requests.length === 2) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'temporary_unavailable' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          kind: 'repeated_error',
          anchor: 'local.stub.error',
          summary: '同一个本地测试错误重复出现'
        }) } }] }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-pet-proactive-e2e-'));
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [
        root,
        `--user-data-dir=${userDataDir}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream'
      ],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        FLOATING_PET_MODEL_URL: `http://127.0.0.1:${port}`,
        FLOATING_PET_MODEL_NAME: 'cpmo'
      }
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForSelector('#pet');
    await page.click('#pet');
    await page.waitForFunction(() => document.body.dataset.phase === 'SESSION_ACTIVE');
    await page.click('#pet', { button: 'right' });
    await page.click('#contextSettings');
    await page.waitForFunction(() => document.querySelector('#screenSource').options.length > 1);
    const screenSource = await page.locator('#screenSource option').evaluateAll((options) => {
      return options.find((option) => option.value.startsWith('screen:'))?.value
        || options.find((option) => option.value)?.value
        || '';
    });
    assert.notEqual(screenSource, '');
    await page.selectOption('#screenSource', screenSource);
    await page.click('label[for="screenToggle"]');
    await page.waitForFunction(() => document.querySelector('#screenStatus').textContent !== '已关闭', null, { timeout: 8000 });
    await page.click('#closeSettings');
    await firstRequestStarted;
    await page.waitForFunction(() => document.querySelector('#modelLabel').textContent === '测试模型服务');
    assert.equal((await page.locator('#modelPrivacy').textContent()).includes('本机 Fake Adapter'), false);

    await page.click('#settingsButton');
    await page.click('label[for="screenToggle"]');
    await page.waitForFunction(() => document.querySelector('#screenStatus').textContent === '已关闭');
    await Promise.race([
      firstRequestClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('screen analysis request was not cancelled')), 3000))
    ]);
    await page.waitForTimeout(5500);
    assert.equal(requests.length, 1);

    await page.click('label[for="screenToggle"]');
    await page.waitForFunction(() => document.querySelector('#screenStatus').textContent !== '已关闭', null, { timeout: 8000 });
    await page.click('#closeSettings');
    await page.waitForFunction(() => document.querySelector('#nudgeBubble').dataset.open === 'true', null, { timeout: 22000 });

    assert.equal(requests.length, 4);
    for (const body of requests) {
      assert.equal(body.messages.length, 1);
      assert.equal(Array.isArray(body.messages[0].content), true);
      assert.equal(body.messages[0].content.some((part) => part.type === 'image_url'), true);
      assert.equal(body.messages[0].content.some((part) => part.type === 'input_audio'), false);
    }
    assert.equal(await page.locator('#nudgeText').textContent(), '这个错误似乎重复出现，需要我一起看看吗？');
    assert.deepEqual(pageErrors, []);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('desktop pet keeps unsupported chat media out of the remote request', { timeout: 30000 }, async () => {
  let app;
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'ready',
        mode: 'chat',
        fake: true,
        capabilities: {
          chat_completions: true,
          image_input: false,
          audio_input_wav: false,
          realtime: false,
          audio_input_16k_f32: false,
          video_jpeg: false,
          audio_output_24k_f32: false
        },
        error: null
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '纯文字 Stub 回复' } }] }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-pet-chat-gate-e2e-'));
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [
        root,
        `--user-data-dir=${userDataDir}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream'
      ],
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        FLOATING_PET_MODEL_URL: `http://127.0.0.1:${port}`,
        FLOATING_PET_MODEL_NAME: 'cpmo'
      }
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForSelector('#pet');
    await page.click('#pet');
    await page.click('#pet', { button: 'right' });
    await page.click('#contextSettings');
    await page.waitForFunction(() => document.querySelector('#screenSource').options.length > 1);
    await page.click('label[for="micToggle"]');
    await page.waitForFunction(() => document.querySelector('#micStatus').textContent !== '已关闭');
    const screenSource = await page.locator('#screenSource option').evaluateAll((options) => {
      return options.find((option) => option.value.startsWith('screen:'))?.value
        || options.find((option) => option.value)?.value
        || '';
    });
    assert.notEqual(screenSource, '');
    await page.selectOption('#screenSource', screenSource);
    await page.click('label[for="screenToggle"]');
    await page.waitForFunction(() => document.querySelector('#screenStatus').textContent !== '已关闭', null, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('#modelPrivacy').textContent.includes('媒体不会发送'));
    assert.equal(await page.locator('#modelLabel').textContent(), '测试模型服务');
    await page.click('#closeSettings');

    await page.evaluate(() => document.querySelector('#simulateCue').click());
    await page.waitForFunction(() => document.querySelector('#nudgeBubble').dataset.open === 'true', null, { timeout: 8000 });
    await page.click('#acceptNudge');
    await page.fill('#messageInput', '只测试文字');
    await page.click('#sendMessage');
    await page.waitForFunction(() => document.querySelector('#conversation').textContent.includes('纯文字 Stub 回复'), null, { timeout: 8000 });

    assert.equal(requests.length, 1);
    const content = requests[0].messages.at(-1).content;
    assert.equal(typeof content, 'string');
    assert.equal(JSON.stringify(requests[0]).includes('image_url'), false);
    assert.equal(JSON.stringify(requests[0]).includes('input_audio'), false);
    assert.deepEqual(pageErrors, []);
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
