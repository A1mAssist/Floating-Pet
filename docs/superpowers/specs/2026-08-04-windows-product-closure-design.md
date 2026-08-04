# Windows Product Closure Design

## Goal

把 Floating Pet 收口为一套可在 Windows 上日常使用的桌宠闭环：用户可以随时主动进入对话，主动提示不会伪造具体问题，模型连接不绑定某一台比赛机器，重启后安全偏好和位置保持，远端机器暂时不可用时桌宠仍能启动并明确降级。

本轮默认目标是当前 Windows 开发机和比赛提供的 SSH 机器。产品不承诺唤醒已经关机或被平台控制面拒绝的远端 Space。

## Scope

### Included

- 用户主动进入文字协助卡。
- 使用经过校验的屏幕观察摘要，不再注入固定的 `task.steps` 演示上下文。
- 可切换的远端连接配置，至少支持 SSH 转发和直接 HTTP/WSS 两种传输。
- Electron 主进程内的 Node supervisor，直接管理 `frpc.exe` 和系统 `ssh.exe`。
- 远端 Chat 服务的幂等健康检查和可选启动。
- 原子持久化的窗口位置、安全偏好和连接配置元数据。
- 默认关闭的 Windows 登录启动开关。
- 本地隧道退出时清理，远端模型服务保留。

### Excluded

- PowerShell 作为产品启动依赖。现有 PowerShell 连接脚本只保留给人工诊断。
- 私钥、Bearer token 或 FRP secret 的复制、上传或写入产品配置。
- 自动唤醒 Modelers/HidevLab Space、修改远端 ACL 或猜测未知进程的 PID。
- Chat 与 Duplex 两个 9B 后端的同时驻留和热切换。
- 专注计时、笔记、检查清单和记忆管理；这些属于后续产品范围，不阻塞正常桌宠闭环。

## Chosen Architecture

### Main process ownership

Electron Main owns all network and child-process operations. Renderer receives only bounded status and user-safe error codes through the existing narrow preload bridge.

The product supervisor is implemented with Node's standard `child_process` and `net` APIs:

- Spawn the profile's `frpc.exe` as a hidden child.
- Spawn the system OpenSSH client with an argument array, never a local shell command string.
- Run the optional remote service start command through a fixed template and a validated POSIX remote root.
- Probe the configured local HTTP health endpoint with `fetch`.
- Stop only the local SSH and FRP children when the desktop app exits.

The existing credential package remains external. The app stores its directory path, not its contents. The package's SSH config and fixed HostKey remain the trust boundary.

### Connection profiles

Profiles are stored in the user data JSON file and selected from the settings panel. A profile contains:

```json
{
  "id": "competition-a",
  "label": "比赛机器 A",
  "transport": "ssh",
  "credentialDir": "C:\\private\\credentials",
  "sshConfig": "ssh_config",
  "sshTarget": "modelers-npu",
  "localPort": 18000,
  "remoteHost": "127.0.0.1",
  "remotePort": 8000,
  "httpBase": "http://127.0.0.1:18000",
  "realtimeUrl": "ws://127.0.0.1:18000/v1/realtime",
  "remoteRoot": null,
  "desiredMode": "chat"
}
```

The example is a schema shape, not a shipped credential or host. `transport: direct` skips SSH and uses the configured HTTP/WSS endpoints. `remoteRoot` is optional; without it, the supervisor checks an already-running service but does not execute a remote start command. No arbitrary shell text is exposed in the profile editor.

### Startup data flow

```text
app ready
  -> load and validate user config
  -> restore safe window bounds
  -> create window and tray
  -> start supervisor for the selected profile
  -> start FRP and SSH forward when transport=ssh
  -> probe /health
  -> if no ready chat service and remoteRoot is configured, run fixed chat start template
  -> wait for ready/chat/fake=false
  -> publish connection status and model capabilities
```

The supervisor makes one bounded startup attempt. A failed attempt leaves the renderer usable in offline mode. The settings action `重新连接` starts a new attempt; capability polling never spawns unbounded child processes.

## Interaction Changes

### Explicit user engagement

Add an `ENGAGE` transition to the existing reducer:

- IDLE click: `START`, then `ENGAGE`, and open the assist card.
- ACTIVE or COOLDOWN click: `ENGAGE` and open the assist card.
- ENGAGED click: focus/reopen the assist card.
- NUDGE click: leave the nudge pending; only its accept button changes state to ENGAGED.

User-initiated text remains available in DND and presentation mode. Those modes continue to suppress proactive speech, proactive bubbles and realtime capture.

### Grounded proactive assistance

`analyzeScreen` already returns a bounded `summary`. Store the latest accepted observation in renderer memory and use that summary in the nudge and assist card. The summary is displayed as an observation, never as a diagnosis or an instruction.

Accepting a nudge opens the card with a neutral prompt and focuses the input. It does not create a synthetic user message or send another frame without a new user action. The next user message reuses the existing capability-gated screen/audio capture path.

Fake and offline replies must be generic and explicitly labeled as degraded. They must not mention `task.steps`, `map`, or any other fixture-specific fact.

## Persistence and Login Startup

Use one versioned JSON file under `app.getPath('userData')`. Writes use a temporary file followed by an atomic rename. Reads validate every field and fall back to defaults on malformed or out-of-range values.

Persist:

- window position;
- active level, voice and captions;
- login-start preference, default `false`;
- active profile and non-secret profile metadata, including credential directory and remote root paths.

Do not persist or restore:

- session phase or conversation messages;
- DND or presentation mode;
- microphone, camera or screen enabled state;
- screen source selection or media buffers;
- private keys, tokens or raw media.

Use Electron's `app.setLoginItemSettings` for the packaged application. In development and test mode, the preference is stored and exposed for verification but does not register a development executable as a login item.

Window bounds are clamped to the current display work area before window creation. A failed display lookup uses the existing lower-right default.

## Connection State and Errors

The supervisor exposes only these stable states:

`idle`, `starting`, `forwarding`, `probing`, `ready`, `credentials_missing`, `ssh_unavailable`, `connection_refused`, `connection_reset`, `remote_start_failed`, `health_timeout`, `mode_mismatch`, `stopped`.

Each child process and health phase has a bounded timeout. Error details shown in the UI contain no key, token, full command line or remote response body. Local diagnostic logs are written under the user data directory with bounded line lengths.

If health reports a running non-chat mode while the profile requests Chat, the supervisor reports `mode_mismatch` and does not terminate an unknown remote process. If the supervisor dies unexpectedly, the Main process reports offline and allows one explicit restart. Remote service processes are never stopped by normal desktop exit.

## Testing and Acceptance

### Automated

- Core unit tests cover IDLE/ACTIVE/COOLDOWN engagement and observation-summary rendering data.
- Model-client tests cover generic fake/offline replies and profile/health normalization.
- Electron E2E covers direct click-to-chat, nudge summaries without fixture text, safe preference restoration, no media restoration, and reconnect UI.
- Node supervisor tests use fake `frpc` and `ssh` executables plus a local HTTP stub to cover success, missing credentials, refused/reset connections, health timeout, mode mismatch and child exit.
- Existing syntax, unit, E2E, service, integration and package verification gates remain required.

### Real acceptance

For each configured competition profile, when the machine is reachable:

1. Establish the SSH connection without exposing credentials.
2. Start or detect the remote Chat service and observe `/health=ready`, `mode=chat`, `fake=false`.
3. Send text through the desktop UI and receive a remote response.
4. Quit and relaunch the desktop app; verify the remote service remains running and only the local tunnel is recreated.
5. Stop the remote service or make the machine unreachable; verify the desktop starts in offline mode without hanging.

Real acceptance remains externally blocked while the provided Modelers and HidevLab machines reject SSH. That is an environment status, not a reason to weaken local failure handling.

## Rollout Order

1. Add validated config and window/preference persistence.
2. Add reducer and renderer direct engagement plus grounded nudge text.
3. Add Node supervisor and profile health IPC.
4. Add settings/tray reconnect and login-start controls.
5. Add fake supervisor tests, rebuild the current package, and run all local gates.
6. Run real acceptance for each reachable competition profile.
