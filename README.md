# Floating Pet for MiniCPM-o

Windows 桌面悬浮陪伴应用，使用 Electron 提供透明置顶界面，并通过独立 Python 服务连接 MiniCPM-o 的回合制多模态与实时音视频能力。

## 目录

- `desktop/`：Electron 应用、测试与 Windows 打包配置
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

Ascend 服务部署、Realtime 协议、真实模型验收和打包说明见 [desktop/README.md](desktop/README.md)。Modelers Space 的 FRP STCP 运维流程见 [docs/modelers-space-ssh-workflow.md](docs/modelers-space-ssh-workflow.md)。

## 仓库边界

构建输出、测试截图、交付压缩包、连接凭据和历史浏览器原型不进入源码仓库。模型权重、CANN 与 TorchNPU 运行环境也不随仓库分发。
