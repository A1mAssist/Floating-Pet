# Modelers FRPC 直连与运行保活设计

## 目标

只在 Modelers Space 内部署客户端组件，实现：

- Space 内的 `frpc` 把 `127.0.0.1:2222` 注册为 STCP 代理。
- 客户端临时启动 FRP visitor，在本机 `127.0.0.1:22222` 提供 SSH 入口，不依赖 `sms-panel-vps` 或 FRPS 公网数据端口。
- 每 5 分钟检查一次 `frpc`；进程死亡时自动重启。
- 每 30 分钟请求一次 Modelers 公网入口，尝试刷新平台的闲置计时。
- FRPS 凭据和 Modelers 公网 URL 尚未提供时，安装与 watchdog 可以先完成，连接任务保持等待。

## 约束

- Space 为 openEuler 24.03、`aarch64`、非 root 用户。
- 无 `cron`、`crond` 和 systemd 用户服务。
- 有 `curl`、`tar`、`pgrep`、`flock`、`nohup` 和 `sha256sum`。
- 持久目录为 `$HOME/volume/notebook`；完整重启会终止当前后台进程。
- 当前阶段不修改 VPS、`sms-panel-vps` 或现有 VPS 反向隧道。

## 目录

持久文件：

```text
$HOME/volume/notebook/.modelers-frp/
  bin/frpc
  frpc.toml
  modelers-public-url.txt
  watchdog.sh
  watchdog.log
  frpc.log
```

运行时文件：

```text
$HOME/.modelers-frp-runtime/
  frpc.toml
  frpc.pid
  watchdog.pid
```

私密配置从持久目录复制到 runtime 后强制设为 `0600`，`frpc` 只读取 runtime 副本。

## FRPC 配置

收到凭据后生成 TOML：

```toml
serverAddr = "FRPS_HOST"
serverPort = FRPS_PORT

auth.method = "token"
auth.token = "FRPS_TOKEN"

transport.tls.enable = true

[[proxies]]
name = "modelers-space-4982b68b-ssh"
type = "stcp"
secretKey = "STCP_SECRET"
localIP = "127.0.0.1"
localPort = 2222
```

`STCP_SECRET` 使用本机密码学随机数生成器生成。客户端 visitor 使用相同的 FRPS 地址、认证 token、代理名和 STCP secret；FRPS 无需开放额外 remotePort。

## Watchdog

使用一个 `nohup` shell 进程，不引入 cron 或进程管理器。

每 300 秒执行一次：

1. 使用 PID 文件、`/proc/<pid>/exe` 和命令行核对当前 `frpc` 是否属于本实例。
2. `frpc.toml` 不存在或仍含占位符时只记录等待状态。
3. 配置存在时先运行 `frpc verify -c`；校验失败不启动。
4. 进程不存在时复制 runtime 配置、收紧权限并启动 `frpc`。
5. 日志超过 5 MiB 时保留一份 `.1` 后轮换，避免持久卷无限增长。

每第 6 次循环额外执行一次 Space 保活：

1. 从 `modelers-public-url.txt` 读取单行 HTTPS URL，并请求 Modelers 平台入口。
2. 从 PID 1 的参数瞬时读取 Jupyter token 与 base URL，通过 stdin 传给 curl，请求本机 `/api/status`。
3. 分别记录公网和本地 HTTP 状态；不把 URL 查询参数或 token 写入日志。

公网入口当前在无浏览器登录态时返回 `403`；本地 Jupyter 请求返回 `200` 并刷新服务活动。平台是否据此延长 24 小时运行期仍需跨越闲置窗口验证。

## 启动和停止

- 启动命令通过 `flock` 保证只存在一个 watchdog。
- 重复执行启动命令只复用已有健康实例。
- 停止时只终止经 PID 和进程身份核验的 watchdog/frpc，不使用 `pkill frpc`。
- `service/modelers_cmd.sh` 在 Jupyter `exec` 前幂等启动 watchdog；该源版本发布到 Modelers 启动入口后，完整重启会自动恢复 FRPC。

## 连接包

FRPC 建立成功后重新生成本地凭据目录，只包含：

- Modelers SSH 私钥和公钥。
- Modelers sshd HostKey 记录。
- 官方 FRP v0.70.0 Windows AMD64 `frpc.exe` 与私密 visitor 配置。
- 指向本机 `127.0.0.1:22222` 的独立 SSH 配置。
- 自动启动、等待并停止 visitor 的一键连接脚本。

不包含 `sms-panel-vps` 私钥、公钥、HostKey、IP 或 SSH 配置。

## 验证

部署验收：

1. 官方 ARM64 `frpc` 压缩包的 SHA256 与发布清单一致。
2. `frpc verify -c` 通过。
3. `frpc` PID、可执行文件和配置路径匹配。
4. FRPC 日志显示代理启动成功。
5. `connect.ps1` 自动启动 STCP visitor，并在不加载 `sms-panel-vps` 配置时得到 `openmind` 与 `/home/openmind`。
6. 手动终止 `frpc`，5 分钟内由 watchdog 恢复。
7. 每 30 分钟记录公网入口状态和本地 Jupyter `200` 活动请求。
8. 导出目录全文扫描不包含 `sms-panel-vps` 相关内容。

平台是否把本地 Jupyter 活动计入 24 小时闲置规则，最终仍需跨越一次完整窗口验证。
