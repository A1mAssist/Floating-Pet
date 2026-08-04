(() => {
  'use strict';

  const { PHASES, initialState, transition, decideNudge, nudgePrompt } = window.FloatingPetCore;
  const api = window.pet;
  const $ = (id) => document.getElementById(id);
  const inputNames = { microphone: '麦克风', camera: '摄像头', screen: '屏幕' };
  const inputControls = { microphone: $('micToggle'), camera: $('cameraToggle'), screen: $('screenToggle') };
  const inputStatus = { microphone: $('micStatus'), camera: $('cameraStatus'), screen: $('screenStatus') };
  const testStatus = { microphone: $('statusMicrophone'), camera: $('statusCamera'), screen: $('statusScreen') };
  const connectionStates = new Set(['idle', 'starting', 'forwarding', 'probing', 'ready', 'credentials_missing', 'ssh_unavailable', 'connection_refused', 'connection_reset', 'remote_start_failed', 'health_timeout', 'mode_mismatch', 'stopped']);
  const connectionFailures = new Set(['credentials_missing', 'ssh_unavailable', 'connection_refused', 'connection_reset', 'remote_start_failed', 'health_timeout', 'mode_mismatch', 'stopped']);
  const connectionPending = new Set(['starting', 'forwarding', 'probing']);
  const connectionLabels = Object.freeze({
    idle: '未连接',
    starting: '正在连接',
    forwarding: '正在建立转发',
    probing: '正在检查服务',
    ready: '已连接',
    credentials_missing: '缺少凭据',
    ssh_unavailable: 'SSH 不可用',
    connection_refused: '连接被拒绝',
    connection_reset: '连接已重置',
    remote_start_failed: '远端服务未启动',
    health_timeout: '健康检查超时',
    mode_mismatch: '服务模式不匹配',
    stopped: '已停止'
  });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const quickGlass = $('quickGlass');

  let state = initialState();
  let panel = 'none';
  let restoreFocus = null;
  let fakeClockOffsetMs = 0;
  let observations = [];
  let latestObservationSummary = null;
  let cueTimer = null;
  let toastTimer = null;
  let captionTimer = null;
  let petStateTimer = null;
  let speechGeneration = 0;
  let transientPetState = null;
  let draggingPet = false;
  let modelBusy = false;
  let requestGeneration = 0;
  let turnCount = 0;
  let mediaCalls = 0;
  let visualCaptureCalls = 0;
  let sourceLoaded = false;
  let selectedSourceName = '';
  const streams = new Map();
  const nativeScreenStream = Object.freeze({ nativeFrameSource: true });
  const inputGenerations = new Map(Object.keys(inputControls).map((kind) => [kind, 0]));
  const messages = [];
  const MAX_FRAME_DATA_URL_LENGTH = 'data:image/jpeg;base64,'.length + 4 * Math.floor((1024 * 1024) / 3);
  const MAX_REALTIME_TEXT_CHARS = 8_000;
  const SCREEN_ANALYSIS_INTERVAL_MS = 5_000;
  let modelAbortController = null;
  let realtimeActive = false;
  let realtimeStarting = false;
  let realtimeGeneration = 0;
  let realtimeCapture = null;
  let realtimePlayback = null;
  let realtimePlaybackAccepted = 0;
  let realtimeAssistant = null;
  let realtimeStateText = '麦克风关闭';
  let realtimeErrorCode = '';
  let realtimeMediaGeneration = 0;
  let capabilityCheck = null;
  let capabilityGeneration = 0;
  let capabilityRetryTimer = null;
  let capabilitiesCheckedAt = 0;
  let modelCapabilities = api.runtime.fakeModel
    ? { state: 'fake', mode: 'fake', chatCompletions: true, imageInput: false, chatAudioInput: false, realtime: true, audioInput: true, video: true, audioOutput: true, serviceFake: false, reason: null }
    : { state: 'checking', mode: null, chatCompletions: false, imageInput: false, chatAudioInput: false, realtime: false, audioInput: false, video: false, audioOutput: false, serviceFake: false, reason: null };
  let screenAnalysisTimer = null;
  let screenAnalysisGeneration = 0;
  let screenAnalysisTask = null;
  let screenAnalysisAbortController = null;
  let screenAnalysisPaused = false;
  let screenAnalysisRequestSequence = 0;
  let activeScreenAnalysisRequestId = null;
  let quickGlassConfigured = false;
  let persistedSettings = null;
  let connectionState = { state: 'idle', code: null, health: null };
  let settingsOperation = Promise.resolve();
  let initialized = false;

  const settings = {
    activeLevel: 'balanced',
    voice: !api.runtime.testMode,
    captions: true,
    openAtLogin: false,
    dnd: false,
    presentationMode: false
  };

  function nowMs() { return Date.now() + fakeClockOffsetMs; }
  function sessionActive() { return state.phase !== PHASES.IDLE; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function createQuickGlassWallpaper() {
    const canvas = document.createElement('canvas');
    canvas.width = 656;
    canvas.height = 160;
    const context = canvas.getContext('2d', { alpha: false });
    context.scale(2, 2);
    context.fillStyle = '#edf4f8';
    context.fillRect(0, 0, 328, 80);
    context.save();
    context.translate(-24, 0);
    context.rotate(-.11);
    context.filter = 'blur(14px)';
    for (const band of [
      { x: 0, width: 92, color: 'rgba(88, 180, 232, .34)' },
      { x: 96, width: 82, color: 'rgba(255, 255, 255, .76)' },
      { x: 182, width: 74, color: 'rgba(238, 191, 127, .24)' },
      { x: 264, width: 94, color: 'rgba(235, 151, 174, .2)' }
    ]) {
      context.fillStyle = band.color;
      context.fillRect(band.x, -36, band.width, 160);
    }
    context.restore();
    context.fillStyle = 'rgba(255, 255, 255, .32)';
    context.fillRect(0, 0, 328, 1);
    return canvas.toDataURL('image/png');
  }

  function syncQuickGlass() {
    if (reducedMotion.matches) {
      document.body.dataset.liquidGlass = 'reduced';
      return;
    }
    if (!quickGlass || typeof quickGlass.setTabs !== 'function' || typeof quickGlass.setState !== 'function') {
      document.body.dataset.liquidGlass = 'unavailable';
      return;
    }
    if (!quickGlass.hasAttribute('wallpaper')) quickGlass.setAttribute('wallpaper', createQuickGlassWallpaper());
    if (!quickGlassConfigured) {
      quickGlass.setTabs([[{ icon: '', label: '' }]]);
      quickGlass.setState({ selectedTab: 0 });
      quickGlassConfigured = true;
    }
    document.body.dataset.liquidGlass = 'ready';
  }

  function modelName(source, degraded = false) {
    if (source === 'remote') return modelCapabilities.serviceFake ? '测试模型服务' : api.runtime.modelLabel;
    if (source === 'fallback') return '离线回退';
    if (source === 'fake' && degraded) return '离线回退';
    if (source === 'fake') return 'Fake Adapter';
    return '本地线索';
  }

  function normalizeConnectionState(value) {
    return {
      state: connectionStates.has(value?.state) ? value.state : 'idle',
      code: typeof value?.code === 'string' ? value.code : null,
      health: value?.health && typeof value.health === 'object' ? value.health : null
    };
  }

  function activeProfile() {
    const id = persistedSettings?.activeProfileId;
    const profile = id && persistedSettings?.profiles?.[id];
    return profile && typeof profile === 'object' ? profile : null;
  }

  function applyPersistedSettings(value) {
    const next = value?.settings && value.ok !== false ? value.settings : value;
    if (!next || typeof next !== 'object' || !next.preferences || typeof next.preferences !== 'object') return false;
    persistedSettings = next;
    if (['quiet', 'balanced', 'active'].includes(next.preferences.activeLevel)) settings.activeLevel = next.preferences.activeLevel;
    if (typeof next.preferences.voice === 'boolean') settings.voice = next.preferences.voice;
    if (typeof next.preferences.captions === 'boolean') settings.captions = next.preferences.captions;
    if (typeof next.preferences.openAtLogin === 'boolean') settings.openAtLogin = next.preferences.openAtLogin;
    return true;
  }

  function connectionLabel() {
    if (api.runtime.fakeModel) return 'Fake Adapter';
    return connectionLabels[connectionState.state] || '未连接';
  }

  function renderConnectionSettings() {
    const select = $('profileSelect');
    if (!select) return;
    const profiles = Object.values(persistedSettings?.profiles || {});
    const activeId = persistedSettings?.activeProfileId || '';
    const signature = `${activeId}|${profiles.map((profile) => `${profile.id}:${profile.label}:${profile.transport}`).join('|')}`;
    if (select.dataset.signature !== signature) {
      select.replaceChildren(new Option('默认环境配置', ''));
      for (const profile of profiles) {
        select.append(new Option(`${profile.label} · ${profile.transport === 'ssh' ? 'SSH' : '直连'}`, profile.id));
      }
      select.dataset.signature = signature;
    }
    select.value = activeId;
    const profile = activeProfile();
    const sshProfile = profile?.transport === 'ssh';
    const status = $('connectionStatus');
    status.textContent = connectionLabel();
    status.dataset.state = connectionState.state === 'ready' ? 'ready' : connectionFailures.has(connectionState.state) && !api.runtime.fakeModel ? 'error' : '';
    $('reconnectModel').disabled = api.runtime.fakeModel || connectionPending.has(connectionState.state);
    $('selectCredentials').disabled = !sshProfile;
    $('remoteRootInput').disabled = !sshProfile;
    if (document.activeElement !== $('remoteRootInput')) $('remoteRootInput').value = sshProfile ? (profile.remoteRoot || '') : '';
    $('profileTransport').textContent = profile
      ? `${profile.transport === 'ssh' ? 'SSH 转发' : 'HTTP/WSS 直连'} · ${profile.model || 'cpmo'}`
      : '使用默认环境配置';
    $('credentialPath').textContent = sshProfile
      ? profile.credentialDir ? `凭据目录：${profile.credentialDir}` : '未选择凭据目录'
      : profile ? '直连配置不需要凭据目录' : '默认环境配置不需要凭据目录';
    $('connectionHint').textContent = profile?.transport === 'ssh'
      ? 'SSH 和可选 FRP 只在本机运行；远端服务不会因桌宠退出而停止。'
      : profile?.transport === 'direct'
        ? '当前使用直接 HTTP/WSS 连接；连接失败时保留本机离线回应。'
        : '模型服务不可用时，文字仍可使用本机离线回应。';
  }

  function enqueueSettingsOperation(task) {
    const run = settingsOperation.catch(() => {}).then(task).catch(() => {
      applyPersistedSettings(persistedSettings);
      showToast('设置同步失败');
      render();
      return { ok: false, code: 'ipc_error' };
    });
    settingsOperation = run;
    return run;
  }

  function showSettingsError(result) {
    const messages = {
      invalid_profile: '连接配置无效',
      credentials_missing: '凭据目录不完整',
      save_failed: '设置保存失败',
      profile_limit: '连接配置已达上限'
    };
    showToast(messages[result?.code] || '设置未保存');
  }

  function persistPreferences() {
    const preferences = {
      activeLevel: settings.activeLevel,
      voice: settings.voice,
      captions: settings.captions,
      openAtLogin: settings.openAtLogin
    };
    return enqueueSettingsOperation(async () => {
      const result = await api.settings.update({ preferences });
      if (result?.ok && applyPersistedSettings(result.settings)) render();
      else if (result?.ok === false) {
        applyPersistedSettings(persistedSettings);
        showSettingsError(result);
        render();
      }
      return result;
    });
  }

  function updateActiveProfile(patch) {
    const profile = activeProfile();
    if (!profile) return Promise.resolve({ ok: false, code: 'invalid_profile' });
    return enqueueSettingsOperation(async () => {
      const result = await api.settings.update({ profile: { ...profile, ...patch } });
      if (result?.ok && applyPersistedSettings(result.settings)) {
        render();
        void refreshModelCapabilities(true);
      } else if (result?.ok === false) {
        showSettingsError(result);
        render();
      }
      return result;
    });
  }

  async function chooseCredentials() {
    if (activeProfile()?.transport !== 'ssh') return;
    try {
      const result = await api.model.selectCredentials();
      if (result?.ok && result.credentialDir) {
        await updateActiveProfile({ credentialDir: result.credentialDir });
      } else if (result?.code && result.code !== 'cancelled') {
        showSettingsError(result);
      }
    } catch {
      showToast('凭据目录未更新');
    }
  }

  async function reconnectModel() {
    if (api.runtime.fakeModel) return showToast('Fake Adapter 无需连接');
    connectionState = { state: 'starting', code: null, health: null };
    render();
    try {
      const result = await api.model.connect();
      connectionState = normalizeConnectionState(result);
      render();
      await refreshModelCapabilities(true);
    } catch {
      connectionState = { state: 'connection_refused', code: 'ipc_error', health: null };
      render();
    }
  }

  function setModelPresentation(source, degraded = false, remoteAttempted = true) {
    const mode = source === 'remote' ? 'remote' : degraded ? 'fallback' : 'fake';
    const remoteName = modelCapabilities.serviceFake ? '测试模型服务' : '昇腾模型';
    document.body.dataset.modelSource = mode;
    $('modelLabel').textContent = modelName(source, degraded);
    $('modelBadge').textContent = mode === 'remote' ? (modelCapabilities.serviceFake ? 'Stub' : 'Ascend') : mode === 'fallback' ? 'Fallback' : 'Fake';
    $('modelPrivacy').textContent = mode === 'remote'
      ? realtimeActive
        ? `实时对话开启期间，麦克风音频${modelCapabilities.video ? '和已启用的视觉帧' : ''}会持续经本机隧道提交给${remoteName}。`
        : modelCapabilities.mode === 'duplex' && !modelCapabilities.chatCompletions
          ? '当前模型服务为实时模式；文字消息使用本机离线回应，媒体仅在开启实时对话后提交。'
          : modelCapabilities.state === 'chat' && modelCapabilities.imageInput
            ? `屏幕输入开启且主动程度非安静时，会低频提交所选画面的当前单帧用于重复问题检测；发送消息时仅按已声明能力提交文字、已启用的视觉帧${modelCapabilities.chatAudioInput ? '和约 1.6 秒音频' : ''}给${remoteName}。`
            : modelCapabilities.state === 'chat' && modelCapabilities.chatAudioInput
              ? `发送消息时仅提交文字和已启用的约 1.6 秒麦克风音频给${remoteName}；视觉不会发送。`
              : `发送消息时仅提交文字给${remoteName}；媒体不会发送。`
      : mode === 'fallback'
        ? remoteAttempted
          ? `${remoteName}未返回结果，已切换到本机离线回应；本轮请求可能已到达模型服务。`
          : '当前模型服务不支持文字请求，已使用本机离线回应；媒体未发送。'
        : '本机 Fake Adapter 演示模式；输入默认关闭，媒体不会发送到模型服务。';
  }

  function normalizeCapabilities(result) {
    const state = ['offline', 'fake', 'chat', 'duplex', 'degraded'].includes(result?.state) ? result.state : 'degraded';
    return {
      state,
      mode: ['chat', 'duplex', 'fake'].includes(result?.mode) ? result.mode : null,
      chatCompletions: result?.chatCompletions === true,
      imageInput: result?.imageInput === true,
      chatAudioInput: result?.chatAudioInput === true,
      realtime: result?.realtime === true,
      audioInput: result?.audioInput === true,
      video: result?.video === true,
      audioOutput: result?.audioOutput === true,
      serviceFake: result?.serviceFake === true,
      reason: typeof result?.reason === 'string' ? result.reason : null
    };
  }

  function canUseRealtime() {
    return ['fake', 'duplex'].includes(modelCapabilities.state) && modelCapabilities.realtime
      && modelCapabilities.audioInput && modelCapabilities.audioOutput;
  }

  function applyCapabilityPresentation() {
    if (modelCapabilities.state === 'fake') return setModelPresentation('fake');
    if (modelCapabilities.state === 'chat' || modelCapabilities.state === 'duplex') {
      return setModelPresentation('remote');
    }
    document.body.dataset.modelSource = 'fallback';
    $('modelLabel').textContent = modelCapabilities.state === 'checking'
      ? '正在连接模型'
      : '本地离线';
    $('modelBadge').textContent = modelCapabilities.state === 'checking'
      ? 'Check'
      : 'Offline';
    $('modelPrivacy').textContent = modelCapabilities.state === 'checking'
      ? '正在检查模型服务；检查完成前媒体不会发送。'
      : '模型服务未连接；文字使用本机离线回应，媒体不会发送。';
  }

  function scheduleCapabilityRetry() {
    clearTimeout(capabilityRetryTimer);
    capabilityRetryTimer = null;
    if (!api.runtime.fakeModel && sessionActive() && ['offline', 'degraded'].includes(modelCapabilities.state)) {
      capabilityRetryTimer = setTimeout(() => {
        capabilityRetryTimer = null;
        void refreshModelCapabilities(true);
      }, 5_000);
    }
  }

  function cancelCapabilityRetry() {
    clearTimeout(capabilityRetryTimer);
    capabilityRetryTimer = null;
    capabilityCheck = null;
    capabilityGeneration += 1;
  }

  async function refreshModelCapabilities(force = false) {
    if (api.runtime.fakeModel) return modelCapabilities;
    if (capabilityCheck) return capabilityCheck;
    if (!force && Date.now() - capabilitiesCheckedAt < 5_000) return modelCapabilities;
    if (!modelCapabilities.mode) modelCapabilities = { ...modelCapabilities, state: 'checking' };
    applyCapabilityPresentation();
    render();
    const generation = ++capabilityGeneration;
    const request = api.model.capabilities();
    capabilityCheck = request;
    try {
      const next = normalizeCapabilities(await request);
      if (generation !== capabilityGeneration) return modelCapabilities;
      const realtimeWasActive = realtimeActive || realtimeStarting;
      const previousState = modelCapabilities.state;
      modelCapabilities = next;
      if (previousState !== 'chat' && next.state === 'chat' && next.imageInput) screenAnalysisPaused = false;
      capabilitiesCheckedAt = Date.now();
      applyCapabilityPresentation();
      render();
      if (realtimeWasActive && !canUseRealtime()) void stopRealtime('capability_changed');
      if (next.state === 'chat' && next.imageInput) scheduleScreenAnalysis();
      else cancelScreenAnalysis();
      scheduleCapabilityRetry();
      return modelCapabilities;
    } catch {
      if (generation !== capabilityGeneration) return modelCapabilities;
      modelCapabilities = normalizeCapabilities({ state: 'offline', reason: 'ipc_error' });
      cancelScreenAnalysis();
      capabilitiesCheckedAt = Date.now();
      applyCapabilityPresentation();
      render();
      scheduleCapabilityRetry();
      return modelCapabilities;
    } finally {
      if (capabilityCheck === request) capabilityCheck = null;
    }
  }

  function hasLiveScreen() {
    return hasLiveVisual('screen', streams.get('screen'));
  }

  function hasLiveVisual(kind, stream) {
    if (kind === 'screen' && stream?.nativeFrameSource === true) return true;
    return stream?.getVideoTracks?.().some((track) => track.readyState === 'live') === true;
  }

  function canAnalyzeScreen() {
    return state.phase === PHASES.ACTIVE
      && settings.activeLevel !== 'quiet'
      && !settings.dnd
      && !settings.presentationMode
      && modelCapabilities.state === 'chat'
      && modelCapabilities.chatCompletions
      && modelCapabilities.imageInput
      && hasLiveScreen()
      && !realtimeActive
      && !realtimeStarting;
  }

  function cancelScreenAnalysis({ clearObservations = true, pause = false } = {}) {
    clearTimeout(screenAnalysisTimer);
    screenAnalysisTimer = null;
    screenAnalysisGeneration += 1;
    screenAnalysisAbortController?.abort();
    screenAnalysisAbortController = null;
    if (activeScreenAnalysisRequestId != null) api.model.cancelScreenAnalysis(activeScreenAnalysisRequestId);
    activeScreenAnalysisRequestId = null;
    screenAnalysisPaused = pause;
    if (clearObservations) observations = [];
  }

  function normalizeScreenObservation(value) {
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (!/^screen-[a-f0-9]{16}$/.test(value.eventKey)) return undefined;
    if (!['repeated_error', 'repeated_attempt'].includes(value.kind) || value.source !== 'screen') return undefined;
    if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 160 || /[\u0000-\u001f\u007f]/.test(value.summary)) return undefined;
    return { eventKey: value.eventKey, kind: value.kind, source: 'screen', summary: value.summary.trim() };
  }

  function scheduleScreenAnalysis(delayMs = SCREEN_ANALYSIS_INTERVAL_MS) {
    clearTimeout(screenAnalysisTimer);
    screenAnalysisTimer = null;
    if (screenAnalysisPaused || screenAnalysisTask) return;
    if (state.phase === PHASES.COOLDOWN && hasLiveScreen() && modelCapabilities.state === 'chat') {
      const waitMs = Math.max(0, state.cooldownUntilMs - nowMs());
      screenAnalysisTimer = setTimeout(() => {
        screenAnalysisTimer = null;
        if (state.phase === PHASES.COOLDOWN && nowMs() >= state.cooldownUntilMs) {
          state = transition(state, { type: 'EXPIRE' });
          render();
        }
        scheduleScreenAnalysis();
      }, waitMs);
      return;
    }
    if (!canAnalyzeScreen()) return;
    const generation = screenAnalysisGeneration;
    screenAnalysisTimer = setTimeout(() => {
      screenAnalysisTimer = null;
      if (generation !== screenAnalysisGeneration || !canAnalyzeScreen()) return;
      const task = runScreenAnalysis(generation);
      screenAnalysisTask = task;
      void task.catch(() => undefined).finally(() => {
        if (screenAnalysisTask === task) screenAnalysisTask = null;
        scheduleScreenAnalysis();
      });
    }, Math.max(0, delayMs));
  }

  async function runScreenAnalysis(generation) {
    const stream = streams.get('screen');
    const controller = new AbortController();
    screenAnalysisAbortController = controller;
    try {
      const frame = await captureFrame('screen', stream, controller.signal);
      if (!frame || generation !== screenAnalysisGeneration || !canAnalyzeScreen()) return;
      const requestId = ++screenAnalysisRequestSequence;
      activeScreenAnalysisRequestId = requestId;
      let result;
      try {
        result = await api.model.analyzeScreen({ imageDataUrl: frame.dataUrl, requestId });
      } catch {
        result = { ok: false, code: 'ipc_error' };
      } finally {
        if (activeScreenAnalysisRequestId === requestId) activeScreenAnalysisRequestId = null;
      }
      if (generation !== screenAnalysisGeneration || !canAnalyzeScreen()) return;
      if (result?.ok !== true) {
        cancelScreenAnalysis({ clearObservations: true, pause: true });
        const recoveryGeneration = screenAnalysisGeneration;
        const recovered = await refreshModelCapabilities(true);
        if (recoveryGeneration === screenAnalysisGeneration
            && recovered.state === 'chat'
            && recovered.chatCompletions
            && recovered.imageInput
            && hasLiveScreen()) {
          screenAnalysisPaused = false;
        }
        return;
      }
      const observation = normalizeScreenObservation(result.observation);
      if (observation === undefined) {
        cancelScreenAnalysis({ clearObservations: true, pause: true });
        return;
      }
      if (observation) recordObservation({ ...observation, observedAtMs: nowMs() });
    } finally {
      if (screenAnalysisAbortController === controller) screenAnalysisAbortController = null;
    }
  }

  function setSurfaceOrigin(surface, source) {
    if (!surface || !source?.isConnected) return;
    const surfaceRect = surface.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const x = clamp(sourceRect.left + sourceRect.width / 2 - surfaceRect.left, 0, surfaceRect.width);
    const y = clamp(sourceRect.top + sourceRect.height / 2 - surfaceRect.top, 0, surfaceRect.height);
    surface.style.transformOrigin = `${Math.round(x)}px ${Math.round(y)}px`;
  }

  function applyTransition(event) {
    state = transition(state, event);
    render();
    return state;
  }

  function showToast(text, duration = 2100) {
    $('toast').textContent = text;
    $('toast').dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').dataset.show = 'false'; }, duration);
  }

  function showCaption(text, duration = 4200) {
    clearTimeout(captionTimer);
    if (!settings.captions || !text || panel !== 'none') {
      $('caption').textContent = '';
      $('caption').dataset.show = 'false';
      return;
    }
    $('caption').textContent = text;
    $('caption').dataset.show = 'true';
    captionTimer = setTimeout(() => { $('caption').dataset.show = 'false'; }, duration);
  }

  function resolvePetState() {
    if (draggingPet) return 'drag';
    if (transientPetState) return transientPetState;
    if (panel === 'nudge' || state.phase === PHASES.NUDGE) return 'nudge';
    if (modelBusy || realtimeStarting) return 'thinking';
    if (settings.dnd) return 'dnd';
    if (sessionActive()) return 'listening';
    return 'idle';
  }

  function syncPetState() {
    document.body.dataset.petState = resolvePetState();
  }

  function setPetState(value, duration = 0) {
    clearTimeout(petStateTimer);
    transientPetState = value === 'idle' ? null : value;
    syncPetState();
    if (duration > 0) petStateTimer = setTimeout(() => {
      petStateTimer = null;
      transientPetState = null;
      syncPetState();
    }, duration);
  }

  function cancelSpeech() {
    speechGeneration += 1;
    window.speechSynthesis?.cancel();
  }

  function speak(text) {
    const generation = ++speechGeneration;
    showCaption(text);
    if (!settings.voice || settings.dnd || settings.presentationMode || !sessionActive() || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.onstart = () => {
      if (generation !== speechGeneration || (transientPetState && transientPetState !== 'speaking')) return;
      setPetState('speaking');
    };
    utterance.onend = () => {
      if (generation !== speechGeneration || transientPetState !== 'speaking') return;
      setPetState(panel === 'nudge' ? 'nudge' : 'idle');
    };
    utterance.onerror = () => {
      if (generation === speechGeneration && transientPetState === 'speaking') setPetState('idle');
    };
    window.speechSynthesis.speak(utterance);
  }

  function setPanel(next, source = null) {
    if (panel === 'assist' && next !== 'assist' && (realtimeActive || realtimeStarting)) void stopRealtime('card_hidden');
    if (next !== 'none' && source) restoreFocus = source;
    panel = next;
    document.body.dataset.panel = panel;
    if (next !== 'none') {
      clearTimeout(toastTimer);
      clearTimeout(captionTimer);
      $('toast').dataset.show = 'false';
      $('caption').dataset.show = 'false';
      $('toast').textContent = '';
      $('caption').textContent = '';
    }
    const map = { settings: 'settingsPanel', assist: 'assistCard', nudge: 'nudgeBubble', context: 'contextMenu' };
    for (const [name, id] of Object.entries(map)) {
      const open = name === panel;
      const surface = $(id);
      if (open) setSurfaceOrigin(surface, source);
      surface.dataset.open = String(open);
      surface.setAttribute('aria-hidden', String(!open));
    }
    $('settingsButton').setAttribute('aria-expanded', String(panel === 'settings'));
    syncPetState();
    if (next !== 'none') api.window.focus();
    if (next === 'settings') void loadSources();
    if (next === 'settings' || next === 'assist') void refreshModelCapabilities();
    requestAnimationFrame(() => {
      if (next === 'assist') $('messageInput').focus();
      if (next === 'settings') $('closeSettings').focus();
      if (next === 'nudge') $('acceptNudge').focus();
      if (next === 'context') $('contextSession').focus();
    });
  }

  function closePanel({ restore = true } = {}) {
    const target = restoreFocus;
    setPanel('none');
    restoreFocus = null;
    if (restore && target?.isConnected) requestAnimationFrame(() => target.focus());
  }

  function statusText() {
    if (!sessionActive()) return '感知关闭';
    if (settings.dnd) return '勿扰';
    if (settings.presentationMode) return '演示模式';
    if (streams.size) return `陪伴中 · ${streams.size} 项输入`;
    return '陪伴中 · 输入关闭';
  }

  function render() {
    document.body.dataset.phase = state.phase;
    document.body.dataset.dnd = String(settings.dnd);
    syncPetState();
    $('petStatus').dataset.state = state.phase;
    $('statusText').textContent = statusText();
    $('sensorBadge').textContent = String(streams.size);
    $('sensorBadge').dataset.active = String(streams.size > 0);
    $('sensorBadge').setAttribute('aria-label', `${streams.size} 项输入`);

    const active = sessionActive();
    $('sessionButton').querySelector('span').textContent = active ? '结束陪伴' : '开始陪伴';
    $('sessionPlayIcon').hidden = active;
    $('sessionStopIcon').hidden = !active;
    $('contextSession').querySelector('span').textContent = active ? '结束陪伴' : '开始陪伴';
    $('contextSessionPlayIcon').hidden = active;
    $('contextSessionStopIcon').hidden = !active;
    $('simulateCue').disabled = !active || settings.activeLevel === 'quiet' || settings.dnd || settings.presentationMode || state.phase !== PHASES.ACTIVE;
    $('contextPause').disabled = streams.size === 0;
    const realtimeSupported = canUseRealtime();
    const realtimeUnavailableText = modelCapabilities.state === 'checking'
      ? '正在检查模型'
      : modelCapabilities.state === 'chat' ? '当前为文字模式' : modelCapabilities.state === 'degraded' ? '实时服务不可用' : '模型服务未连接';
    $('realtimeToggle').disabled = !sessionActive()
      || (!streams.has('microphone') && !realtimeActive)
      || (!realtimeSupported && !realtimeActive && !realtimeStarting);
    $('realtimeToggle').setAttribute('aria-pressed', String(realtimeActive));
    $('realtimeToggle').setAttribute('aria-busy', String(realtimeStarting));
    $('realtimeToggle').querySelector('span').textContent = realtimeStarting ? '取消连接' : realtimeActive ? '停止实时' : '实时对话';
    $('messageInput').disabled = realtimeActive || realtimeStarting;
    $('sendMessage').disabled = modelBusy || realtimeActive || realtimeStarting;
    $('realtimeStatus').textContent = realtimeStarting
      ? '正在连接…'
      : realtimeActive ? realtimeStateText : !realtimeSupported ? realtimeUnavailableText : streams.has('microphone') ? '麦克风已就绪' : '麦克风关闭';
    $('realtimeToggle').title = realtimeSupported ? '' : realtimeUnavailableText;
    $('sessionRequirement').textContent = active ? '按需单独开启' : '需先开始陪伴';
    for (const [kind, control] of Object.entries(inputControls)) {
      control.disabled = !active || (kind === 'screen' && !$('screenSource').value);
      control.checked = streams.has(kind);
      const label = streams.has(kind) ? (kind === 'screen' && selectedSourceName ? selectedSourceName : '已启用') : '已关闭';
      inputStatus[kind].textContent = label;
      testStatus[kind].dataset.active = String(streams.has(kind));
    }
    $('dndToggle').checked = settings.dnd;
    $('presentationToggle').checked = settings.presentationMode;
    $('voiceToggle').checked = settings.voice;
    $('captionToggle').checked = settings.captions;
    $('openAtLoginToggle').checked = settings.openAtLogin;
    document.querySelector(`input[name="activeLevel"][value="${settings.activeLevel}"]`).checked = true;
    $('dndButton').setAttribute('aria-pressed', String(settings.dnd));
    const dndLabel = settings.dnd ? '关闭勿扰' : '开启勿扰';
    $('dndButton').setAttribute('aria-label', dndLabel);
    $('contextDnd').querySelector('span').textContent = settings.dnd ? '解除勿扰' : '勿扰';
    renderConnectionSettings();
    syncQuickGlass();
    api.app.updateState({ phase: state.phase, activeLevel: settings.activeLevel, dnd: settings.dnd, activeInputs: [...streams.keys()] });
  }

  async function loadSources() {
    if (sourceLoaded) return;
    try {
      const sources = await api.capture.listSources();
      const select = $('screenSource');
      sources.forEach((source, index) => {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = source.name;
        option.dataset.testid = `screen-source-${index}`;
        select.append(option);
      });
      sourceLoaded = true;
      render();
    } catch {
      showToast('屏幕来源暂不可用');
    }
  }

  function invalidateModelRequest() {
    requestGeneration += 1;
    modelAbortController?.abort();
    modelAbortController = null;
    modelBusy = false;
    $('sendMessage').disabled = false;
  }

  function stopTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks?.() || []) track.stop();
  }

  function nextInputGeneration(kind) {
    const next = (inputGenerations.get(kind) || 0) + 1;
    inputGenerations.set(kind, next);
    return next;
  }

  function stopInput(kind) {
    nextInputGeneration(kind);
    realtimeMediaGeneration += 1;
    invalidateModelRequest();
    if (kind === 'screen') cancelScreenAnalysis();
    if (kind === 'microphone' && (realtimeActive || realtimeStarting)) void stopRealtime('microphone_stopped');
    const stream = streams.get(kind);
    stopTracks(stream);
    streams.delete(kind);
    if (kind === 'camera') {
      $('cameraPreview').srcObject = null;
      $('cameraPreview').hidden = true;
    }
    if (sessionActive() && state.activeInputs.includes(kind)) {
      try { state = transition(state, { type: 'INPUT_STOPPED', kind }); } catch { /* ending session */ }
    }
    render();
  }

  function stopAllInputs() {
    const started = performance.now();
    for (const kind of Object.keys(inputControls)) stopInput(kind);
    return performance.now() - started;
  }

  async function setInput(kind, enabled) {
    if (!enabled) return stopInput(kind);
    if (!sessionActive()) {
      inputControls[kind].checked = false;
      return showToast('请先开始陪伴');
    }
    if (kind === 'screen' && !$('screenSource').value) {
      inputControls[kind].checked = false;
      return showToast('请先选择窗口或屏幕');
    }
    const generation = nextInputGeneration(kind);
    if (kind === 'screen') cancelScreenAnalysis();
    stopTracks(streams.get(kind));
    streams.delete(kind);
    invalidateModelRequest();
    mediaCalls += 1;
    try {
      if (kind === 'screen') {
        const accepted = await api.capture.selectSource($('screenSource').value);
        if (!accepted) throw new Error('source_unavailable');
      }
      const stream = kind === 'screen' && api.capture.nativeFrames === true && typeof api.capture.frame === 'function'
        ? nativeScreenStream
        : kind === 'screen'
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
          : await navigator.mediaDevices.getUserMedia({ audio: kind === 'microphone', video: kind === 'camera' });
      if (generation !== inputGenerations.get(kind) || !sessionActive() || !inputControls[kind].checked) {
        stopTracks(stream);
        return;
      }
      stopTracks(streams.get(kind));
      streams.set(kind, stream);
      state = transition(state, { type: 'INPUT_STARTED', kind });
      for (const track of stream.getTracks?.() || []) track.addEventListener('ended', () => {
        if (generation === inputGenerations.get(kind)) stopInput(kind);
      }, { once: true });
      if (kind === 'camera') {
        $('cameraPreview').srcObject = stream;
        $('cameraPreview').hidden = false;
      }
      if (kind === 'screen') {
        screenAnalysisPaused = false;
        scheduleScreenAnalysis();
      }
      render();
    } catch {
      if (generation !== inputGenerations.get(kind)) return;
      inputControls[kind].checked = false;
      showToast(`${inputNames[kind]}未启用`);
      render();
    }
  }

  function resetTransient() {
    clearTimeout(cueTimer);
    cueTimer = null;
    observations = [];
    latestObservationSummary = null;
    cancelScreenAnalysis();
    cancelCapabilityRetry();
    messages.length = 0;
    turnCount = 0;
    void stopRealtime('session_reset');
    invalidateModelRequest();
    $('conversation').replaceChildren();
    $('messageInput').value = '';
    clearObservationNote();
    cancelSpeech();
    showCaption('');
    closePanel({ restore: false });
    setPetState('idle');
  }

  function startSession() {
    if (sessionActive()) return;
    applyTransition({ type: 'START' });
    screenAnalysisPaused = false;
    void refreshModelCapabilities(true);
    showToast('陪伴已开启，输入权限仍由你选择');
    speak('我在这里。需要时叫我。');
  }

  function endSession() {
    stopAllInputs();
    resetTransient();
    state = transition(state, { type: 'END' });
    settings.dnd = false;
    settings.presentationMode = false;
    render();
  }

  function toggleSession() {
    sessionActive() ? endSession() : startSession();
  }

  function setDnd(value) {
    settings.dnd = Boolean(value);
    if (panel === 'nudge' && state.phase === PHASES.NUDGE) {
      state = transition(state, { type: 'DISMISS', atMs: nowMs() });
      closePanel();
    }
    if (sessionActive() && state.phase !== PHASES.NUDGE && state.phase !== PHASES.PENDING) {
      try { state = transition(state, { type: 'SET_DND', value: settings.dnd }); } catch { /* UI setting persists */ }
    }
    if (settings.dnd) cancelSpeech();
    if (settings.dnd) setPetState('idle');
    if (settings.dnd && (realtimeActive || realtimeStarting)) void stopRealtime('dnd_enabled');
    if (settings.dnd) cancelScreenAnalysis();
    else scheduleScreenAnalysis();
    render();
  }

  function setPresentation(value) {
    settings.presentationMode = Boolean(value);
    if (panel === 'nudge' && state.phase === PHASES.NUDGE) {
      state = transition(state, { type: 'DISMISS', atMs: nowMs() });
      closePanel();
    }
    if (sessionActive() && state.phase !== PHASES.NUDGE && state.phase !== PHASES.PENDING) {
      try { state = transition(state, { type: 'SET_PRESENTATION', value: settings.presentationMode }); } catch { /* UI setting persists */ }
    }
    if (settings.presentationMode) cancelSpeech();
    if (settings.presentationMode && (realtimeActive || realtimeStarting)) void stopRealtime('presentation_enabled');
    if (settings.presentationMode) cancelScreenAnalysis();
    else scheduleScreenAnalysis();
    render();
  }

  function setActiveLevel(value) {
    if (!['quiet', 'balanced', 'active'].includes(value)) return;
    settings.activeLevel = value;
    observations = [];
    cancelScreenAnalysis({ pause: value === 'quiet' });
    void persistPreferences();
    if (value === 'quiet' && state.phase === PHASES.NUDGE) dismissNudge();
    else {
      scheduleScreenAnalysis();
      render();
    }
  }

  function recordObservation(observation, { showPending = false, speakCue = false } = {}) {
    if (state.phase === PHASES.COOLDOWN && nowMs() >= state.cooldownUntilMs) state = transition(state, { type: 'EXPIRE' });
    if (state.phase !== PHASES.ACTIVE) return false;
    if (typeof observation?.summary === 'string' && observation.summary.trim() && observation.summary.trim().length <= 160) {
      latestObservationSummary = observation.summary.trim();
    }
    observations.push(observation);
    observations = observations.slice(-3);
    const decision = decideNudge({
      phase: state.phase,
      activeLevel: settings.activeLevel,
      dnd: settings.dnd,
      presentationMode: settings.presentationMode,
      cooldownUntilMs: state.cooldownUntilMs,
      seenEventKeys: state.seenEventKeys,
      observations,
      nowMs: nowMs()
    });
    if (decision.action !== 'nudge') {
      if (showPending && observations.length === 1) showToast('已记录一次可观察线索，我再看看');
      return false;
    }
    const matched = observations.findLast((item) => item.eventKey === decision.eventKey);
    latestObservationSummary = typeof matched?.summary === 'string' && matched.summary.trim().length <= 160
      ? matched.summary.trim()
      : null;
    clearTimeout(toastTimer);
    $('toast').dataset.show = 'false';
    state = transition(state, { type: 'CUES_READY', eventKey: decision.eventKey });
    state = transition(state, { type: 'SHOW_NUDGE' });
    cancelScreenAnalysis({ clearObservations: false });
    const prompt = nudgePrompt(matched?.kind);
    $('nudgeText').textContent = prompt;
    setPanel('nudge', pet);
    setPetState('nudge', 280);
    if (speakCue) speak(prompt);
    render();
    return true;
  }

  function emitCue() {
    return recordObservation({
      eventKey: 'simulated-repeat-error',
      kind: 'repeated_error',
      source: 'screen',
      observedAtMs: nowMs(),
      summary: '同一个错误重复出现'
    }, { showPending: true, speakCue: true });
  }

  function simulateCueFlow() {
    if (!emitCue() && !api.runtime.testMode && observations.length === 1) {
      clearTimeout(cueTimer);
      cueTimer = setTimeout(() => emitCue(), 5100);
    }
  }

  function addMessage(role, text, error = false, source = null) {
    const record = { role, text, error, source };
    messages.push(record);
    while (messages.length > 6) messages.shift();
    const row = document.createElement('p');
    row.className = `message ${role}${error ? ' error' : ''}`;
    const label = document.createElement('small');
    label.textContent = role === 'user' ? '你' : modelName(source || (api.runtime.fakeModel ? 'fake' : 'remote'));
    row.append(label, document.createTextNode(text));
    $('conversation').append(row);
    while ($('conversation').children.length > 6) $('conversation').firstElementChild.remove();
    $('conversation').scrollTop = $('conversation').scrollHeight;
    return { record, row };
  }

  function clearObservationNote() {
    $('observationNote').hidden = true;
    $('observationNoteText').textContent = '';
  }

  function acceptNudge() {
    if (state.phase !== PHASES.NUDGE) return;
    state = transition(state, { type: 'ACCEPT' });
    setPanel('assist', pet);
    $('conversation').replaceChildren();
    messages.length = 0;
    const prompt = '我看到一个重复线索，可以一起看看。';
    $('observationNoteText').textContent = latestObservationSummary || '';
    $('observationNote').hidden = !latestObservationSummary;
    addMessage('assistant', prompt, false, 'local');
    speak(prompt);
    render();
  }

  function dismissNudge() {
    if (state.phase !== PHASES.NUDGE) return;
    state = transition(state, { type: 'DISMISS', atMs: nowMs() });
    closePanel();
    setPetState('idle');
    showToast('好的，我先不打扰');
    render();
    scheduleScreenAnalysis();
  }

  function finishEngagement() {
    void stopRealtime('card_closed');
    invalidateModelRequest();
    if (state.phase === PHASES.ENGAGED) state = transition(state, { type: 'FINISH', atMs: nowMs() });
    clearObservationNote();
    closePanel();
    setPetState('idle');
    render();
    scheduleScreenAnalysis();
  }

  function waitForVideoFrame(video, timeoutMs = 1400, signal = null) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error('capture_cancelled'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('canplay', ready);
        signal?.removeEventListener('abort', abort);
      };
      const ready = () => {
        if (video.videoWidth <= 0) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('visual_frame_timeout'));
      }, timeoutMs);
      const abort = () => {
        cleanup();
        reject(new Error('capture_cancelled'));
      };
      video.addEventListener('loadeddata', ready);
      video.addEventListener('canplay', ready);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  function playVideo(video, timeoutMs = 1400, signal = null) {
    if (signal?.aborted) return Promise.reject(new Error('capture_cancelled'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error('capture_cancelled'));
      const timer = setTimeout(() => finish(new Error('video_play_timeout')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      Promise.resolve().then(() => video.play()).then(
        () => finish(),
        () => finish(new Error('video_play_failed'))
      );
    });
  }

  async function captureFrame(kind, stream, signal = null) {
    if (kind === 'screen' && stream?.nativeFrameSource === true) {
      if (signal?.aborted) return null;
      try {
        const frame = await api.capture.frame();
        if (signal?.aborted || typeof frame?.dataUrl !== 'string'
            || !frame.dataUrl.startsWith('data:image/jpeg;base64,')
            || frame.dataUrl.length > MAX_FRAME_DATA_URL_LENGTH) return null;
        return { dataUrl: frame.dataUrl, source: 'screen' };
      } catch {
        return null;
      }
    }
    const temporary = kind !== 'camera';
    const video = temporary ? document.createElement('video') : $('cameraPreview');
    try {
      if (temporary) {
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await playVideo(video, 1400, signal);
      }
      await waitForVideoFrame(video, 1400, signal);
      if (signal?.aborted) return null;
      const scale = Math.min(1, 960 / video.videoWidth, 540 / video.videoHeight);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', .72);
      if (dataUrl.length > MAX_FRAME_DATA_URL_LENGTH) return null;
      return { dataUrl, source: kind };
    } catch {
      return null;
    } finally {
      if (temporary) {
        video.pause();
        video.srcObject = null;
      }
    }
  }

  async function captureVisualContext(signal = null) {
    visualCaptureCalls += 1;
    for (const kind of ['screen', 'camera']) {
      if (signal?.aborted) return null;
      const stream = streams.get(kind);
      if (!hasLiveVisual(kind, stream)) continue;
      const frame = await captureFrame(kind, stream, signal);
      if (frame) return frame;
    }
    return null;
  }

  function encodeWav(chunks, sampleRate, frameCount) {
    const samples = new Float32Array(frameCount);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk.subarray(0, Math.min(chunk.length, frameCount - offset)), offset);
      offset += Math.min(chunk.length, frameCount - offset);
      if (offset >= frameCount) break;
    }
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const write = (at, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(at + index, text.charCodeAt(index)); };
    write(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return `data:audio/wav;base64,${btoa(binary)}`;
  }

  async function captureMicrophoneAudio(stream, durationMs = 1600, signal = null) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || signal?.aborted || !stream?.getAudioTracks().some((track) => track.readyState === 'live')) return null;
    let context;
    let source;
    let processor;
    let gain;
    try {
      context = new AudioContextClass();
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(2048, 1, 1);
      gain = context.createGain();
      gain.gain.value = 0;
      await context.resume();
      if (signal?.aborted) throw new Error('capture_cancelled');
      return await new Promise((resolve) => {
        const chunks = [];
        const targetFrames = Math.max(1, Math.round(context.sampleRate * durationMs / 1000));
        let frameCount = 0;
        let settled = false;
        let timer;
        const finish = (includeAudio) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          processor.onaudioprocess = null;
          try { source.disconnect(); } catch { /* already disconnected */ }
          try { processor.disconnect(); } catch { /* already disconnected */ }
          try { gain.disconnect(); } catch { /* already disconnected */ }
          let output = null;
          if (includeAudio && frameCount) {
            try { output = encodeWav(chunks, context.sampleRate, Math.min(frameCount, targetFrames)); } catch { output = null; }
          }
          void context.close().catch(() => undefined);
          resolve(output);
        };
        const abort = () => finish(false);
        processor.onaudioprocess = (event) => {
          if (signal?.aborted) return finish(false);
          const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
          chunks.push(chunk);
          frameCount += chunk.length;
          if (frameCount >= targetFrames) finish(true);
        };
        signal?.addEventListener('abort', abort, { once: true });
        source.connect(processor);
        processor.connect(gain);
        gain.connect(context.destination);
        timer = setTimeout(() => finish(true), durationMs + 800);
      });
    } catch {
      try { source?.disconnect(); } catch { /* not connected */ }
      try { processor?.disconnect(); } catch { /* not connected */ }
      try { gain?.disconnect(); } catch { /* not connected */ }
      if (context && context.state !== 'closed') await context.close().catch(() => undefined);
      return null;
    }
  }

  async function captureModelContext(signal = null, { visual = false, audio = false } = {}) {
    const microphone = streams.get('microphone');
    const [image, audioDataUrl] = await Promise.all([
      visual ? captureVisualContext(signal).catch(() => null) : Promise.resolve(null),
      audio && microphone ? captureMicrophoneAudio(microphone, 1600, signal).catch(() => null) : Promise.resolve(null)
    ]);
    return { imageDataUrl: image?.dataUrl || null, audioDataUrl };
  }

  async function sendMessage(text) {
    if (modelBusy || realtimeActive || state.phase !== PHASES.ENGAGED) return;
    const clean = String(text || '').trim().slice(0, 280);
    if (!clean) return;
    addMessage('user', clean);
    $('messageInput').value = '';
    modelBusy = true;
    render();
    const requestTurn = ++turnCount;
    const requestId = ++requestGeneration;
    const controller = new AbortController();
    modelAbortController = controller;
    try {
      if (!api.runtime.fakeModel && ['checking', 'offline', 'degraded'].includes(modelCapabilities.state)) {
        await refreshModelCapabilities(true);
      }
      if (requestId !== requestGeneration || state.phase !== PHASES.ENGAGED) return;
      const useRemoteChat = !api.runtime.fakeModel
        && modelCapabilities.state === 'chat'
        && modelCapabilities.chatCompletions;
      const context = useRemoteChat
        ? await captureModelContext(controller.signal, {
          visual: modelCapabilities.imageInput,
          audio: modelCapabilities.chatAudioInput
        })
        : { imageDataUrl: null, audioDataUrl: null };
      if (requestId !== requestGeneration || state.phase !== PHASES.ENGAGED) return;
      const result = await api.model.chat({
        messages: messages.map(({ role, text: content }) => ({ role, content })),
        imageDataUrl: context.imageDataUrl,
        audioDataUrl: context.audioDataUrl,
        localOnly: !api.runtime.fakeModel && !useRemoteChat,
        turn: requestTurn
      });
      if (requestId !== requestGeneration || state.phase !== PHASES.ENGAGED) return;
      setModelPresentation(result.source, result.degraded === true, result.remoteAttempted !== false);
      const responseSource = result.degraded ? 'fallback' : result.source;
      if (result.ok) {
        addMessage('assistant', result.text, false, responseSource);
        speak(result.text);
        if (result.degraded) showToast('昇腾模型连接失败，已切换离线回应');
      } else {
        addMessage('assistant', result.message, true, responseSource);
        showCaption(result.message);
        showToast(result.degraded ? '模型与离线回退均未返回结果' : '模型未返回结果');
        setPetState('error', 1800);
      }
    } catch {
      if (requestId !== requestGeneration || state.phase !== PHASES.ENGAGED) return;
      setModelPresentation('fake', true);
      addMessage('assistant', '模型连接暂不可用，请稍后重试。', true, 'fallback');
      showToast('模型连接暂不可用');
      setPetState('error', 1800);
    } finally {
      if (requestId === requestGeneration) {
        if (modelAbortController === controller) modelAbortController = null;
        modelBusy = false;
        render();
        if (state.phase === PHASES.ENGAGED) $('messageInput').focus();
      }
    }
  }

  function takeAudioFrames(chunks, frameCount) {
    const output = new Float32Array(frameCount);
    let offset = 0;
    while (offset < frameCount && chunks.length) {
      const chunk = chunks[0];
      const take = Math.min(chunk.length, frameCount - offset);
      output.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(take);
    }
    return output;
  }

  async function createRealtimeCapture(stream, generation, allowVisual = false) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !stream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      throw new Error('microphone_unavailable');
    }
    const context = new AudioContextClass();
    const chunks = [];
    const sourceFramesPerChunk = Math.round(context.sampleRate);
    let source = null;
    let processor = null;
    let gain = null;
    let bufferedFrames = 0;
    let inputQueue = null;
    let frameCapturePending = false;
    let latestFrame = null;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (processor) processor.onaudioprocess = null;
      try { source?.disconnect(); } catch { /* already disconnected */ }
      try { processor?.disconnect(); } catch { /* already disconnected */ }
      try { gain?.disconnect(); } catch { /* already disconnected */ }
      inputQueue?.stop();
      inputQueue = null;
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      latestFrame = null;
      void context.close().catch(() => undefined);
    };

    const captureLatestFrame = () => {
      if (!allowVisual || frameCapturePending || stopped) return;
      frameCapturePending = true;
      const mediaGeneration = realtimeMediaGeneration;
      void captureVisualContext().then((frame) => {
        if (!stopped && mediaGeneration === realtimeMediaGeneration) latestFrame = frame ? { frame, mediaGeneration } : null;
      }).catch(() => undefined).finally(() => { frameCapturePending = false; });
    };
    const appendChunk = (samples) => {
      if (stopped || generation !== realtimeGeneration) samples.fill(0);
      else {
        captureLatestFrame();
        inputQueue.push(samples);
      }
    };

    inputQueue = new window.FloatingPetRealtimeAudio.BoundedAudioInputQueue(async (samples) => {
      let audio;
      try {
        audio = window.FloatingPetRealtimeAudio.encodeFloat32Base64(
          window.FloatingPetRealtimeAudio.resampleFloat32(samples, context.sampleRate, 16_000)
        );
      } finally {
        samples.fill(0);
      }
      const pendingFrame = latestFrame;
      latestFrame = null;
      const image = pendingFrame?.mediaGeneration === realtimeMediaGeneration ? pendingFrame.frame : null;
      const videoFrames = image && generation === realtimeGeneration ? [image.dataUrl.replace(/^data:image\/jpeg;base64,/, '')] : [];
      const result = await api.realtime.append({ audio, videoFrames, maxSliceNums: 1 });
      if (result?.ok === false) throw new Error(result.code || 'append_failed');
    }, {
      onError: (error) => {
        if (generation !== realtimeGeneration) return;
        const overflow = error?.code === 'audio_input_overflow';
        void stopRealtime(overflow ? 'audio_input_overflow' : 'append_failed', {
          message: overflow ? '语音积压已达 30 秒，实时对话已停止' : '实时连接已中断'
        });
      }
    });

    try {
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      gain = context.createGain();
      gain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (stopped || generation !== realtimeGeneration) return;
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
        chunks.push(chunk);
        bufferedFrames += chunk.length;
        if (bufferedFrames >= sourceFramesPerChunk) {
          bufferedFrames -= sourceFramesPerChunk;
          appendChunk(takeAudioFrames(chunks, sourceFramesPerChunk));
        }
      };
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      await window.FloatingPetRealtimeAudio.resumeAudioContext(context);
      return { stop };
    } catch (error) {
      stop();
      throw error;
    }
  }

  function appendRealtimeText(text) {
    const existing = realtimeAssistant?.record?.text?.length || 0;
    const clean = String(text || '').slice(0, Math.max(0, Math.min(1000, MAX_REALTIME_TEXT_CHARS - existing)));
    if (!clean) return;
    if (!realtimeAssistant?.row?.isConnected) {
      realtimeAssistant = addMessage('assistant', clean, false, 'remote');
    } else {
      realtimeAssistant.record.text += clean;
      realtimeAssistant.row.append(document.createTextNode(clean));
      $('conversation').scrollTop = $('conversation').scrollHeight;
    }
    showCaption(realtimeAssistant.record.text, 6000);
  }

  async function startRealtime() {
    if (realtimeActive || realtimeStarting) return;
    if (modelBusy) {
      showToast('请等待当前回复完成');
      return;
    }
    if (!canUseRealtime()) {
      await refreshModelCapabilities(true);
      if (!canUseRealtime()) {
        showToast(modelCapabilities.state === 'chat' ? '当前模型服务为文字模式' : '实时模型服务未连接');
        return;
      }
    }
    const microphone = streams.get('microphone');
    if (!microphone?.getAudioTracks().some((track) => track.readyState === 'live')) {
      showToast('请先开启麦克风');
      return;
    }
    realtimeStarting = true;
    realtimePlaybackAccepted = 0;
    realtimeStateText = '正在连接…';
    const generation = ++realtimeGeneration;
    let pendingPlayback = null;
    let pendingCapture = null;
    render();
    try {
      const mode = modelCapabilities.video && (streams.has('screen') || streams.has('camera')) ? 'video' : 'audio';
      const result = await api.realtime.start({
        mode,
        requestId: generation,
        systemPrompt: '你是简洁、友好的桌面陪伴助手。只根据当前听到和看到的内容回应。'
      });
      if (result?.ok === false) throw new Error(result.code || 'realtime_unavailable');
      if (generation !== realtimeGeneration || state.phase !== PHASES.ENGAGED) return;
      pendingPlayback = new window.FloatingPetRealtimeAudio.PcmPlayback();
      pendingCapture = await createRealtimeCapture(microphone, generation, mode === 'video');
      if (generation !== realtimeGeneration || state.phase !== PHASES.ENGAGED) return;
      realtimePlayback = pendingPlayback;
      realtimeCapture = pendingCapture;
      pendingPlayback = null;
      pendingCapture = null;
      realtimeActive = true;
      realtimeStateText = '实时监听中';
      realtimeAssistant = null;
      realtimeErrorCode = '';
      setModelPresentation(api.runtime.fakeModel ? 'fake' : 'remote');
      showToast('实时对话已开启');
    } catch (error) {
      if (generation === realtimeGeneration) {
        realtimeCapture?.stop();
        realtimeCapture = null;
        await realtimePlayback?.close();
        realtimePlayback = null;
        realtimeErrorCode = String(error?.message || 'realtime_unavailable').slice(0, 80);
        realtimeStateText = '暂不可用';
        showToast('实时对话暂不可用');
        setPetState('error', 1800);
        await api.realtime.stop('start_failed').catch(() => undefined);
        void refreshModelCapabilities(true);
      }
    } finally {
      pendingCapture?.stop();
      await pendingPlayback?.close();
      if (generation === realtimeGeneration) realtimeStarting = false;
      render();
    }
  }

  async function stopRealtime(reason = 'user_stop', { message = null, notify = true } = {}) {
    const wasRunning = realtimeActive || realtimeStarting || Boolean(realtimeCapture);
    realtimeGeneration += 1;
    realtimeActive = false;
    realtimeStarting = false;
    realtimeStateText = streams.has('microphone') ? '麦克风已就绪' : '麦克风关闭';
    realtimeAssistant = null;
    realtimeCapture?.stop();
    realtimeCapture = null;
    const playback = realtimePlayback;
    playback?.clear();
    realtimePlayback = null;
    const remoteStop = notify && wasRunning ? api.realtime.stop(reason).catch(() => undefined) : Promise.resolve();
    setPetState('idle');
    applyCapabilityPresentation();
    render();
    if (message) showToast(message);
    await Promise.all([playback?.close(), remoteStop]);
  }

  function handleRealtimeEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.requestId !== realtimeGeneration) return;
    if (!realtimeActive && !realtimeStarting) return;
    if (event.type === 'ready') {
      realtimeStateText = '实时监听中';
      render();
      return;
    }
    if (event.type === 'listen') {
      realtimeAssistant = null;
      realtimeStateText = '实时监听中';
      setPetState('idle');
      render();
      return;
    }
    if (event.type === 'text') {
      realtimeStateText = '模型正在回应';
      appendRealtimeText(event.text);
      setPetState('speaking');
      render();
      return;
    }
    if (event.type === 'audio') {
      realtimeStateText = '模型正在说话';
      setPetState('speaking');
      if (!settings.voice || settings.dnd || settings.presentationMode) return;
      void realtimePlayback?.enqueueBase64(event.audio, event.sampleRate || 24_000).then((accepted) => {
        if (accepted === true) realtimePlaybackAccepted += 1;
        else showToast('语音队列已满，继续显示字幕');
      }).catch(() => showToast('语音不可用，继续显示字幕'));
      render();
      return;
    }
    if (event.type === 'error') {
      void stopRealtime(event.code || 'realtime_error', { message: '实时连接异常', notify: false }).finally(() => setPetState('error', 1800));
      void refreshModelCapabilities(true);
      return;
    }
    if (event.type === 'closed') void stopRealtime(event.reason || 'closed', { notify: false });
  }

  function openSettings(source) {
    if (state.phase === PHASES.NUDGE) dismissNudge();
    setPanel('settings', source);
  }
  function openContext(source) { setPanel('context', source); }

  $('sessionButton').addEventListener('click', toggleSession);
  $('settingsButton').addEventListener('click', () => panel === 'settings' ? closePanel() : openSettings($('settingsButton')));
  $('dndButton').addEventListener('click', () => setDnd(!settings.dnd));
  $('simulateCue').addEventListener('click', simulateCueFlow);
  $('closeSettings').addEventListener('click', () => closePanel());
  $('closeAssist').addEventListener('click', finishEngagement);
  $('realtimeToggle').addEventListener('click', () => {
    if (realtimeActive || realtimeStarting) void stopRealtime('user_stop');
    else void startRealtime();
  });
  $('acceptNudge').addEventListener('click', acceptNudge);
  $('dismissNudge').addEventListener('click', dismissNudge);
  $('messageForm').addEventListener('submit', (event) => { event.preventDefault(); void sendMessage($('messageInput').value); });
  $('dndToggle').addEventListener('change', (event) => setDnd(event.target.checked));
  $('presentationToggle').addEventListener('change', (event) => setPresentation(event.target.checked));
  $('voiceToggle').addEventListener('change', (event) => {
    settings.voice = event.target.checked;
    if (!settings.voice) {
      cancelSpeech();
      realtimePlayback?.clear();
    }
    void persistPreferences();
    render();
  });
  $('captionToggle').addEventListener('change', (event) => { settings.captions = event.target.checked; if (!settings.captions) showCaption(''); void persistPreferences(); render(); });
  $('openAtLoginToggle').addEventListener('change', (event) => { settings.openAtLogin = event.target.checked; void persistPreferences(); render(); });
  for (const control of document.querySelectorAll('input[name="activeLevel"]')) control.addEventListener('change', (event) => setActiveLevel(event.target.value));
  for (const [kind, control] of Object.entries(inputControls)) control.addEventListener('change', (event) => void setInput(kind, event.target.checked));
  $('screenSource').addEventListener('change', (event) => {
    selectedSourceName = event.target.selectedOptions[0]?.textContent || '';
    if (streams.has('screen')) stopInput('screen');
    render();
  });
  $('profileSelect').addEventListener('change', (event) => {
    const id = event.target.value;
    void enqueueSettingsOperation(async () => {
      const result = await api.model.selectProfile(id);
      if (result?.ok && applyPersistedSettings(result.settings)) {
        connectionState = normalizeConnectionState(await api.model.connectionState());
        render();
        void refreshModelCapabilities(true);
      } else if (result?.ok === false) {
        showSettingsError(result);
        render();
      }
      return result;
    });
  });
  $('remoteRootInput').addEventListener('change', (event) => {
    const value = event.target.value.trim();
    void updateActiveProfile({ remoteRoot: value || null });
  });
  $('selectCredentials').addEventListener('click', () => { void chooseCredentials(); });
  $('reconnectModel').addEventListener('click', () => { void reconnectModel(); });

  $('contextSession').addEventListener('click', () => { closePanel({ restore: false }); toggleSession(); });
  $('contextPause').addEventListener('click', () => { closePanel({ restore: false }); stopAllInputs(); showToast('采集已暂停'); });
  $('contextDnd').addEventListener('click', () => { closePanel({ restore: false }); setDnd(!settings.dnd); });
  $('contextSettings').addEventListener('click', () => openSettings(pet));
  $('contextExit').addEventListener('click', () => api.app.quit());

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel === 'none') return;
    event.preventDefault();
    if (panel === 'nudge') dismissNudge();
    else if (panel === 'assist') finishEngagement();
    else closePanel();
  });

  document.addEventListener('keydown', () => { document.body.dataset.inputModality = 'keyboard'; }, true);
  document.addEventListener('pointerdown', () => { document.body.dataset.inputModality = 'pointer'; }, true);
  reducedMotion.addEventListener('change', render);

  const pet = $('pet');
  const petCharacter = $('pet-character');
  const petTail = $('pet-tail');
  const petPupils = [$('pet-pupil-left'), $('pet-pupil-right')];
  let drag = null;
  let moveFrame = 0;
  let pendingPoint = null;

  function activatePet() {
    api.window.focus();
    if (!sessionActive()) startSession();
    if (state.phase === PHASES.ACTIVE || state.phase === PHASES.COOLDOWN) {
      cancelScreenAnalysis({ clearObservations: false });
      state = transition(state, { type: 'ENGAGE' });
      clearObservationNote();
      setPanel('assist', pet);
      render();
      return;
    }
    if (state.phase === PHASES.ENGAGED) {
      setPanel('assist', pet);
      return;
    }
    if (state.phase !== PHASES.NUDGE) showToast('陪伴中 · 右键可打开控制');
  }

  pet.addEventListener('pointerdown', async (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    pet.setPointerCapture(event.pointerId);
    const pending = {
      pointerId: event.pointerId,
      bounds: null,
      startX: event.screenX,
      startY: event.screenY,
      moved: false,
      history: [{ x: event.screenX, y: event.screenY, t: performance.now() }]
    };
    drag = pending;
    const bounds = await api.window.beginDrag();
    if (drag !== pending || !pet.hasPointerCapture(event.pointerId) || !bounds) return;
    pending.bounds = bounds;
  });

  pet.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.screenX - drag.startX;
    const dy = event.screenY - drag.startY;
    if (Math.hypot(dx, dy) > 4 && !drag.moved) {
      drag.moved = true;
      draggingPet = true;
      syncPetState();
    }
    if (drag.moved) {
      const tilt = clamp(dx / 18, -6, 6);
      petCharacter.style.transform = `rotate(${tilt}deg) scale(.98, 1.02)`;
      petTail.style.transform = `rotate(${-tilt * 1.35}deg)`;
      const eyeOffset = clamp(dx / 40, -3, 3);
      petPupils.forEach((pupil) => { pupil.style.transform = `translateX(${eyeOffset}px)`; });
    }
    drag.history.push({ x: event.screenX, y: event.screenY, t: performance.now() });
    drag.history = drag.history.filter((item) => performance.now() - item.t < 120).slice(-6);
    if (!drag.bounds) return;
    pendingPoint = { x: drag.bounds.x + dx, y: drag.bounds.y + dy };
    if (!moveFrame) moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      if (pendingPoint) api.window.moveDrag(pendingPoint.x, pendingPoint.y);
    });
  });

  function endDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = drag;
    drag = null;
    draggingPet = false;
    petCharacter.style.removeProperty('transform');
    petTail.style.removeProperty('transform');
    petPupils.forEach((pupil) => { pupil.style.removeProperty('transform'); });
    syncPetState();
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    const finalPoint = pendingPoint;
    pendingPoint = null;
    const history = finished.history;
    const first = history[0];
    const last = history.at(-1);
    const seconds = Math.max(.016, (last.t - first.t) / 1000);
    if (finished.moved && finished.bounds) {
      if (finalPoint) api.window.moveDrag(finalPoint.x, finalPoint.y);
      api.window.endDrag((last.x - first.x) / seconds, (last.y - first.y) / seconds, reducedMotion.matches);
    } else if (!finished.moved) activatePet();
  }
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
  pet.addEventListener('click', (event) => event.preventDefault());
  pet.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activatePet(); }
  });
  pet.addEventListener('contextmenu', (event) => { event.preventDefault(); openContext(pet); });

  let clickThrough = null;
  document.addEventListener('mousemove', (event) => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const interactive = Boolean(target?.closest('.interactive'));
    if (clickThrough !== !interactive) {
      clickThrough = !interactive;
      api.window.setClickThrough(clickThrough);
    }
  });

  api.app.onCommand((command) => {
    if (command === 'toggle-session') toggleSession();
    if (command === 'pause-capture') { stopAllInputs(); showToast('采集已暂停'); }
    if (command === 'toggle-dnd') setDnd(!settings.dnd);
    if (command === 'open-settings') openSettings(pet);
    if (command.startsWith('set-active-level:')) setActiveLevel(command.split(':').at(-1));
  });
  api.realtime.onEvent(handleRealtimeEvent);
  api.capture.onShutdown(() => { cancelCapabilityRetry(); stopAllInputs(); });
  window.addEventListener('pagehide', () => { cancelCapabilityRetry(); stopAllInputs(); });
  window.addEventListener('beforeunload', () => { cancelCapabilityRetry(); stopAllInputs(); });

  function handleConnectionState(value) {
    const previous = connectionState.state;
    connectionState = normalizeConnectionState(value);
    if (!initialized) return;
    render();
    if (!api.runtime.fakeModel && previous !== connectionState.state
        && (connectionState.state === 'ready' || connectionState.state === 'idle' || connectionFailures.has(connectionState.state))) {
      void refreshModelCapabilities(true);
    }
  }

  async function hydrateSettings() {
    const [settingsResult, connectionResult] = await Promise.allSettled([
      api.settings.get(),
      api.model.connectionState()
    ]);
    if (settingsResult.status === 'fulfilled' && settingsResult.value?.ok) applyPersistedSettings(settingsResult.value.settings);
    if (connectionResult.status === 'fulfilled') connectionState = normalizeConnectionState(connectionResult.value);
  }

  if (api.runtime.testMode) {
    document.body.dataset.testMode = 'true';
    Object.defineProperty(window, '__floatingPetTest', {
      value: Object.freeze({
        getState: () => ({ ...state, panel, activeLevel: settings.activeLevel, mediaCalls, visualCaptureCalls, messages: structuredClone(messages), activeInputs: [...streams.keys()], realtimeActive, realtimeStarting, realtimeErrorCode, realtimeRequestId: realtimeGeneration, realtimePlaybackAccepted }),
        emitCue,
        advanceClock: (ms) => { fakeClockOffsetMs += Number(ms) || 0; },
        stopAllInputs,
        openSettings: () => openSettings(pet),
        setModelCapabilities: (value) => {
          modelCapabilities = normalizeCapabilities(value);
          applyCapabilityPresentation();
          render();
        }
      })
    });
  }

  async function initialize() {
    if (typeof api.model.onConnectionState === 'function') api.model.onConnectionState(handleConnectionState);
    await hydrateSettings();
    initialized = true;
    applyCapabilityPresentation();
    render();
    void refreshModelCapabilities(true);
    api.app.rendererReady({ mediaCallsBeforeStart: mediaCalls, activeInputs: [...streams.keys()], phase: state.phase });
  }

  void initialize();
})();
