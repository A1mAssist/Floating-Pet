# 浮伴 Web Demo

该目录把现有 Electron Renderer 构建为静态网页，供比赛评委直接体验界面和本地业务闭环。

线上地址：[https://floating-pet-web-demo.vercel.app/](https://floating-pet-web-demo.vercel.app/)

- 复用 `desktop/src/renderer` 与 `desktop/src/core.cjs`。
- 浏览器适配层只替换 Electron IPC。
- 对话使用明确标注的本地 Fake 回应。
- 记忆、任务、便签和专注状态保存在浏览器 `localStorage`。
- 不连接模型服务，不采集麦克风、摄像头或屏幕，不播放语音。

```powershell
node .\web-demo\build.mjs
npx vercel deploy .\web-demo\dist --prod
```
