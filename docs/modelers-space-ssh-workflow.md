# Modelers Space FRP STCP SSH Workflow

> 目标：当 Modelers Space 没有公开 SSH 入口、只能提交启动脚本或使用文件区时，通过 FRP STCP 建立私有 SSH、SCP、VS Code Remote SSH 和端口转发入口。

本文使用一条连接链路：

```text
Windows OpenSSH
  -> 127.0.0.1:22222
  -> 临时 FRP STCP visitor
  -> FRPS
  -> Space 内 FRPC
  -> Space 127.0.0.1:2222
  -> OpenSSH sshd
```

FRPS 不为 Space 分配公开数据端口。Space 的 sshd 只监听 loopback；客户端每次连接时才启动 visitor，SSH 退出后 visitor 随即停止。

## 1. 组件与安全边界

| 组件 | 运行位置 | 职责 |
|---|---|---|
| `sshd` | Modelers Space | 在 `127.0.0.1:2222` 接受指定公钥 |
| `frpc` | Modelers Space | 注册 STCP 服务并转发到 sshd |
| `frps` | 自有服务器 | 认证 FRP 客户端并撮合 STCP visitor |
| `frpc` visitor | 开发电脑 | 临时监听 `127.0.0.1:22222` |
| `ssh.exe` | 开发电脑 | 校验 Space HostKey 并登录 |

安全约束：

- sshd 不监听公网或容器网卡，只监听 `127.0.0.1`。
- SSH 仅允许公钥认证，关闭密码、键盘交互、root、X11 和 agent forwarding。
- STCP proxy 和 visitor 使用独立随机 `STCP_SECRET`。
- FRP 控制连接启用 TLS，并使用 FRPS token 认证。
- FRP 配置、SSH 私钥和 HostKey 记录不提交 Git。
- watchdog 只通过 PID、可执行文件路径和配置参数管理属于本实例的进程。
- 不使用宽泛的 `pkill` 或 `killall`。

## 2. 占位符

| 名称 | 含义 |
|---|---|
| `FRPS_HOST` | FRPS 可访问主机名或 IP |
| `FRPS_PORT` | FRPS bind port |
| `FRPS_TOKEN` | FRPS 认证 token |
| `STCP_SECRET` | 此 Space 专用 STCP secret |
| `PROXY_NAME` | 此 Space 唯一 proxy 名称 |
| `SPACE_USER` | Space 用户，当前镜像通常为 `openmind` |
| `NOTEBOOK_DIR` | 持久目录，当前镜像通常为 `$HOME/volume/notebook` |

每个 Space 必须使用不同的 `PROXY_NAME` 和 `STCP_SECRET`。

## 3. 前置条件

Space 镜像需要：

```text
/usr/bin/bash
/usr/bin/curl
/usr/bin/flock
/usr/bin/ssh-keygen
/usr/sbin/sshd
sha256sum
tar
```

开发电脑需要 PowerShell 7、Windows OpenSSH Client，以及与 Space/FRPS 版本匹配的官方 Windows `frpc.exe`。

确认 Space 是非 root 用户：

```bash
id -u
uname -m
```

当前实现面向 `aarch64` Space。平台启动入口末尾必须继续以前台方式运行 Jupyter，否则 Space 会被判定为启动失败。

## 4. 生成客户端 SSH 密钥

在开发电脑执行：

```powershell
$SshDir = Join-Path $HOME '.ssh'
$SpaceKey = Join-Path $SshDir 'modelers_space_ed25519'
New-Item -ItemType Directory -Force -Path $SshDir | Out-Null
ssh-keygen -t ed25519 -a 64 -f $SpaceKey -C 'modelers-space-client'
Get-Content -LiteralPath "$SpaceKey.pub"
```

只把公钥写入 Space 启动脚本的授权文件。私钥留在开发电脑。

当前项目的 [`service/modelers_cmd.sh`](../service/modelers_cmd.sh) 会：

1. 创建权限为 `0700` 的 SSH state/runtime 目录。
2. 写入单独的 `modelers_authorized_keys`。
3. 生成 runtime sshd HostKey。
4. 生成并校验只监听 `127.0.0.1:2222` 的 sshd 配置。
5. 幂等启动 sshd。
6. 幂等启动 FRP watchdog。
7. `exec` 平台原有 Jupyter 命令。

替换脚本内的授权公钥后先验证语法：

```bash
/usr/bin/bash -n service/modelers_cmd.sh
```

## 5. 安装官方 FRPC

以下示例固定 FRP `0.70.0`，升级时 server、Space client 和开发电脑 visitor 一起升级：

```bash
set -eu
version=0.70.0
archive="frp_${version}_linux_arm64.tar.gz"
base_url="https://github.com/fatedier/frp/releases/download/v${version}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

curl -fL --retry 3 -o "$tmp_dir/$archive" "$base_url/$archive"
curl -fL --retry 3 -o "$tmp_dir/checksums.txt" "$base_url/frp_sha256_checksums.txt"
(cd "$tmp_dir" && grep "  $archive\$" checksums.txt | sha256sum -c -)

state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp"
mkdir -p "$state_dir/bin"
chmod 700 "$state_dir" "$state_dir/bin"
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
install -m 700 "$tmp_dir/frp_${version}_linux_arm64/frpc" "$state_dir/bin/frpc"
"$state_dir/bin/frpc" --version
```

预期 checksum 为 `OK`，版本输出为 `0.70.0`。

## 6. 配置 Space FRPC

在可信环境生成至少 32 字节的随机 `STCP_SECRET`。不要把 token 或 secret 打印到共享日志。

Space 持久配置路径：

```text
$NOTEBOOK_DIR/.modelers-frp/frpc.toml
```

配置模板：

```toml
serverAddr = "FRPS_HOST"
serverPort = FRPS_PORT

auth.method = "token"
auth.token = "FRPS_TOKEN"

transport.tls.enable = true

[[proxies]]
name = "PROXY_NAME"
type = "stcp"
secretKey = "STCP_SECRET"
localIP = "127.0.0.1"
localPort = 2222
```

写入后收紧权限并验证：

```bash
state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp"
runtime_dir="$HOME/.modelers-frp-runtime"
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
chmod 600 "$state_dir/frpc.toml"
cp "$state_dir/frpc.toml" "$runtime_dir/frpc.toml.check"
chmod 600 "$runtime_dir/frpc.toml.check"
timeout -k 5 15 "$state_dir/bin/frpc" verify -c "$runtime_dir/frpc.toml.check"
rm -f "$runtime_dir/frpc.toml.check"
```

配置中任何 `FRPS_*`、`STCP_SECRET` 或 `PROXY_NAME` 占位符都必须替换。

## 7. 部署 watchdog

项目源文件为 [`service/modelers_frp_watchdog.sh`](../service/modelers_frp_watchdog.sh)。部署到持久目录：

```bash
state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp"
install -m 700 service/modelers_frp_watchdog.sh "$state_dir/watchdog.sh"
/usr/bin/bash -n "$state_dir/watchdog.sh"
nohup "$state_dir/watchdog.sh" > "$state_dir/watchdog.out" 2>&1 < /dev/null &
```

默认行为：

- 每 300 秒检查一次 FRPC。
- 每 6 次检查执行一次活动请求，即 30 分钟一次。
- 配置校验最长 15 秒，额外 5 秒强制终止窗口。
- `frpc.log` 和 `watchdog.log` 超过 5 MiB 时保留一份 `.1`。
- lifecycle lock 串行化启动和停止。
- main lock 保证最多一个 watchdog。
- PID 文件写入失败时不继续运行。

可选公网活动 URL 写入：

```text
$NOTEBOOK_DIR/.modelers-frp/modelers-public-url.txt
```

文件只能包含一行 `https://` URL。watchdog 还会请求本机 Jupyter `/api/status`；token 不写入日志。

## 8. 发布 Space 启动入口

把经过 `bash -n` 验证的 `service/modelers_cmd.sh` 发布为 Modelers Space 启动脚本。不要只修改当前容器中的运行副本：平台完整重建会重新加载已发布版本。

发布后完整重启一次并验证：

```bash
state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp"
runtime_dir="$HOME/.modelers-frp-runtime"

cat "$runtime_dir/watchdog.pid"
cat "$runtime_dir/frpc.pid"
ss -H -lnt 'sport = :2222'
tail -n 20 "$state_dir/watchdog.log"
tail -n 20 "$state_dir/frpc.log"
```

预期只有一个 watchdog、一个 FRPC，并且 sshd 只显示 `127.0.0.1:2222`。

## 9. 配置开发电脑 visitor

创建私密目录，放入官方 Windows `frpc.exe` 和以下 `frpc_visitor.toml`：

```toml
serverAddr = "FRPS_HOST"
serverPort = FRPS_PORT

auth.method = "token"
auth.token = "FRPS_TOKEN"

transport.tls.enable = true

[[visitors]]
name = "PROXY_NAME-visitor"
type = "stcp"
serverName = "PROXY_NAME"
secretKey = "STCP_SECRET"
bindAddr = "127.0.0.1"
bindPort = 22222
```

校验并启动：

```powershell
.\frpc.exe verify -c .\frpc_visitor.toml
.\frpc.exe -c .\frpc_visitor.toml
```

visitor 只监听本机 loopback。

## 10. 固定 Space HostKey

第一次在可信的 Space 控制台读取 sshd HostKey 公钥指纹：

```bash
runtime_dir="$HOME/.modelers-ssh-runtime"
ssh-keygen -lf "$runtime_dir/ssh_host_ed25519_key.pub"
```

核验后，在开发电脑写入独立 known-hosts 文件：

```powershell
ssh-keyscan -p 22222 127.0.0.1 2>$null |
  Set-Content -Encoding ascii .\known_hosts_modelers
ssh-keygen -lf .\known_hosts_modelers
```

指纹必须与可信控制台一致。

创建 `ssh_config`：

```sshconfig
Host modelers-npu
    HostName 127.0.0.1
    Port 22222
    User SPACE_USER
    IdentityFile ./id_rsa
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    UserKnownHostsFile ./known_hosts_modelers
    BatchMode yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

## 11. 一键连接

当前项目提供：

```powershell
pwsh -File .\outputs\modelers-npu-ssh-credentials\connect.ps1
pwsh -File .\outputs\modelers-npu-ssh-credentials\connect.ps1 'id -un; pwd'
```

`connect.ps1` 的职责：

1. 收紧 SSH 私钥和 visitor 配置的 Windows ACL。
2. 获取全局命名 mutex，拒绝同机并发 visitor。
3. 运行 `frpc verify`。
4. 确认 `127.0.0.1:22222` 未被占用。
5. 最多尝试启动 visitor 3 次，每次最多等待 15 秒。
6. 使用严格 HostKey 校验执行 OpenSSH。
7. SSH 退出或异常时终止 visitor 并删除临时日志。

## 12. SCP、端口转发和 VS Code

在 visitor 运行期间：

```powershell
ssh -F .\ssh_config modelers-npu
scp -F .\ssh_config .\local-file modelers-npu:/home/SPACE_USER/volume/notebook/
ssh -F .\ssh_config -N -L 18000:127.0.0.1:8000 modelers-npu
```

VS Code Remote SSH 使用相同 `ssh_config`。若使用 `connect.ps1` 管理 visitor，应让其保持运行，再从 VS Code 发起连接；不要同时启动第二个 visitor。

## 13. 验收清单

Space：

```bash
state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp"
runtime_dir="$HOME/.modelers-frp-runtime"

test "$(stat -c %a "$runtime_dir/frpc.toml")" = 600
ps -fp "$(cat "$runtime_dir/watchdog.pid")"
ps -fp "$(cat "$runtime_dir/frpc.pid")"
ss -H -lnt 'sport = :2222'
```

开发电脑：

```powershell
pwsh -File .\connect.ps1 'id -un; pwd'
```

预期输出：

```text
SPACE_USER
/home/SPACE_USER
```

恢复测试：记录 `frpc.pid`，核验身份后终止该 PID，等待最长 330 秒。新 PID 必须不同，且重新连接成功。

并发测试：第一个 `connect.ps1` 保持 SSH 时，第二个调用必须立即报告已有连接，而不是共用或抢占 visitor。

## 14. 故障定位

visitor 未就绪：

```powershell
.\frpc.exe verify -c .\frpc_visitor.toml
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 22222 -ErrorAction SilentlyContinue
```

Space FRPC 未运行：

```bash
tail -n 100 "${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp/watchdog.log"
tail -n 100 "${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp/frpc.log"
```

HostKey 变化：先确认 Space 是否完整重建，在可信控制台重新读取新指纹；只有指纹核验一致后才更新该 Space 独立的 known-hosts 文件。

SSH 拒绝公钥：

```bash
stat -c '%a %n' "$HOME/.ssh" "$HOME/.ssh/modelers_authorized_keys"
/usr/sbin/sshd -t -f "$HOME/.modelers-ssh-runtime/sshd_config"
tail -n 100 "${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-ssh/sshd.log"
```

## 15. 停止与撤销

停止 watchdog 和 FRPC：

```bash
"${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp/watchdog.sh" --stop
```

该命令只停止身份核验通过的进程。确认进程已退出后，再删除此 Space 的 FRP state/runtime 文件和开发电脑私密连接目录。

撤销顺序：

1. 发布不再启动 sshd/watchdog 的 Space 启动脚本。
2. 完整重启 Space。
3. 从 FRPS 配置管理中撤销对应 token 或客户端权限。
4. 删除 Space 的 `.modelers-frp` 与 `.modelers-ssh`。
5. 删除开发电脑上的 Space SSH 私钥、visitor 配置和 known-hosts 文件。

不要清空共享 FRPS 配置，也不要终止未通过 PID 与身份核验的进程。
