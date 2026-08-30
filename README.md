# Floating Pet for MiniCPM-o

Windows 桌面悬浮陪伴应用，使用 Electron 提供透明置顶界面，并通过独立 Python 服务连接 MiniCPM-o 的回合制多模态与实时音视频能力。

产品宣传页：[https://a1massist.github.io/Floating-Pet-site/](https://a1massist.github.io/Floating-Pet-site/)

## 项目说明

浮伴（Floating Pet）是一只常驻 Windows 桌面的全模态陪伴宠物。它不把用户的工作区变成聊天窗口，而是先保持安静，在用户明确开启输入后，结合语音、视觉和当前上下文提供一次可拒绝的协助。

项目的核心体验是“默认关闭，按需开启，随时收回”：麦克风、摄像头、屏幕输入分别受控；重复线索经过确认后才触发主动询问；暂停采集、勿扰和结束陪伴会立即停止对应输入链路。模型服务不可用时，应用仍可通过本地 Demo 展示桌宠、任务、便签、专注计时、记忆管理和对话流程，不把 Mock 行为包装成真实模型能力。

### 组成

- `desktop/`：Electron Windows 客户端。负责透明置顶窗口、桌宠渲染、托盘菜单、任务与便签、记忆和专注计时，以及模型服务连接。
- `service/`：Python 模型适配服务。把回合制多模态和 Realtime 音视频协议收敛为客户端可用的接口。
- `harmony/`：HarmonyOS NEXT PC 工程，复用 Renderer，并通过 ArkTS 能力桥接系统侧能力。
- `submission/floating-pet-promo.html`：比赛提交用单文件宣传页，使用现有产品角色和托盘 Logo，可离线打开，并在 GitHub Pages 上播放随包提供的宣传片。
- `submission/openbmb-project-description.md`：面向 OpenBMB 比赛评审的项目说明，可作为报名表或提交包中的项目介绍。
- `docs/`：产品、模型服务、部署和验收记录。

### 快速体验

```powershell
Set-Location .\desktop
npm ci
npm run start:fake
```

`start:fake` 用于离线演示客户端交互，不需要模型服务。接入模型服务时，按 [desktop/README.md](desktop/README.md) 配置服务地址和协议，再运行对应的集成检查。

### 提交包注意事项

宣传页中的 Windows Demo 使用相对路径读取 `desktop/release/Floating-Pet-Demo-Portable-0.1.0-x64.exe`。提交时请保留 `submission/` 与 `desktop/release/` 的相对目录关系，或直接提交完整项目压缩包。模型权重、凭据、签名材料和构建缓存不属于源码仓库。

## 目录

- `desktop/`：Electron 应用、测试与 Windows 打包配置
- `harmony/`：HarmonyOS NEXT PC 产品工程（ArkWeb UI + ArkTS 原生能力桥接）
- `service/`：FastAPI/Realtime 模型适配服务与 Ascend 启动脚本
- `docs/`：产品设计和 Modelers Space 运维文档

## 本地验证

```powershell
Set-Location .\desktop
npm ci
npm run check
npm run test:unit
npm run test:e2e
npm run test:service
npm run test:integration
```

完全离线的桌面预览：

```powershell
Set-Location .\desktop
npm run start:fake
```

HarmonyOS 工程使用 HarmonyOS 6.1.0 / API 23。同步当前 Renderer 并构建 HAP：

```powershell
node .\harmony\scripts\sync-renderer.mjs
Set-Location .\harmony
D:\Tools\command-line-tools\bin\hvigorw.bat --mode module -p product=default assembleHap --no-daemon
```

Ascend 服务部署、Realtime 协议、真实模型验收和打包说明见 [desktop/README.md](desktop/README.md)。Modelers Space 的 FRP STCP 运维流程见 [docs/modelers-space-ssh-workflow.md](docs/modelers-space-ssh-workflow.md)。

## 仓库边界

构建输出、测试截图、交付压缩包、连接凭据和历史浏览器原型不进入源码仓库。模型权重、CANN 与 TorchNPU 运行环境也不随仓库分发。
