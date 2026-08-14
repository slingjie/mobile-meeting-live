# Mobile Meeting Live — 实时会议转录 + 中文翻译

一个面向**手机浏览器**的实时会议转录与翻译工具。支持中文 / 越南语 / 英文混合会议，实时语音转文字并**翻译成中文**，适用于光伏/储能等海外工程项目的中外技术会议。

- 🌐 在线体验：<https://mobile-meeting-live.pages.dev>
- 🚀 部署平台：Cloudflare Pages（国内可访问，API Key 不出服务器）

---

## 功能特性

| 功能 | 说明 |
|---|---|
| 🎙️ 手机麦克风采集 | iPhone / Android 浏览器直接使用，HTTPS 即可 |
| 📝 实时转录 | Gemini Live API `inputAudioTranscription`，中/越/英混合 |
| 🌐 实时翻译 | `gemini-3.5-live-translate-preview` 翻译模型，目标语言中文（`zh-CN`） |
| 🗣️ 双语字幕 | 每条记录显示**原文 + 🌐 中文译文** |
| ⏱️ 句子切分 | 前端自适应 VAD：静音 500ms 切句，每条带时间戳 |
| 🔊 麦克风电平条 | 实时显示拾音音量，方便调试 |
| 🔄 自动重连 | 约 9 分钟周期性重连（Gemini Live 会话时长限制），字幕不丢失 |
| ⏸️ 暂停/继续/结束 | 完整会话控制 |
| 💾 本地保存 | localStorage 自动持久化，刷新不丢 |
| 📤 导出 | Markdown / TXT，含译文 |
| 🛡️ 密钥安全 | Gemini API Key 只存服务端（Cloudflare Secret），前端零泄露 |
| 🌍 国内可用 | 通过 Cloudflare 边缘代理转发，浏览器无需直连 Google |

---

## 快速开始（本地运行）

需要：Node.js ≥ 18

```bash
# 1. 克隆
git clone https://github.com/slingjie/mobile-meeting-live.git
cd mobile-meeting-live

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：
#   GEMINI_API_KEY=你的_Gemini_API_Key
#   PORT=3000

# 3. 安装依赖并启动
npm install
npm start
```

访问 <http://localhost:3000>（电脑调试用；手机需 HTTPS，见下文）。

> **代理提示**：本地模式下 `server.js` 检测到 `HTTPS_PROXY` / `ALL_PROXY` 环境变量会自动走代理（已内置 undici `EnvHttpProxyAgent`），国内网络无需额外配置。

---

## 部署到 Cloudflare Pages（推荐）

手机浏览器获取麦克风**必须 HTTPS**，本地 localhost 无法手机实测。部署到 Cloudflare Pages 即可获得 HTTPS 域名。

### 1. 准备工作

```bash
# 安装 wrangler 并登录（一次性）
npm install -g wrangler
npx wrangler login
```

### 2. 创建项目并部署

```bash
# 创建 Pages 项目（首次）
npx wrangler pages project create mobile-meeting-live --production-branch main

# 部署（每次更新代码）
npx wrangler pages deploy public --project-name mobile-meeting-live --branch main --commit-dirty=true
```

部署完成后会输出 `https://<hash>.mobile-meeting-live.pages.dev`，正式域名固定为：

```
https://mobile-meeting-live.pages.dev
```

### 3. 配置密钥（关键！）

```bash
# 把 GEMINI_API_KEY 设为 Cloudflare Secret（加密存储，不进代码/仓库）
echo "你的_GEMINI_API_Key" | npx wrangler pages secret put GEMINI_API_KEY --project-name mobile-meeting-live
```

### 4. 验证部署

```bash
# 健康检查
curl https://mobile-meeting-live.pages.dev/health

# 全链路验证（需要一段 16kHz 单声道 PCM 音频）
node scripts/verify-ws.mjs /path/to/audio.pcm
# 期望输出：PASS: setupComplete + inputTranscription + outputTranscription
```

> ⚠️ 部署后若手机行为异常，请**强制刷新**页面（或清缓存）——`index.html` 已对 `app.js` 做内容哈希版本号处理（`app.js?v=<hash>`），但旧标签页可能仍持有旧代码。

---

## 架构说明

```
手机麦克风
  ↓ Web Audio API (AudioWorklet)
16kHz / 16-bit PCM
  ↓
浏览器 WebSocket → pages.dev/ws（Cloudflare Pages Function 代理）
  ↓                                   │
  │                Cloudflare 边缘生成 Gemini ephemeral token
  │                （GEMINI_API_KEY 只存在这里，永不暴露给前端）
  ↓                                   ↓
Google Gemini Live API（BidiGenerateContentConstrained）
  ↓
inputAudioTranscription（原文） + outputAudioTranscription（中文译文）
  ↓
前端渲染：原文 + 🌐 译文，localStorage 持久化
```

### 关键文件

| 文件 | 职责 |
|---|---|
| `public/app.js` | 前端主逻辑：连接、音频采集、自适应 VAD 切句、消息解析、双语字幕渲染 |
| `public/pcm-processor.js` | AudioWorklet：浏览器采样率 → 16kHz 16-bit PCM |
| `public/index.html` / `style.css` | UI（含麦克风电平条、诊断信息） |
| `functions/ws.js` | **WebSocket 代理**：浏览器 → Google，国内网络无需直连；token 服务端注入 |
| `functions/token.js` | 签发 Gemini ephemeral token（备用端点） |
| `server.js` | 本地运行版（含 undici 代理支持） |
| `scripts/verify-ws.mjs` | 线上全链路验证脚本 |

### 为什么需要代理（functions/ws.js）

Gemini Live API 的 WebSocket 端点在国内网络**无法直连**。通过 Cloudflare Pages Function 做代理：

- 浏览器只连接 `pages.dev`（国内可访问），由 Cloudflare 边缘转发到 Google
- Ephemeral token 在服务端生成并注入，**API Key 永不进入浏览器**，杜绝泄露
- 代理内置竞态防护（上游 CONNECTING 期间消息排队补发）和文本/二进制帧规范转发

---

## 工程要点与踩坑记录

### Gemini Live API 协议要点

1. **Setup 字段位置**（2026-08 实测）：
   - `responseModalities` 在 `generationConfig` 内
   - `inputAudioTranscription` / `outputAudioTranscription` / `translationConfig` 在 **setup 顶层**（`generationConfig` 外的兄弟字段）
   - `thinkingConfig` 已从 API 移除，发送会报 1007
2. **Constrained 端点**：`BidiGenerateContentConstrained` 才接受 ephemeral token；`BidiGenerateContent`（无后缀）要求 API Key 直连，两者不能混用
3. **必须发 `audioStreamEnd`**：只发音频不发结束信号，Gemini 不会返回转录结果——前端 VAD 检测静音 500ms 后自动发送

### 前端 VAD 设计

- 自适应底噪阈值：`threshold = max(250, noiseFloor × 2)`，noiseFloor 用指数滑动平均跟踪，避免固定阈值在嘈杂会议室误判
- 静音 500ms 判定句子结束 → 发 `audioStreamEnd` → 触发 Gemini 返回转录
- 兜底切句：streamEnd 后 2 秒若无 `turnComplete`，前端强制把当前句落成一条带时间戳的记录

### 部署/缓存注意

- `.env` 已在 `.gitignore` 排除，**绝不提交 API Key**
- Cloudflare Secret 用 `wrangler pages secret put` 设置，代码里只读 `context.env.GEMINI_API_KEY`
- `app.js` 引用带内容哈希版本号，避免浏览器缓存旧代码导致诡异 bug

---

## 已知限制

- **翻译为音频优先**：`gemini-3.5-live-translate-preview` 是语音→语音翻译模型，译文文本（`outputTranscription`）可能比原文略短（按语义单元截断），这是模型特性
- **会话时长**：Gemini Live 长会话存在连接时长限制，当前约 9 分钟自动重连（字幕已保留）。正式长期使用建议升级为官方 session resumption 机制
- **翻译延迟**：译文在句子结束（静音 500ms）后才输出，说话过程中只有原文实时滚动

---

## 验证清单

建议用真实会议验证：

- [ ] 连续 30~60 分钟稳定性（含自动重连）
- [ ] 中越混合语言识别准确率
- [ ] 专业术语识别率（光伏、储能、EPC、EMS、PCS、110kV 等已在 system prompt 中提示）
- [ ] 会议室噪声环境下的 VAD 切句
- [ ] 翻译延迟与准确度（越南语 → 中文）
- [ ] 自动重连前后的字幕完整性

---

## License

MPL-2.0
