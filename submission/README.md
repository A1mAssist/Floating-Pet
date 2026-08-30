# 浮伴 Floating Pet

浮伴是一只常驻 Windows 桌面的全模态陪伴宠物。它把模型能力放在需要的时刻：平时安静存在，用户明确开启输入后，再结合语音、视觉和当前上下文一起处理问题。

线上宣传页：[https://a1massist.github.io/Floating-Pet-site/](https://a1massist.github.io/Floating-Pet-site/)

## 这份提交包包含什么

- `floating-pet-promo.html`：可离线打开的单文件宣传页，内嵌当前产品的宠物形象和托盘 Logo。
- `fuban-promo.mp4`：90 秒产品宣传片，供宣传页和 GitHub Pages 直接播放。
- `../desktop/release/Floating-Pet-Demo-Portable-0.1.0-x64.exe`：Windows 便携 Demo。
- `../docs/demo-video-script.md`：宣传片脚本和演示流程参考。

## 重点能力

1. 透明置顶桌宠：常驻桌面、拖拽、边缘吸附、托盘和键盘操作。
2. 受控多模态输入：麦克风、摄像头和指定屏幕分别授权，可暂停或结束。
3. 有边界的主动协助：重复线索经过确认后才询问，用户可以拒绝。
4. 本地可演示流程：任务、便签、记忆管理、专注计时和对话流程不依赖模型服务即可体验。

## 运行方式

请保持本目录和 `../desktop/release/` 的相对位置不变，然后双击 HTML 文件查看宣传页，或运行 Windows Demo。Demo 默认静音，不会因为打开宣传页而播放系统 TTS。

宣传片已随页面提供，也可以用本地文件选择器临时替换播放，所选视频不会上传。当前提交包不把未验证的模型服务或 Mock 输出描述为真实模型能力。

## 验证边界

离线 Demo 用于展示客户端交互和产品形态；真实模型链路需要按项目根目录 `desktop/README.md` 的说明配置服务后再验收。凭据、模型权重、签名证书和构建缓存不随项目提交。
