# Floating Pet MiniCPM-o Local Duplex Preview

Windows 桌面悬浮宠物。当前源码同时支持回合制多模态请求和显式开启的音频/视频实时对话；Renderer 不直接联网，HTTP 与 WebSocket 都由 Electron 主进程持有。模型不可达时，桌宠仍可启动并提供明确标记的本机离线回应。

## 已实现

- 透明、置顶、单实例桌宠窗口与系统托盘
- Pointer Events 拖拽、速度传递和桌面边缘吸附
- 麦克风、摄像头、屏幕来源独立开启与停止
- 临时协助卡、字幕、系统语音和 MiniCPM-o 文本/单帧视觉/短 WAV 请求
- 协助卡内显式“实时对话”：约 1 秒一块的 16 kHz 麦克风 PCM、可选 JPEG 视觉帧、增量文字和 24 kHz 服务端 PCM 播放；音频与视频模式均已在 Ascend 910B2 上验证模型语音
- 当前 Ascend 上游按块串行执行 `streaming_prefill -> streaming_generate`。桌面以 FIFO 按序保留最多 30 个约 1 秒的输入块（含正在发送块），发送并发恒为 1；第 31 块触发 `audio_input_overflow`，清零待发 PCM 并停止会话。已接受的块在该边界内不会被覆盖，但这不代表无限无损缓冲或并发 NPU 推理
- 离开协助卡、结束会话、停止麦克风、开启勿扰/演示模式或 Renderer 退出时停止实时采集和连接
- Main/Preload 的窄 Realtime IPC，严格事件/大小校验、超时、取消和 WebSocket 背压失败
- 启动与重连时读取 `/health` 能力契约，只开放当前 `chat` 或 `duplex` 服务真实声明的入口
- `chat` 模式下可对用户已开启的屏幕源做低频单帧分析；只有远端返回严格受限的重复错误/重复尝试 JSON，且两次同键观察满足策略间隔后，才显示主动提示
- `chat` 的 JPEG/WAV 与 `duplex` 的 16 kHz PCM/JPEG/24 kHz PCM 分别声明；桌面只采集服务明确支持的媒体
- `start:fake` 使用桌面进程内 Fake Adapter/Fake Realtime；`MINICPM_FAKE_DUPLEX=1` 使用独立 Python 协议 Stub，界面分别标为 `Fake` 与 `Stub`
- `MINICPM_MODE=chat|duplex` 单后端服务，避免同时驻留两份 9B 模型

## 运行要求

- 桌面端：Windows 11 x64、Node.js 24、npm 11
- Ascend 服务：Linux 容器、CANN、匹配的 PyTorch/TorchNPU，以及目标模型 `FlagRelease/MiniCPM-o-4.5-ascend-FlagOS`
- 首次开启麦克风、摄像头或屏幕时，由系统和应用分别处理权限

本次真机使用 ModelScope `master` revision `41f8c801f86ac887290ae2d3b20c4f72b2efa1b2`，模型目录 SHA-256 为 `099e322a7801e676e3cbb1ccb782a8dc211c7a1ecefc402c053bf9c746f3c702`；此前 HuggingFace 证据对应 revision `60f1ded7a096349f5a44d36ad2f04068b457df24`，两者不可混写。`service/requirements.txt` 按成功环境固定 `token2wav-cosyvoice-stepaudio2==0.1.3` 与 `s3tokenizer==0.3.0`；前者直接提供模型导入的 `stepaudio2` 模块，当前环境没有另装 `token2wav-cosyvoice` 或旧的 `stepaudio2-minicpmo` distribution。

## 桌面端运行

```
cd desktop
npm ci
npm start
```

默认连接回合制 `http://127.0.0.1:18000` 和实时 `ws://127.0.0.1:18000/v1/realtime`。完全离线的桌面演示使用：

```
npm run start:fake
```

不申请麦克风、摄像头或屏幕权限，并自动演示“重复线索 → 主动询问”的 Windows Mock 使用：

```bash
npm run start:demo
```

左键或聚焦桌宠后按 Enter 开始陪伴，右键打开控制菜单。媒体输入默认关闭；先在“陪伴设置”中开启麦克风，再进入协助卡点击“实时对话”。仅开启麦克风时使用 `mode=audio`；摄像头或屏幕可用时使用 `mode=video`，服务适配层会把音频加视觉输入映射到目标模型的 `mode=omni`。

### 模型连接配置

设置面板中的连接配置保存在应用用户数据目录的 `config.json`，只保存经过校验的非秘密元数据。配置形状如下，示例值不是实际凭据：

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

`transport: direct` 直接使用 `httpBase` 与 `realtimeUrl`，不启动 SSH/FRP。`transport: ssh` 只在本机启动受控的 `ssh.exe` 和可选 `frpc.exe`；`credentialDir` 只保存目录路径，私钥、token 和原始媒体不会写入配置。`remoteRoot` 可选；为空时只检查已运行的远端服务，不执行远端启动命令。退出桌宠会清理本机转发进程，但不会停止远端模型服务。

连接状态只使用以下稳定标签：`idle`、`starting`、`forwarding`、`probing`、`ready`、`credentials_missing`、`ssh_unavailable`、`connection_refused`、`connection_reset`、`remote_start_failed`、`health_timeout`、`mode_mismatch`、`stopped`。设置中的“重新连接”只重试当前 profile；失败时协助卡仍可打开，文字回退为本机离线回应。

“登录时启动”默认关闭，只有打包后的 Windows 应用才调用系统登录项 API；开发和测试运行只保存偏好，不注册开发进程。

桌面端环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `FLOATING_PET_MODEL_URL` | `http://127.0.0.1:18000` | 回合制服务根地址 |
| `FLOATING_PET_MODEL_NAME` | `cpmo` | 回合制模型名 |
| `FLOATING_PET_MODEL_TOKEN` | 空 | 可选 HTTP Bearer Token |
| `FLOATING_PET_MODEL_TIMEOUT_MS` | `120000` | 回合制请求超时；覆盖已测 86.990 秒 WAV 推理 |
| `FLOATING_PET_REALTIME_URL` | `ws://127.0.0.1:18000/v1/realtime` | 实时 WebSocket 地址 |
| `FLOATING_PET_REALTIME_TIMEOUT_MS` | `35000` | 实时排队与后端 prepare 各自的超时窗口；服务端 prepare 硬上限为 30 秒 |
| `FLOATING_PET_REALTIME_OUTPUT_TIMEOUT_MS` | `130000` | 每次 `input.append` 等待匹配 `response.done` 的窗口；服务端推理硬上限为 120 秒 |

## Ascend 服务

在仓库根目录运行 `service/start_minicpmo.sh`。它会在 Ascend Linux 容器中加载 CANN 环境并仅监听 `127.0.0.1`；两种模式互斥，修改模式后需重启进程：

```bash
# 在镜像已提供匹配 TorchNPU 的前提下补齐服务依赖
/workspace/minicpmo45-venv/bin/python -m pip install -r service/requirements.txt

# 回合制：/v1/chat/completions
MINICPM_MODE=chat ./service/start_minicpmo.sh

# 有界实时流式：/v1/realtime?mode=audio|video
MINICPM_MODE=duplex \
MINICPM_PROMPT_WAV=/workspace/prompt.wav \
./service/start_minicpmo.sh
```

服务默认监听远端 `127.0.0.1:8000`，桌面默认连接本机 `18000`。需要手动验证隧道时，建立端口转发：

```
ssh -N -L 18000:127.0.0.1:8000 USER@ASCEND_HOST
```

若端口转发不是 `18000`，同时修改 `FLOATING_PET_MODEL_URL` 和 `FLOATING_PET_REALTIME_URL`，两条路径必须指向同一个服务进程。

服务端环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MINICPM_MODE` | `chat` | 选择 `chat` 或 `duplex` |
| `MINICPM_MODEL_DIR` | 自动探测 | 优先 `~/volume/notebook/models/MiniCPMO45`，再尝试 `/workspace/user_data/models/MiniCPMO45` |
| `MINICPM_SERVED_MODEL_NAME` | `cpmo` | API 模型名 |
| `MINICPM_PROMPT_WAV` | 空 | Duplex 模型语音所需参考 WAV |
| `MINICPM_ATTN` | `eager` | 模型注意力实现；TorchNPU 默认使用 `eager` |
| `MINICPM_PORT` | `8000` | Uvicorn 监听端口 |
| `MINICPM_FAKE_DUPLEX` | false | 仅供本地协议测试的确定性服务 Stub |
| `MINICPM_PYTHON` | 自动探测 | 依次尝试 `/workspace/minicpmo45-venv`、`~/volume/notebook/minicpmo45-venv` 和镜像 Python |

`chat` 模式只激活 `/v1/chat/completions`，并分别声明 `image_input` 与 `audio_input_wav`；`duplex` 模式只激活 `/v1/realtime`，并声明 `audio_input_16k_f32`、`video_jpeg` 与 `audio_output_24k_f32`，此时协助卡里的键盘文字使用明确标记的本机离线回应。生产服务在后台线程加载模型：Uvicorn 启动后 `/health` 立即可达，加载期返回 `loading` 且能力全为 false，完成后转为 `ready` 或 `degraded`。`MINICPM_FAKE_DUPLEX=1` 只用于本地协议测试；其 `health.fake` 会映射为“测试模型服务”和 `Stub` 徽标，不会显示成 `Ascend`，也不是桌面进程内 Fake。`MINICPM_PROMPT_WAV` 缺失或真实 Duplex loader 失败时，健康状态明确为 `degraded`，不会伪装成功。

Prompt WAV 在加载模型前即校验：文件最多 `24 MiB`，必须是 RIFF 声明长度一致的未压缩 PCM WAV、mono/stereo、16/32-bit、`16–96 kHz`、不超过 30 秒且帧数据完整。读取本身有上限，损坏 RIFF 或超大 metadata 也会进入明确的 `degraded` 状态。

## Realtime 协议

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

- URL：`/v1/realtime?mode=audio|video`
- 输入音频：base64、小端 float32、mono、16 kHz
- 可选视频：仅 `mode=video` 接受最多两张、每张最多 `1 MiB` 的 base64 JPEG；`mode=audio` 携带视觉帧会按协议错误关闭
- 输出音频：base64、小端 float32、mono、24 kHz
- 当前服务每次只接受一个 Duplex 会话
- 同一响应的全部 delta 必须携带相同的非空 `response_id`；客户端仅在匹配的 `response.done` 到达后完成该次 `append()`，缺失、错配、跨响应 delta 或旧 done 均按协议错误关闭

停止事件会立即停止前端采集、播放与待发送工作，并调用 `MiniCPMODuplex.set_session_stop()`；客户端最多等待 10 秒完成关闭握手，backend 的一次 `stop()` 调用最多等待 8 秒。已经进入 TorchNPU 的单个 kernel 仍可能在返回后才完全结束，因此这里不承诺硬中断正在执行的 NPU kernel。

收到停止后，正在运行的 `prepare/process` 仍独占实时锁并排空到各自原始 30/120 秒硬期限；正常返回后服务再次调用 `stop()` 清理迟到状态，才允许下一会话。任一 stop 失败/超时、worker 异常、handler 在排空期取消或原硬期限耗尽，都会把 Duplex backend 隔离为 `degraded/backend_stuck`；首次 stop 已超时时不会重试。Chat 同样串行准入，服务端推理上限为 120 秒；超时、取消或模型异常后进入 `degraded/backend_stuck`，重启前拒绝后续请求。

## 验证

```
npm run check
npm run test:unit
npm run test:e2e
npm run test:service
npm run test:integration
```

真实 Duplex 需先建立 SSH 隧道并提供 16 kHz float32 PCM 与 JPEG fixture：

```powershell
$env:FLOATING_PET_REALTIME_URL='ws://127.0.0.1:18000/v1/realtime'
$env:FLOATING_PET_REALTIME_PCM='PATH_TO_16K_F32LE_PCM'
$env:FLOATING_PET_REALTIME_JPEG='PATH_TO_JPEG'
$env:FLOATING_PET_REALTIME_TIMEOUT_MS='60000'
$env:FLOATING_PET_REALTIME_OUTPUT_TIMEOUT_MS='130000'
npm run test:real:duplex
npm run test:real:duplex:continuous
$env:FLOATING_PET_SOAK_SECONDS='180'
$env:FLOATING_PET_RECONNECTS='3'
npm run test:real:duplex:soak

# 需先把远端服务切换到 ready/chat；使用生产 analyzeScreen() 路径
$env:FLOATING_PET_MODEL_URL='http://127.0.0.1:18000'
npm run test:real:screen
```

2026-08-04 本地结果：

- `check`：PASS
- `test:unit`：89/89 PASS，包含配置持久化与 Node 模型监督器
- `test:e2e`：5/5 PASS（Fake Adapter、设置重启恢复、Fake Realtime 音频/视觉、HTTP Stub 屏幕观察、chat 媒体能力门禁）
- `test:service`：41/41 PASS
- `test:integration`：1/1 PASS，真实 Node `RealtimeClient` 连接自动启动的 Python Uvicorn Duplex Stub，覆盖 `mode=audio` 与 `mode=video`
- `package` / `verify:package`：NSIS、Portable、ZIP 均生成并通过源码 hash、包内容和生产启动 smoke

2026-07-22 Ascend 910B2 真机结果：`/health` 为 `ready / duplex / npu:0 / fake=false`。真实音频会话的 prepare/首文字/首音频/关闭分别为 `13.411s / 33.145s / 33.146s / 0.523s`，输出 `96,000` 字节非静音 24 kHz PCM，峰值 `0.8087769`；真实视频会话分别为 `4.507s / 8.841s / 8.842s / 0.511s`，输出 `96,000` 字节，峰值 `0.1311340`。客户端收到正常中文 `你好，屏幕` 与 `屏幕上的颜色`。

同一服务上的 FIFO 连续输入验收也通过：以 1 Hz 推送 10 个带唯一标记的音频块，全部接受并按 `1..10` 顺序发送，最大并发发送为 1，总耗时 `26.669s`；服务日志无 `input_backlog` 或 `backend_stuck`。默认队列最多保留 30 个约 1 秒块（含正在发送块），第 31 块会明确停止会话，不会静默覆盖旧输入。

180 秒真实 Duplex soak 通过：完成 `81` 次 append，延迟 p50 `2.117s`、p95 `2.944s`、最大 `3.937s`；并发客户端正确收到 `session_busy`，随后 3 次顺序重连全部完成 prepare、append 和干净关闭。恢复后的 Duplex 进程又通过 10 秒短冒烟：3 次 append，p50 `3.353s`、p95/最大 `4.506s`，并发拒绝和 1 次重连均正常。

回合制真机同样通过：`/health` 为 `ready / chat / npu:0 / fake=false`；文本 `5.625s`、JPEG `49.255s`、WAV `86.990s`，`npm run test:real` PASS。生产 `analyzeScreen()` 路径的真实模型验收也通过：正常页面返回 `null`（`32.587s`），同一重复报错页面两次返回稳定相同事件键（`6.425s / 5.489s`），重复尝试页面返回 `repeated_attempt`（`7.611s`），两次报错观察经策略得到 `two_observations`。Electron 自动调度仍由 HTTP Stub E2E 覆盖，真实模型结果只证明这组确定性样本，不代表任意用户屏幕的总体误报率。

## 打包边界

`release/` 中的 `0.1.0` NSIS、Portable EXE 和 ZIP 已由当前源码重新生成。复现命令：

```
npm run package
npm run verify:package
```

`verify:package` 会校验必需运行时模块、Renderer 资源和源码 hash，拒绝包含测试/脚本的包，并分别启动 `win-unpacked` 与 Portable 产物检查零媒体、零输入、IDLE、透明置顶和不抢焦点。源码变化后旧包会被判为过期。当前预览包未配置 Windows 代码签名证书，系统属性显示 `NotSigned`。

原始音视频和连续屏幕帧不落盘；停止陪伴、暂停采集或退出时会停止已开启的媒体轨道。手动回合制仅在发送消息时提交当前文字、单帧和短音频；开启屏幕、主动程度非安静且未启用勿扰/演示模式时，`chat` 模式会低频提交所选画面的当前单帧用于重复问题检测；实时模式仅在用户点击“实时对话”后持续发送，并在离开协助卡时停止。
