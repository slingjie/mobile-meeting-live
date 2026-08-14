# Mobile Meeting Live — 实时会议转录 + 中文翻译

一个面向**手机浏览器**的实时会议转录与翻译工具。支持中文 / 越南语 / 英文混合会议，实时语音转文字并**翻译成中文**，适用于光伏/储能等海外工程项目的中外技术会议。

- 🚀 部署平台：Cloudflare Pages（国内可访问，API Key 不出服务器）

---

## 功能特性

| 功能 | 说明 |
|---|---|
| 🎙️ 手机麦克风采集 | iPhone / Android 浏览器直接使用，HTTPS 即可 |
| ⚡ 实时草稿 | Gemini Live API `inputAudioTranscription` + `outputAudioTranscription`，中/越/英混合 |
| ✅ 准确终稿 | 每个完整语音段由服务端再次听写、语义分句并做上下文中文翻译，按 parent segment ID 原地覆盖草稿 |
| 👥 段内发言人估计 | 终稿按声线变化返回 `utterances[]`，显示“本段发言人N（模型估计）”；不等同于稳定speaker ID或声纹身份 |
| 🌐 实时翻译 | `gemini-3.5-live-translate-preview` 生成低延迟中文草稿（`zh-CN`） |
| 🗣️ 双层字幕 | 同一行显示“校对中 / 已校对 / 实时稿”，终稿不会追加到下一时间戳 |
| 📦 音频分包 | 16kHz PCM 聚合为约 100ms/包（约 10 包/秒），避免2～3ms碎包 |
| ⏱️ 句子切分 | 前端自适应 VAD：静音 800ms 形成终稿，每条使用语音段开始时间 |
| 🔊 麦克风电平条 | 实时显示拾音音量，方便调试 |
| 🔄 自动重连 | 约 9 分钟周期性重连（Gemini Live 会话时长限制），字幕不丢失 |
| ⏸️ 暂停/继续/结束 | 完整会话控制 |
| 💾 本地保存 | localStorage 自动持久化，刷新不丢 |
| 📤 导出 | Markdown / TXT，含译文 |
| 🛡️ 密钥与额度保护 | API Key只存服务端；终稿接口要求Live会话签发的短期HMAC票据，并限制请求体/超时 |
| 🔀 可回滚模式 | 默认“实时＋准确终稿”，可切为“仅实时”，不做第二次语音段上传 |
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
#   FINAL_TRANSCRIPT_MODEL=gemini-3.1-flash-lite   # 可选，默认值
#   FINALIZE_TICKET_SECRET=仅生产需要的长随机字符串
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

部署完成后会输出一个 `https://<hash>.<project-name>.pages.dev` 的预览地址。你的正式域名（自定义或默认 `<project-name>.pages.dev`）可在 Cloudflare Dashboard 查看。

### 3. 配置密钥（关键！）

```bash
# API Key（加密存储，不进代码/仓库）
printf '%s' "你的_Gemini_API_Key" | npx wrangler pages secret put GEMINI_API_KEY --project-name mobile-meeting-live

# 终稿会话票据签名密钥（使用独立长随机值）
openssl rand -hex 32 | npx wrangler pages secret put FINALIZE_TICKET_SECRET --project-name mobile-meeting-live
```

### 4. 验证部署

```bash
# 页面可达性检查（应返回 HTTP 200）
curl -I https://<your-project>.pages.dev/

# 全链路验证（需要一段 16kHz 单声道 PCM 音频）
MEETING_WS_URL='wss://<your-preview-host>/ws' node scripts/verify-ws.mjs /path/to/audio.pcm
# 期望输出：PASS: setupComplete + inputTranscription + outputTranscription
```

> ⚠️ 部署后若手机行为异常，请**强制刷新**页面（或清缓存）——`index.html` 已对 `app.js` 做内容哈希版本号处理（`app.js?v=<hash>`），但旧标签页可能仍持有旧代码。

---

## 架构说明

```
手机麦克风 → Web Audio API → 16kHz / 16-bit PCM
  │
  ├─ 100ms/包 → 浏览器 WebSocket → Cloudflare `/ws`
  │              → Gemini Live Translate
  │              → 低延迟原文/中文草稿
  │
  └─ VAD完整语音段（含500ms句首预留、最长15秒安全窗口）
                 → Cloudflare `/finalize`
                 → 服务端音频二次听写、语义断句、段内发言人估计
                 → 携带前5条已确认上下文做中文文本翻译
                 → `{ segmentId, utterances[], source, translation }`
                              ↓
前端按 parent segment ID 将草稿原地替换为多条终稿 → localStorage 持久化
```

浏览器只接触短期Live会话和同源接口；`GEMINI_API_KEY` 只保存在服务端 Secret 中。当前默认终稿模型为 `gemini-3.1-flash-lite`，接口与前端按 provider 解耦，可在服务端替换为专用 ASR，而不用重写字幕状态机。

### 关键文件

| 文件 | 职责 |
|---|---|
| `public/app.js` | 前端主逻辑：连接、100ms分包、VAD、segment编排、草稿/终稿渲染 |
| `public/lib/*.js` | PCM聚合、语音段录制/WAV封装、segment状态机（可单测） |
| `public/pcm-processor.js` | AudioWorklet：浏览器采样率 → 16kHz 16-bit PCM |
| `public/index.html` / `style.css` | UI（含草稿/终稿状态、麦克风电平、诊断信息） |
| `functions/ws.js` | **Live WebSocket代理**：浏览器 → Google，token服务端注入 |
| `functions/finalize.js` | **终稿接口**：同源校验、整段音频二次听写、上下文中文翻译 |
| `functions/token.js` | 签发 Gemini ephemeral token（备用端点） |
| `server.js` | 本地运行版（含 undici 代理和 `/finalize`） |
| `tests/*.test.js` | 音频聚合、WAV、状态迁移和终稿接口测试 |
| `scripts/verify-ws.mjs` | 线上Live全链路验证脚本 |

### 为什么需要代理（functions/ws.js）

Gemini Live API 的 WebSocket 端点在国内网络**无法直连**。通过 Cloudflare Pages Function 做代理：

- 浏览器只连接 `pages.dev`（国内可访问），由 Cloudflare 边缘转发到 Google
- Ephemeral token 在服务端生成并注入，**API Key 永不进入浏览器**，杜绝泄露
- 代理内置竞态防护（上游 CONNECTING 期间消息排队补发）和文本/二进制帧规范转发

---

## 工程要点与踩坑记录

### Gemini Live API 协议要点

1. **Setup 字段位置**（2026-08 实测）：
   - `responseModalities` 和 `translationConfig` 在 `generationConfig` 内
   - `inputAudioTranscription` / `outputAudioTranscription` 在 setup 顶层
   - `translationConfig` 放 setup 顶层会报 `1007 Unknown name "translationConfig"`
   - `thinkingConfig` 已从 API 移除，发送会报 1007
2. **Constrained 端点**：`BidiGenerateContentConstrained` 才接受 ephemeral token；`BidiGenerateContent`（无后缀）要求 API Key 直连，两者不能混用
3. **必须发 `audioStreamEnd`**：只发音频不发结束信号，Gemini 可能长期不返回转录；前端 VAD 在静音 800ms 后自动发送

### 前端 VAD 与终稿设计

- 自适应底噪阈值：`threshold = max(250, noiseFloor × 2)`，noiseFloor 用指数滑动平均跟踪
- 网络音频先聚合为100ms，再发给Live WebSocket；`audioStreamEnd` 前会 flush 不满100ms的尾包
- 语音段保留300ms句首预录和截至静音结束的完整PCM，封装WAV后调用 `/finalize`
- Live迟到增量最多只更新当前绑定的segment；终稿必须携带同一个segment ID，才能覆盖该行
- `turnComplete` 或2.5秒保护窗口结束后解除Live绑定；无对应音频的内容仅标为“实时稿”

### 部署/缓存注意

- `.env` 已在 `.gitignore` 排除，**绝不提交 API Key**
- Cloudflare Secret 用 `wrangler pages secret put` 设置，代码里只读 `context.env.GEMINI_API_KEY`
- `app.js` 引用带内容哈希版本号，避免浏览器缓存旧代码导致诡异 bug

---

## 已知限制

- **当前终稿引擎**：已经是独立的整段音频二次听写通道，但默认仍使用 `gemini-3.1-flash-lite`；Google Cloud Speech-to-Text V2 Chirp 3 需要单独的GCP项目、API和服务端身份凭证，当前仓库未内置任何凭证，也未宣称已启用
- **准确性验证**：没有对应原始越南语录音时，只能验证结构、数字样例和错位修复，不能客观证明所有越南语疑似错词已修正
- **终稿延迟**：实测短英文样本约2.15秒；长句、网络波动和模型繁忙时可能更久，期间页面保留“校对中”草稿
- **Live草稿特性**：`gemini-3.5-live-translate-preview` 是语音→语音翻译模型，草稿译文可能短暂截断；只有“已校对”行可作为正式文本
- **会话时长**：Gemini Live 长会话存在连接时长限制，当前约9分钟自动重连（字幕已保留）。正式长期使用建议升级官方 session resumption

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
