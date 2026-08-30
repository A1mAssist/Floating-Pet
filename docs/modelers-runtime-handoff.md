# Modelers NPU 连接与服务快照

> 快照时间：2026-07-30 19:36:16 +08:00
> 用途：后续 Codex/开发人员恢复 Modelers Space、MiniCPM-o 服务及 HarmonyOS 真机联调。
> 安全：本文包含主机、端口、用户名和本地密钥路径，但不包含私钥、FRPS token 或 STCP secret。本文及所引用的凭据包不得公开。

## 1. 当前结论

截至快照时间，**Modelers 通过现有两条 SSH 链路均不可达**，因此无法读取远端 `/health`，也不能进一步判断 MiniCPM-o 服务进程是否在运行。

| 检查项 | 结果 | 证据 |
|---|---|---|
| VPS 跳板 SSH | 可达 | `ssh sms-panel-vps ...` 退出码为 0 |
| 跳板侧 `127.0.0.1:22222` | 未监听 | `ss -ltnH '( sport = :22222 )'` 无输出 |
| 全局别名 `modelers-npu` | 不可达 | `connect failed: Connection refused` |
| 私密 STCP 直连包 | 不可达 | `kex_exchange_identification: Connection reset` |
| Windows `127.0.0.1:18000` | 未监听 | 当前没有模型 SSH 端口转发 |
| 临时 visitor/frpc | 已清理 | 本地无 `frpc` 进程、无 `22222` listener |
| HDC reverse 规则 | 已清理 | `hdc fport ls` 返回 `[Empty]` |

这只能证明“访问链路不可达”，不能单独证明 Space 已关机。最常见原因依次是：Space 未运行、Space 内 FRPC/watchdog 未运行、STCP 注册失败，最后才是 sshd 本身异常。

## 2. 连接拓扑

### 推荐：私密 STCP 直连包

```text
Windows connect.ps1
  -> 临时 frpc STCP visitor
  -> Windows 127.0.0.1:22222
  -> FRPS
  -> Modelers Space FRPC
  -> Space 127.0.0.1:2222
  -> Space sshd (user: openmind)
```

凭据包位置：

```text
D:\Workspaces\MiniCPM-contest\outputs\modelers-npu-ssh-credentials
```

该目录包含私钥、固定 HostKey、FRP visitor 配置和官方 `frpc.exe`，已被视为私密目录。不要提交、压缩后公开或把文件内容粘贴到聊天中。

连接命令：

```powershell
Set-Location 'D:\Workspaces\MiniCPM-contest\outputs\modelers-npu-ssh-credentials'
pwsh -NoProfile -File .\connect.ps1
pwsh -NoProfile -File .\connect.ps1 'id -un; pwd'
```

`connect.ps1` 会启动临时 visitor、严格校验 Modelers HostKey，并在 SSH 退出后清理 visitor。同一台电脑不要并发运行两个 `connect.ps1`。

### 备用：VPS ProxyJump

当前 `C:\Users\A1mAssist\.ssh\config` 中的有效配置为：

```sshconfig
Host sms-panel-vps
    HostName 38.244.25.70
    User root
    Port 599
    IdentityFile ~/.ssh/sms-panel-vps
    IdentitiesOnly yes

Host modelers-npu
    HostName 127.0.0.1
    Port 22222
    User openmind
    ProxyJump sms-panel-vps
    IdentityFile C:\Users\A1mAssist\.ssh\id_rsa
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    UserKnownHostsFile C:\Users\A1mAssist\.ssh\known_hosts_modelers_local
```

这里的 `127.0.0.1:22222` 指跳板机视角的 loopback，不是 Windows 本机。该入口依赖跳板机上已有 visitor；当前它没有监听。

优先使用直连包，因为它使用固定 HostKey 和 `StrictHostKeyChecking yes`。全局别名的 `accept-new` 只适合作为恢复入口。

## 3. Space 端恢复检查

先从 Modelers 控制台确认 Space/Jupyter 已启动。随后在可信控制台检查：

```bash
state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp"
runtime_dir="$HOME/.modelers-frp-runtime"

id -un
ss -H -lnt 'sport = :2222'
cat "$runtime_dir/watchdog.pid"
cat "$runtime_dir/frpc.pid"
ps -fp "$(cat "$runtime_dir/watchdog.pid")"
ps -fp "$(cat "$runtime_dir/frpc.pid")"
tail -n 100 "$state_dir/watchdog.log"
tail -n 100 "$state_dir/frpc.log"
```

预期：

- 用户为 `openmind`。
- sshd 只监听 `127.0.0.1:2222`。
- 只有一个 watchdog 和一个 FRPC。
- FRPC 日志显示 STCP proxy 注册成功。

watchdog 默认每 300 秒检查 FRPC，每 6 次检查执行一次活动请求。恢复脚本与完整部署说明见 [modelers-space-ssh-workflow.md](./modelers-space-ssh-workflow.md)。

## 4. MiniCPM-o 服务

实现文件：

- [`service/start_minicpmo.sh`](../service/start_minicpmo.sh)：加载 CANN 环境并启动服务。
- [`service/minicpmo_server.py`](../service/minicpmo_server.py)：HTTP/WebSocket 服务。
- [`service/modelers_cmd.sh`](../service/modelers_cmd.sh)：Space 启动入口。
- [`service/modelers_frp_watchdog.sh`](../service/modelers_frp_watchdog.sh)：FRPC watchdog。

服务默认只监听 Space 的 `127.0.0.1:8000`。`chat` 与 `duplex` 模式互斥，切换后必须重启服务进程。

在远端仓库根目录启动：

```bash
# 回合制文本、JPEG、WAV
MINICPM_MODE=chat ./service/start_minicpmo.sh

# 实时音频/视频
MINICPM_MODE=duplex \
MINICPM_PROMPT_WAV=/workspace/prompt.wav \
./service/start_minicpmo.sh
```

关键环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MINICPM_MODE` | `chat` | `chat` 或 `duplex` |
| `MINICPM_MODEL_DIR` | 自动探测 | 优先 `~/volume/notebook/models/MiniCPMO45` |
| `MINICPM_SERVED_MODEL_NAME` | `cpmo` | API 模型名 |
| `MINICPM_PROMPT_WAV` | 空 | Duplex 参考语音 |
| `MINICPM_ATTN` | `eager` | TorchNPU 注意力实现 |
| `MINICPM_PORT` | `8000` | 远端 loopback 端口 |
| `MINICPM_FAKE_DUPLEX` | false | 仅供本地协议测试，不能作为真机验收 |

## 5. 服务协议

| 接口 | 模式 | 用途 |
|---|---|---|
| `GET /health` | 全部 | 服务状态和能力契约 |
| `GET /v1/models` | 全部 | 模型列表 |
| `POST /v1/chat/completions` | `chat` | 文本、JPEG、WAV 回合制推理 |
| `WS /v1/realtime?mode=audio` | `duplex` | 16 kHz 音频实时输入 |
| `WS /v1/realtime?mode=video` | `duplex` | 音频加 JPEG 视觉输入 |

`/health` 返回字段：

```json
{
  "status": "loading | ready | degraded",
  "model": "cpmo",
  "mode": "chat | duplex",
  "device": "npu:0",
  "loaded_at": null,
  "fake": false,
  "capabilities": {
    "chat_completions": false,
    "image_input": false,
    "audio_input_wav": false,
    "realtime": false,
    "audio_input_16k_f32": false,
    "video_jpeg": false,
    "audio_output_24k_f32": false
  },
  "error": null
}
```

能力字段必须以实际响应为准，不能根据 `mode` 猜测。加载期间为 `loading` 且能力全 false；模型加载失败或 backend 卡死时为 `degraded`。

Realtime 顺序：

```text
server: session.queue_done
client: session.init
server: session.created
client: input.append
server: response.output.delta (text | audio | listen, response_id=R)
server: response.done (response_id=R)
client: session.close
server: session.closed
```

媒体约束：

- 输入音频：base64、小端 float32、mono、16 kHz。
- 输出音频：base64、小端 float32、mono、24 kHz。
- `mode=video` 最多两张 JPEG，每张不超过 1 MiB。
- 当前服务一次只接受一个 Duplex 会话。
- Chat 与 Duplex 推理硬上限均由服务端控制；backend 卡死后服务会进入 `degraded/backend_stuck`，需重启恢复。

## 6. Windows 端口转发

SSH 恢复后，在独立终端保持：

```powershell
ssh -N -L 18000:127.0.0.1:8000 modelers-npu
```

如果使用私密直连包，应先保持 visitor，再用包内 `ssh_config` 建立转发：

```powershell
ssh -F .\ssh_config -N -L 18000:127.0.0.1:8000 modelers-npu
```

检查：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 18000
Invoke-RestMethod 'http://127.0.0.1:18000/health'
```

桌面客户端默认使用：

```text
HTTP: http://127.0.0.1:18000
WS:   ws://127.0.0.1:18000/v1/realtime
```

## 7. HarmonyOS 真机联调

Windows `18000` 已建立模型隧道后，再把设备 loopback 反向转到 Windows：

```powershell
$Hdc = 'D:\Tools\command-line-tools\sdk\default\openharmony\toolchains\hdc.exe'
& $Hdc -t '127.0.0.1:42320' rport 'tcp:18000' 'tcp:18000'
& $Hdc -t '127.0.0.1:42320' fport ls
```

真机原始 HTTP 探测：

```powershell
& $Hdc -t '127.0.0.1:42320' shell "printf 'GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' | toybox nc -w 5 127.0.0.1 18000"
```

移除规则时必须同时提供两端，单参数删除无效：

```powershell
& $Hdc -t '127.0.0.1:42320' fport rm 'tcp:18000' 'tcp:18000'
```

2026-07-30 已用临时 Windows HTTP 服务实测该链路，真机收到 `HTTP/1.0 200 OK`；测试服务和 reverse 规则均已清理。HDC reverse 只用于开发，发布版本应使用带认证的 HTTPS/WSS 服务入口。

当前 Harmony HAP 仍在 `harmony-bridge.js` 固定返回 `degraded`，所以恢复 Modelers 后还需接入 `/health`、Chat 和 Realtime 才能进行产品非降级验收。

## 8. 验收命令

在 `desktop` 目录执行：

```powershell
npm run test:unit
npm run test:integration
npm run test:real
npm run test:real:screen
npm run test:real:duplex
npm run test:real:duplex:continuous
npm run test:real:duplex:soak
```

真实测试前必须核对 `/health` 的 `status=ready`、`fake=false` 和目标 `mode`。测试如需切换远端模式，应记录原模式，完成后恢复并重新核验 `/health`。

历史 Ascend 910B2 实测（2026-07-22）：

- Duplex：`ready / duplex / npu:0 / fake=false`。
- 音频 prepare/首文字/首音频/关闭：`13.411s / 33.145s / 33.146s / 0.523s`。
- 视频 prepare/首文字/首音频/关闭：`4.507s / 8.841s / 8.842s / 0.511s`。
- 180 秒 soak：81 次 append，p50 `2.117s`，p95 `2.944s`，最大 `3.937s`。
- Chat：文本 `5.625s`、JPEG `49.255s`、WAV `86.990s`，`npm run test:real` 通过。

完整协议、超时和历史测试数据见 [`desktop/README.md`](../desktop/README.md)。

## 9. 快速故障定位

| 现象 | 优先检查 |
|---|---|
| `Connection refused` | visitor 是否监听 `22222`、Space FRPC 是否注册 |
| `Connection reset` | STCP 后端是否在线、secret/proxy 名是否匹配、Space sshd 是否监听 |
| SSH 正常但 `/health` 拒绝连接 | `start_minicpmo.sh` 进程和远端 `8000` listener |
| `/health` 为 `loading` | 等待后台模型加载，查看服务日志 |
| `/health` 为 `degraded` | 查看 `error.code`；`backend_stuck` 通常需重启服务 |
| Harmony 访问失败但 Windows 正常 | `hdc fport ls`、设备 `127.0.0.1:18000` 原始 HTTP 探测 |
| UI 仍显示降级 | Harmony bridge 尚未接协议，或 `/health` 能力字段为 false |

## 10. 安全边界

- 不输出或提交 `id_rsa`、`frpc_visitor.toml`、FRPS token、STCP secret。
- 不把远端 `8000` 或 Windows `18000` 直接暴露到公网。
- SSH 私钥只保留在本机，Space 只部署公钥。
- 优先使用固定 HostKey 的凭据包；HostKey 变化必须先从可信 Modelers 控制台核验。
- 不使用 `pkill`/`killall` 清理远端服务；按 PID 和可执行文件身份处理。
- 不同时启动多个 visitor；端口冲突时先确认进程归属。
