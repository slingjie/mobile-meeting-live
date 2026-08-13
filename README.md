# Mobile Meeting Live — Gemini API 版

一个面向手机浏览器的极简实时会议转录工具。

## 已实现

- iPhone / Android 浏览器麦克风采集
- Gemini Live API 实时输入音频转录
- 中文 / 越南语 / 英文混合会议
- 工程术语上下文提示（光伏、储能、EPC、EMS、PCS、110kV 等）
- 自动 VAD 切句
- 自动周期重连，保留已有字幕
- 暂停 / 继续 / 结束
- 本地 localStorage 保存
- Markdown / TXT 导出
- Gemini API Key 只保存在服务端
- 前端使用 Gemini ephemeral token 直连 Live API，降低延迟

## 运行

1. 复制环境变量文件：

```bash
cp .env.example .env
```

2. 编辑 `.env`：

```env
GEMINI_API_KEY=你的_Gemini_API_Key
PORT=3000
```

3. 启动：

```bash
npm start
```

4. 电脑访问：

```text
http://localhost:3000
```

## 手机访问

手机浏览器获取麦克风通常要求 HTTPS（localhost 除外）。实际手机测试请部署到 HTTPS 域名，或使用 Cloudflare Tunnel / Tailscale Funnel 等 HTTPS 隧道。

## 技术结构

```text
手机麦克风
  ↓ Web Audio API
16kHz / 16-bit PCM
  ↓
浏览器向本地 Server 获取 Gemini ephemeral token
  ↓
浏览器 WebSocket 直连 Gemini Live API
  ↓
inputAudioTranscription
  ↓
实时字幕 + localStorage + Markdown/TXT
```

## 当前工程取舍

Gemini Live 是实时语音交互 API，不是纯 STT 专用 API。本项目只读取 `inputAudioTranscription`，忽略 Gemini 的音频输出，并通过 system instruction 要求模型保持静默。

Gemini Live 长会话存在连接时长限制。当前 MVP 每约 9 分钟自动申请新 token 并重新连接，已生成的字幕不会丢失。正式长期使用建议后续升级为 Gemini 官方 session resumption 机制，以减少重连瞬间的潜在音频缺口。

## 验证重点

建议先用真实会议验证：

- 连续 30~60 分钟稳定性
- 中越混合语言准确率
- 专业术语识别率
- 会议室噪声环境
- 自动切句体验
- 自动重连前后的丢字情况
