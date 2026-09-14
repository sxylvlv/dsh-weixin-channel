# dsh-weixin-channel

把**微信**接成 DeepSeek Harness 的一个入口：在微信里发消息 = 在一个真实的 DSH 会话里下指令。

- 一条微信对话 = 一个 DSH 会话，**跨消息长期复用**；微信里发「新对话」才另起一个。
- **双向媒体**：微信发来的图片/文件/语音/视频进得了会话；DSH 生成的文档/图片/压缩包推得回微信。
- **文本提问**：微信侧没有交互式选择题，需要你决策时它用编号列表问你。

来源：`@tencent-weixin/openclaw-weixin@2.4.8`（Tencent，MIT）从 OpenClaw 插件平面到 DSH Cordis 插件平面的移植。
协议层（ilink HTTP 接口、扫码登录状态机、CDN AES 加解密）沿用原实现语义。

---

## 它工作在哪

```
微信 App → 腾讯 ilink bot（ilinkai.weixin.qq.com）
        → getUpdates 长轮询（客户端发起，**不需要公网入口/域名/证书**）
        → dsh-weixin-channel（跑在 DSH 进程里的 Cordis host 插件）
        → DSH 会话（agents.resume/create + followup）
        → 回复文本 / CDN 上传文件 → 微信
```

一个长轮询连接，多个微信用户 → 各自独立会话。

---

## 安装

### 前置

- DSH（`dsh` 命令可用），Node ≥ 22
- 一个**腾讯 ilink 机器人**账号（扫码授权即可，无需自建服务端）

### 方式 A：作为 bundle 安装（推荐）

```sh
# 1. 装进 web profile
dsh plugin --profile web add dsh-weixin-channel

# 2. 扫码登录（此刻不需要 DSH 在跑）
npx dsh-weixin-login
#   或：node node_modules/dsh-weixin-channel/bin/weixin-login.mjs

# 3. 启动 / 重启 DSH
dsh web
```

因为本包声明了 `dsh.bundle`，第 1 步会自动把 `dsh-weixin-channel` 追加进 profile 的
`dsh.profile.bundles`；它自带的 `cordis.patch.yml` 会插入插件行。**不需要手改 profile 的 patch 文件。**

### 方式 B：手工放置

1. 把整个目录放到 `$DSH_HOME/profiles/web/` 下（与 `cordis.patch.yml` 同级）
2. 把 `cordis.patch.snippet.yml` 的内容追加进 `$DSH_HOME/profiles/web/cordis.patch.yml`
3. `node bin/weixin-login.mjs` 扫码登录
4. `dsh web`

### 登录做了什么

`dsh-weixin-login` 打印二维码（终端 + PNG），扫码授权后：

- 账号凭据写入 `$DSH_HOME/weixin/accounts/<accountId>.json`（权限 0600）
- **把扫码者加入白名单** —— 所以 `allowFrom` 留空也能用，且外部陌生号仍被拒绝

---

## 可视化面板

装好之后，在 DSH 里打开 **设置 → 微信通道**，一页看完通道状态：

- **通道状态**：running/stopped、构建版本、宿主 pid、当前账号、看门狗是否在跑、状态时间
- **扫码登录 / 换一个微信**：点一下就在面板里出二维码，过期自动换新码；微信要求「手机上的数字」时下方有输入框；还带「停止登录」
- **已登录账号**：账号 id、扫码者 userId、登录时间（**只显示元数据，不显示 token**）
- **最近日志**：`channel.log` 尾部，长串密钥形态自动脱敏
- **重载通道**：换号后点它让新账号生效

实现方式：宿主半（`lib/ui-server.mjs`）把数据与动作注册成同源的 `/dsh-weixin/*` 本机路由，客户端半（`client/client.js`）是这个包 `dsh.client` 声明的静态客户端模块。**面板不增加任何对外监听**，只在 DSH 自己的本机服务上多几个路由。

---

## 配置

改 `$DSH_HOME/profiles/web/cordis.patch.yml` 里那一行的 `config`，或改本包的 `cordis.patch.yml` 后重装。
必填只有 `workspacePath`（默认取 DSH 进程工作目录）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `workspacePath` | `process.cwd()` | 微信会话在哪个目录里干活 |
| `permissionPreset` | **`read-only`** | `read-only` / `workspace-write` / `danger-full-access`。**微信是外部输入源，建议先只读** |
| `agentPreset` | `standard` | 与部署里已装的 preset 名一致 |
| `allowFrom` | `[]` | 微信 userId 白名单；扫码者会自动进白名单。**不要写通配** |
| `accountId` | `''` | 留空 = 用状态目录里已登录的账号 |
| `maxReplyChars` | `4000` | 腾讯侧单条文本上限，超出按段落分段发送 |
| `replyProgress` | `true` | 先回执「收到，正在处理…」 |
| `longPollTimeoutMs` | `35000` | 服务端可下发覆盖 |
| `ensureSessionVisible` | `true` | 保证通道会话不被浏览器侧的「归档」隐藏 |
| `watchdog` | `true` | 自愈看门狗：通道静默失效（热重组把行弄丢、进程被杀）时自动重挂。日志见 `channel.log` 的 `[watchdog]` 行；禁用 = 设为 `false` 或在状态目录放 `watchdog.off` |
| `extractVideoFrame` / `videoFrameCount` / `videoSceneExtra` | `true` / `3` / `2` | 视频抽帧（默认只在你说「分析视频」时触发） |
| `staleTokenMs` / `minSendIntervalMs` / `maxConsecutiveSendFailures` / `sendCooldownMs` | `600000` / `1500` / `3` / `300000` | 出站守卫：令牌过期阈值、最小发送间隔、断路器阈值与冷却 |

---

## 微信侧指令

| 你说 | 效果 |
| --- | --- |
| 直接说话 | 正常对话（复用当前会话） |
| `新对话` / `/new` / `/reset` / `重置对话` | 下一条消息开一个全新会话（旧会话保留在 DSH 里） |
| `/status` | 回报当前账号、会话 id、权限预设 |
| `/分析` / `分析视频`（可 `/分析 2`） | 抽帧分析最近（或倒数第 N）条视频；会把宫格图回发给你 |
| `/视频信息` / `/视频列表` | 视频元数据 / 最近保存的列表 |
| `/frames N` | 临时改抽帧数（1~16，仅本次进程有效） |
| `/pair` | 自助加入白名单（需 `autoPair: true`，默认关） |

**能力对照**

| 方向 | 类型 | 支持 |
| --- | --- | --- |
| 微信 → DSH | 文字 / 图片 / 文件（docx·xlsx·pptx·pdf·zip）/ 语音（有服务端转写时）/ 视频（默认只存不分析） | ✅ |
| DSH → 微信 | 文字（超长自动分段）/ 图片 / 文档与压缩包 | ✅ |
| DSH → 微信 | 视频 | ❌ 未接入 |

DSH 侧要主动发文件时，在回复里**单独占一行**写 `MEDIA:<绝对路径>`，该行不会作为文字发出。

---

## 安全须知（重要）

- **微信消息 = 一个能在你本机跑工具的外部输入源。** 默认给的是 `read-only` + 白名单；确认可信后再放宽到 `workspace-write` 或 `danger-full-access`。
- `allowFrom` 为空表示"只认已扫码登录的号"，**不是**"谁都行"。
- 凭据文件 0600；日志有脱敏，但**不要把 token 打进聊天**。
- 本插件默认不改 DSH 的审批策略。想让危险动作回微信确认，需要额外接审批流（本包未实现）。

---

## 已知边界

- **协议是逆向来的**：腾讯 ilink 接口没有公开文档，AES 配方与引用参数都是实测确定。腾讯侧改动会直接打断它，不保证长期可用。
- **主动发视频未接入**（微信发来的视频可以存/分析）。
- **语音没有本地转写**：服务端不给转写时只能存下 SILK 音频，模型无法直接听。
- **视频历史只在内存**：插件重启后 `/分析` 找不到上一条，视频文件本身仍在磁盘。
- **热重组的失效模式已被看门狗兜住**：profile patch 被重写时偶发"旧行拆掉、新行插不回来"，通道会静默失效。默认开启的看门狗（独立进程，随通道挂载拉起）会在约 60 秒内判定并**换新 id 重挂**。想关掉见配置表的 `watchdog`。
- 只做**单聊**，未接群聊。

排障先看 `$DSH_HOME/weixin/channel.log`（收发每一步都留痕），再看 `$DSH_HOME/weixin/mount-status.json`（插件挂载状态）。

---

## 许可

MIT。见 [LICENSE](LICENSE)。

移植自 Tencent 的 `@tencent-weixin/openclaw-weixin`（MIT）。协议与商标权利归腾讯；本项目与腾讯无隶属关系。
