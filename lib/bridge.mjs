/**
 * DSH 侧适配层：微信入站 → 复用/新建会话 → 取回复 → 发回微信。
 *
 * 会话策略（按用户要求）：
 *   - **每个微信用户长期复用同一个 DSH 会话**；进程重启后自动 resume 回来。
 *   - 想开新对话时在微信里发 `/new`（或 `/reset`、`新对话`），下一条消息即落到全新会话。
 *   - 权限预设默认 `danger-full-access`（sandbox=danger-full-access + approval=never）。
 *
 * 会话创建序列照搬 DSH 内置 webhook 的规范实现
 *   packages/webhook/webhook/src/session.ts :: createWebhookSession()
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { extractText, isMediaItem } from './message.mjs'
import { getConfig, sendText, sendTyping, sendMessage, generateClientId } from './ilink.mjs'
import { downloadAndDecrypt, downloadPlain, sniffImageMediaType, describeMediaItem, uploadLocalFileToWeixin, MessageItemType } from './media.mjs'
import { extractVideoFramePng, extractVideoSheetPng, evenTimestamps } from './video-frame.mjs'
import { createOutboundGuard } from './outbound.mjs'

/**
 * DSH 官方的用户消息构造器。
 *
 * **必须用它**：手写 `{content, source}` 会缺少 message id，实时能跑，
 * 但 durable 日志在重载时校验失败：
 *   SessionPersistenceCorruptionError: session event at seq N lacks an identified message
 * 后果是每次进程重启后 resume 失败、**静默退化成一个新会话**（实测踩过这个坑）。
 */
let dshCreateUserMessage
try {
  const mod = await import('@deepseek-ai/dsh-llm')
  dshCreateUserMessage = mod.createUserMessage
} catch (error) {
  dshCreateUserMessage = undefined
}

const TYPING_ON = 1
const TYPING_OFF = 2
const TYPING_KEEPALIVE_MS = 5000
/** 单轮等待上限，防止某轮卡死把通道堵住。 */
const TURN_TIMEOUT_MS = 15 * 60_000

/** 开新对话的指令（中英文都认）。 */
const NEW_CHAT_RE = /^\s*(\/new|\/reset|\/新对话|新对话|开新对话|重置对话)\s*$/i

/**
 * 出站媒体指令：回复里单独一行写 `MEDIA:<绝对路径>`。
 * 与源插件 agentPrompt 里给的用法一致。该行从文字正文中剥离。
 */
const MEDIA_DIRECTIVE_RE = /^[ \t]*MEDIA:[ \t]*(\S.*?)[ \t]*$/gim

function extractMediaDirectives(text) {
  const paths = []
  const cleaned = String(text ?? '')
    .replace(MEDIA_DIRECTIVE_RE, (_m, p) => {
      paths.push(String(p).trim())
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { paths, cleaned }
}

/**
 * 微信通道里**禁止暴露给模型**的工具。
 *
 * 这两个都走 `user-questions` 瀑布，而本部署里该瀑布的唯一应答者是 Web 客户端：
 * 问题会被它接走并**挂起等待浏览器里的一次点击**，在微信通道表现为静默卡死
 * （实测：tool-call 之后既无 tool/result 也无 turn/end，直到 agent 被销毁）。
 *
 * 全仓消费者已枚举，只有这两处：
 *   packages/interaction/tool-ask-user/src/index.ts:81  → ask_user_question
 *   packages/plan/plan-mode/src/index.ts:296            → exit_plan_mode
 *
 * **维护须知**：将来若有新增的、走 user-questions 的工具，必须补进这个名单，
 * 否则洞会重新打开。重跑一次全仓枚举即可：
 *   grep -rn "userQuestions" packages --include=*.ts
 */
const DENIED_TOOLS = ['ask_user_question', 'exit_plan_mode']

/** 只注入到微信会话的通道说明，保证「只走文本提问」这件事问得规范。 */
const CHANNEL_NOTE = [
  '## 微信通道',
  '你正在通过微信与用户对话，用户看到的是一条条手机消息。',
  '本通道**没有**交互式选择题工具（`ask_user_question`、`exit_plan_mode` 已从你的工具集中移除，调用它们不会有任何响应）。',
  '需要用户做决定时，用**纯文本**提问：把选项写成编号列表，请用户回复编号或直接说明。例如：',
  '> 你要哪种方案？',
  '> 1. 先做 A（快，但覆盖窄）',
  '> 2. 先做 B（慢，但更完整）',
  '回复 1 或 2 即可。',
  '其它约定：回复尽量短、适合手机阅读；避免宽表格和长代码块；需要长内容时分段发送。',
  '',
  '### 主动给用户发文件',
  '要把**本机文件**发给用户时，在回复里**单独占一行**写 `MEDIA:<绝对路径>`（多行即多个文件）：',
  '> 文件已生成，见下。',
  '> MEDIA:D:\\work\\报告.docx',
  '`MEDIA:` 那一行**不会**作为文字发出去，文件会被上传并通过微信发给用户。',
  '支持图片与各类文档/压缩包；**主动发视频未接入**。路径必须是绝对路径且文件真实存在，否则发送会失败并回报错误。',
  '',
  '### 用户发来的媒体',
  '- 图片：作为**原生图片**直接交给你，你能看到画面。',
  '- 文件：作为**附件**交给你，可从附件里读取内容。',
  '- 视频：**默认只保存、不分析**（用户明确要求省 token）。除非用户说「分析视频」或发 `/分析`，不要去抽帧、也不要试图分析它。',
  '  · 用户可用指令：`/分析`（分析最近一条，`/分析 2` 取倒数第二条）、`/视频信息`、`/视频列表`、`/frames N`（改抽帧数）。',
  '  · 这些指令由通道自己处理，不会走到你这里；你只会在用户要求分析时收到宫格图片。',
  '- 语音：优先用微信服务端给的转写文本；没有转写时只能拿到 SILK 音频文件，你无法直接听。',
].join('\n')

export function createBridge({ ctx, config, store, account, log }) {
  const appId = config.appId
  const botAgent = config.botAgent
  const typingTickets = new Map()
  /** userId → 视频抽帧数覆盖值（由 `/frames N` 设置，仅本次进程有效）。 */
  const videoFrameOverride = new Map()
  /** userId → 最近收到的视频（新的在前，最多留 5 条），供 `/分析 [N]` 用。 */
  const videoHistory = new Map()
  const VIDEO_HISTORY_MAX = 5
  /** userId → AgentHandle（本进程内持有，用于 /new 时的处理与状态展示）。 */
  const liveHandles = new Map()
  const mediaDir = path.join(os.tmpdir(), 'dsh-weixin', 'media')
  mkdirSync(mediaDir, { recursive: true })

  function isAllowed(userId) {
    const allowed = new Set([...(config.allowFrom ?? []), ...store.readAllowFrom(account.accountId)])
    return allowed.has(userId)
  }

  // ── 出站 ──────────────────────────────────────────────────────────────────

  function splitText(text) {
    const limit = config.maxReplyChars ?? 4000
    if (text.length <= limit) return [text]
    const chunks = []
    let rest = text
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit)
      if (cut < limit * 0.5) cut = limit
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^\n+/, '')
    }
    if (rest) chunks.push(rest)
    return chunks
  }

  /**
   * 出站守卫：节流 + 令牌新鲜度 + 断路器 + 发送台账。
   * 所有出站都必须经过它——脚本直发也要走同一条路，否则会绕过保护、把通道打限。
   */
  const guard = createOutboundGuard({
    store,
    accountId: account.accountId,
    log,
    ledgerPath: path.join(store.root, 'media-log.jsonl'),
    minIntervalMs: config.minSendIntervalMs ?? 1500,
    staleTokenMs: config.staleTokenMs ?? 10 * 60_000,
    maxConsecutiveFailures: config.maxConsecutiveSendFailures ?? 3,
    cooldownMs: config.sendCooldownMs ?? 5 * 60_000,
  })

  // 挂载即兜底：把历史上被归档（= 浏览器里被彻底隐藏）的本通道会话捞回来。
  restoreChannelSessions()

  /**
   * 先带会话令牌发送；令牌**过期**或发送失败时，改用**不带令牌**发送。
   *
   * 实测（2026-09-13）：
   *   - `context_token` 约十余分钟后失效，此时 sendmessage 回 ret=-2 prepare failed
   *   - 而**完全不带令牌**发送是被接受的（多次验证 SEND OK）
   *   - 也就是说：**过期的令牌比没有令牌更糟**，所以过期时应当直接不带，而不是先撞一次失败再重试
   * 代价：不带令牌的消息可能不并入原会话上下文，但总好过发不出去。
   */
  async function sendWithContextFallback({ userId, contextToken, label, detail, send }) {
    let token
    try {
      token = await guard.beforeSend(userId, contextToken, label)
    } catch (error) {
      log.error(`${label}: 未通过出站门禁 — ${String(error)}`)
      throw error
    }
    const meta = { userId, ...(detail ?? {}) }

    try {
      const resp = await send(token)
      guard.onSuccess(label, { ...meta, usedToken: Boolean(token) })
      return { resp, degraded: Boolean(contextToken) && !token }
    } catch (error) {
      if (token) {
        log.warn(`${label}: 带令牌发送失败（${String(error).slice(0, 100)}），改用无令牌降级重试 to=${userId}`)
        try {
          const resp = await send(undefined)
          guard.onSuccess(label, { ...meta, usedToken: false, retriedWithoutToken: true })
          return { resp, degraded: true }
        } catch (error2) {
          guard.onFailure(label, { ...meta, retriedWithoutToken: true }, error2)
          throw error2
        }
      }
      guard.onFailure(label, meta, error)
      throw error
    }
  }

  async function sendReply(userId, contextToken, text) {
    if (!text?.trim()) return
    const chunks = splitText(text)
    for (let i = 0; i < chunks.length; i += 1) {
      try {
        const { resp, degraded } = await sendWithContextFallback({
          userId,
          contextToken,
          label: `文本 ${i + 1}/${chunks.length}`,
          detail: { kind: 'text', chunk: i + 1, chunks: chunks.length, chars: chunks[i].length },
          send: (ctxToken) => sendText({
            baseUrl: account.baseUrl,
            token: account.token,
            toUserId: userId,
            text: chunks[i],
            contextToken: ctxToken,
            botAgent,
          }),
        })
        log.info(`出站成功${degraded ? '（降级·无令牌）' : ''} to=${userId} chunk=${i + 1}/${chunks.length} len=${chunks[i].length} resp=${JSON.stringify(resp).slice(0, 120)}`)
      } catch (error) {
        log.error(`出站失败 to=${userId} chunk=${i + 1}/${chunks.length} err=${String(error)}`)
        throw error
      }
    }
  }

  /** 上传并发送一个本地文件（图片 / 文档 / 压缩包…）。 */
  async function sendLocalFile(userId, contextToken, filePath) {
    const uploaded = await uploadLocalFileToWeixin({
      filePath,
      toUserId: userId,
      baseUrl: account.baseUrl,
      token: account.token,
      cdnBaseUrl: account.cdnBaseUrl,
      botAgent,
      log,
      referenceMode: config.mediaReferenceMode ?? 'ack-header',
      includeEncryptType: config.includeMediaEncryptType !== false,
      includeFullUrl: config.includeMediaFullUrl === true,
    })
    // 发送前自检：把刚上传的对象下载回来逐字节比对。
    // 起因：曾因下载引用取错字段（用了上传响应头而非 upload_param），
    // 结果是"消息发出去了、对方打不开"。自检不通过就中止发送，把问题留在日志里而不是用户那边。
    if (config.verifyBeforeSend !== false) {
      const ref = uploaded.item.image_item?.media ?? uploaded.item.file_item?.media ?? uploaded.item.video_item?.media
      try {
        const back = await downloadAndDecrypt({
          encryptQueryParam: ref.encrypt_query_param,
          fullUrl: ref.full_url,
          aesKeyBase64: ref.aes_key,
          cdnBaseUrl: account.cdnBaseUrl,
          label: '发送前自检',
          log,
        })
        const original = await readFile(filePath)
        if (back.length !== original.length || Buffer.compare(back, original) !== 0) {
          throw new Error(`回环不一致：下载 ${back.length} 字节 vs 本地 ${original.length} 字节`)
        }
        log.info(`发送前自检通过（逐字节一致，${back.length} 字节）`)
      } catch (error) {
        // ack-header / split 模式下，服务端与客户端的取图路径不同：
        // 用 encrypt_query_param 直接拼 /download 会 400，因此自检**给不出结论**。
        // 这种情况下只告警、不阻塞（否则会把已验证可用的配方误杀——今天就是这么误判的）。
        const mode = config.mediaReferenceMode ?? 'ack-header'
        if (mode === 'upload-param') {
          log.error(`发送前自检失败，已中止发送 file=${filePath}: ${String(error)}`)
          throw new Error(`上传对象自检失败，未发送：${String(error)}`)
        }
        log.warn(`发送前自检不可用（mode=${mode} 的取图路径与服务端不同），不阻塞发送: ${String(error)}`)
      }
    }

    const msg = (ctxToken) => ({      from_user_id: '',
      to_user_id: userId,
      client_id: generateClientId(),
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [uploaded.item],
      context_token: ctxToken ?? undefined,
    })
    const { resp, degraded } = await sendWithContextFallback({
      userId,
      contextToken,
      label: `媒体 ${uploaded.kind}`,
      detail: { kind: uploaded.kind, name: uploaded.fileName, bytes: uploaded.rawsize, filekey: uploaded.filekey },
      send: (ctxToken) => sendMessage({ baseUrl: account.baseUrl, token: account.token, msg: msg(ctxToken), botAgent }),
    })
    log.info(`出站媒体成功${degraded ? '（降级·无令牌）' : ''} to=${userId} kind=${uploaded.kind} name=${uploaded.fileName} bytes=${uploaded.rawsize} resp=${JSON.stringify(resp).slice(0, 120)}`)
    return uploaded
  }

  async function typingTicketFor(userId, contextToken) {
    const cached = typingTickets.get(userId)
    if (cached) return cached
    try {
      const resp = await getConfig({ baseUrl: account.baseUrl, token: account.token, ilinkUserId: userId, contextToken, botAgent })
      if (resp?.typing_ticket) {
        typingTickets.set(userId, resp.typing_ticket)
        return resp.typing_ticket
      }
    } catch (error) {
      log.debug(`getconfig 失败（不影响回复）: ${String(error)}`)
    }
    return undefined
  }

  function startTyping(userId, contextToken) {
    let timer
    let stopped = false
    void (async () => {
      const ticket = await typingTicketFor(userId, contextToken)
      if (!ticket || stopped) return
      const ping = (status) =>
        sendTyping({ baseUrl: account.baseUrl, token: account.token, ilinkUserId: userId, typingTicket: ticket, status, botAgent }).catch(() => {})
      await ping(TYPING_ON)
      timer = setInterval(() => void ping(TYPING_ON), TYPING_KEEPALIVE_MS)
    })()
    return async () => {
      stopped = true
      if (timer) clearInterval(timer)
      const ticket = typingTickets.get(userId)
      if (ticket) {
        await sendTyping({ baseUrl: account.baseUrl, token: account.token, ilinkUserId: userId, typingTicket: ticket, status: TYPING_OFF, botAgent }).catch(() => {})
      }
    }
  }

  // ── 会话：复用优先，必要时 resume 或新建 ────────────────────────────────

  /**
   * 构造入站用户消息。优先用 DSH 的 createUserMessage；
   * 退路也必须自带 `id` 与 `role`，否则会重现上面那个持久化校验失败。
   */
  function createUserMessage(content) {
    // **不要**用 { kind:'plugin', form:'notice' }：Web 端会把这类消息渲染成
    // 「折叠的上下文行」（ui-chat ContextBody `case 'notice'`），行上只显示 summary
    // （"inbound WeChat message"），**微信里真正发的内容看不见** —— 实测用户报障：
    // 「浏览器的对话窗口，看不到微信发给 dsh 的内容，只能看到 dsh 给微信的回复」。
    // 用 kind:'user'，它与浏览器里亲手输入的消息同构，渲染成完整气泡。
    const payload = {
      content,
      source: { kind: 'user' },
    }
    if (typeof dshCreateUserMessage === 'function') return dshCreateUserMessage(payload)
    log.warn('未取到 @deepseek-ai/dsh-llm 的 createUserMessage，使用自带 id/role 的退路结构')
    return { id: `weixin-${randomUUID()}`, role: 'user', ...payload }
  }

  /**
   * 保证微信会话在浏览器侧栏里**可见**。
   *
   * 背景（2026-09-14 实测）：DSH 的归档集合 `workspaceRegistry.archivedSessionIds`
   * 是「从**所有**分组/搜索里隐藏」（client/ui-workspace tree.ts 三处 derive* 全部排除），
   * 而全仓**只有 archiveSession、没有反归档 API**。一旦被归档，微信会话在浏览器里
   * 就彻底找不到 —— 用户报障原话：「所有的新对话窗口在浏览器端都找不到了，不要隐藏起来」。
   * 所以每次复用/新建会话都兜底把它从归档集合里摘出来。
   *
   * 维护须知：`registry.state` / `registry.setState` 是 workspace 包的 TS-私有成员，
   * 编译产物（lib/index.js）里就是普通属性/方法，因此运行时可用；将来若出现公开的
   * `unarchiveSession`，下面的分支会优先走它。形状不认识时只告警、绝不抛错。
   */
  function ensureSessionVisible(sessionId, label) {
    if (config.ensureSessionVisible === false) return
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return

    let archived
    try {
      archived = registry.archivedSessionIds ?? []
    } catch (error) {
      log.warn(`[${label}] 读取归档集合失败: ${String(error)}`)
      return
    }
    if (!archived.includes(sessionId)) return

    try {
      if (typeof registry.unarchiveSession === 'function') {
        Promise.resolve(registry.unarchiveSession(sessionId))
          .then(() => log.info(`[${label}] 已取消归档 ${sessionId}（公开 API）`))
          .catch((error) => log.warn(`[${label}] unarchiveSession 失败: ${String(error)}`))
        return
      }
      const state = registry.state
      if (!state || !Array.isArray(state.archivedSessionIds)) {
        log.warn(`[${label}] 注册表状态形状不认识，跳过取消归档（${sessionId} 可能仍被隐藏）`)
        return
      }
      // 只改 archivedSessionIds 一项，其余字段原样保留。
      const next = {
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      }
      Promise.resolve(registry.setState(next))
        .then(() => log.info(`[${label}] 已取消归档 ${sessionId}，浏览器侧栏可见`))
        .catch((error) => log.warn(`[${label}] 取消归档写入失败: ${String(error)}`))
    } catch (error) {
      log.warn(`[${label}] 取消归档异常（不影响对话）: ${String(error)}`)
    }
  }

  /**
   * 启动时一次性「捞回」本通道历史上被归档的会话。
   *
   * 与 {@link ensureSessionVisible} 同一背景，但覆盖面更大：只认 `weixin-` 前缀
   * （本插件创建的会话 id 一律用它），把它从归档集合里整体摘掉，其它归档项一个不碰。
   * 这样即使某次误归档，通道一挂载就把它们重新变得可见。
   */
  function restoreChannelSessions() {
    if (config.ensureSessionVisible === false) return
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return
    try {
      const archived = registry.archivedSessionIds ?? []
      const mine = archived.filter((id) => String(id).startsWith('weixin-'))
      if (mine.length === 0) return
      const state = registry.state
      if (!state || !Array.isArray(state.archivedSessionIds)) {
        log.warn('注册表状态形状不认识，跳过启动捞回（微信会话可能仍被隐藏）')
        return
      }
      const next = {
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => !String(id).startsWith('weixin-')),
      }
      Promise.resolve(registry.setState(next))
        .then(() => log.info(`启动捞回：已取消归档 ${mine.length} 个微信会话 — ${mine.join(', ')}`))
        .catch((error) => log.warn(`启动捞回写入失败: ${String(error)}`))
    } catch (error) {
      log.warn(`启动捞回异常（不影响对话）: ${String(error)}`)
    }
  }

  function applyPermission(session) {
    const presets = ctx.get('permissionPresets')
    if (!presets || !config.permissionPreset) return
    try {
      presets.set(session, config.permissionPreset)
      log.info(`权限预设已应用: ${config.permissionPreset}`)
    } catch (error) {
      log.warn(`权限预设 ${config.permissionPreset} 应用失败: ${String(error)}`)
    }
  }

  /**
   * 只作用于微信会话的策略，必须在 `agentPresets.mount` **之后**调用：
   *   1. 注入通道说明（agent 作用域，和 preset 一起随会话卸载）
   *   2. 从模型可见的工具表里移除会静默挂起的交互式提问工具
   *
   * 关于自检：我实测过 `agentCtx.tools.schemas()` 与 `agentCtx.systemPrompt.assemble().tools`
   * **都不能反映摘除结果**（前者只列出本插件自己的工具，后者在 setup 阶段拿不到 preset 工具），
   * 所以不做运行时自检。替代保证：`restrict()` 对未知工具名会直接抛错（fail-loud），
   * 这里的 catch 会把它记成 error —— 名单漂移不会静默通过。
   */
  function applyChannelPolicy(agentCtx, label) {
    try {
      agentCtx.systemPrompt.section({
        name: 'weixin-channel-note',
        order: 100,
        text: CHANNEL_NOTE,
        complete: false,
      })
      log.info(`[${label}] 已注入通道说明`)
    } catch (error) {
      log.error(`[${label}] 注入通道说明失败: ${String(error)}`)
    }

    try {
      agentCtx.tools.restrict({ deny: DENIED_TOOLS })
      log.info(`[${label}] 已从模型视野移除: ${DENIED_TOOLS.join(', ')}`)
    } catch (error) {
      log.error(`[${label}] 工具摘除失败（该会话可能仍会静默挂起，请检查名单）: ${String(error)}`)
    }
  }

  async function ensureSession(userId, previewText) {
    const existingId = store.getSessionId(account.accountId, userId)

    if (existingId) {
      const live = ctx.agents.get(existingId)
      if (live) {
        ensureSessionVisible(existingId, 'reuse')
        return { agent: live, sessionId: existingId, reused: true }
      }
      try {
        const preset = await ctx.agentPresets.resolve(config.agentPreset)
        await ctx.agentPresets.standingKeyFor(preset.id)
        const model = ctx.agentDefaultModel.currentSelection()
        const handle = await ctx.agents.resume({
          resumeSessionId: existingId,
          // **必须传 agentOptions**：agent-loop 用 `agent.options.provider/model` 提供
          // `{{provider}}` / `{{model}}` 两个提示词变量
          //   packages/core/agent-loop/src/index.ts:421-422
          // resume 不传 → 变量取不到值 → 拼提示词时整轮失败：
          //   prompt variable "{{model}}" has no value for this assembly
          //   (section "deployment:persona-prefix")
          agentOptions: { provider: model.provider, model: model.model },
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset.id)
            applyChannelPolicy(agentCtx, 'resume')
          },
        })
        liveHandles.set(userId, handle)
        ensureSessionVisible(existingId, 'resume')
        log.info(`已恢复既有会话 ${existingId}`)
        return { agent: handle.agent, sessionId: existingId, reused: true }
      } catch (error) {
        log.warn(`恢复会话 ${existingId} 失败，改为新建: ${String(error)}`)
        store.clearSessionId(account.accountId, userId)
      }
    }

    const preset = await ctx.agentPresets.resolve(config.agentPreset)
    await ctx.agentPresets.standingKeyFor(preset.id)
    const workspace = await ctx.workspaceRegistry.create(config.workspacePath)
    const sessionId = `weixin-${randomUUID()}`
    const model = ctx.agentDefaultModel.currentSelection()

    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: { provider: model.provider, model: model.model },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, preset.id)
        applyChannelPolicy(agentCtx, 'create')
      },
    })

    try {
      await workspace.attachSession(sessionId)
      applyPermission(handle.agent.session)
      const preview = String(previewText).replace(/\s+/g, ' ').slice(0, 24)
      ctx.sessionTitle.rename(handle.agent.session, `微信 ${userId} · ${preview}`)
    } catch (error) {
      await handle.dispose().catch(() => {})
      throw error
    }

    store.setSessionId(account.accountId, userId, sessionId)
    liveHandles.set(userId, handle)
    ensureSessionVisible(sessionId, 'create')
    log.info(`已新建会话 ${sessionId}`)
    return { agent: handle.agent, sessionId, reused: false }
  }

  /** 累积一次 attempt 的文本增量。 */
  function attachAssistantCapture(sessionId) {
    let text = ''
    const off = ctx.on('agent/assistant-stream', (payload) => {
      if (payload?.agent?.id !== sessionId) return
      const frame = payload.frame
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    })
    return {
      read: () => text,
      dispose: () => {
        if (typeof off === 'function') off()
      },
    }
  }

  /** 等待该会话的持久 turn/end —— 「这一轮真的结束了」的权威信号。 */
  function waitForTurnEnd(sessionId, budgetMs) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (typeof off === 'function') off()
        resolve(value)
      }
      const off = ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return
        if (event?.type !== 'turn/end') return
        finish({ ended: true, reason: event.data?.reason })
      })
      const timer = setTimeout(() => finish({ ended: false, reason: { kind: 'timeout' } }), budgetMs)
    })
  }

  async function runTurn({ userId, content, preview }) {
    const { agent, sessionId, reused } = await ensureSession(userId, preview)
    const capture = attachAssistantCapture(sessionId)
    try {
      agent.followup(createUserMessage(content))
      const outcome = await waitForTurnEnd(sessionId, TURN_TIMEOUT_MS)
      const reply = capture.read()
      log.info(`会话 ${sessionId}（${reused ? '复用' : '新建'}）回合结束: ${JSON.stringify(outcome.reason)} 文本长度=${reply.length}`)
      return { sessionId, reply, reused, ended: outcome.ended }
    } finally {
      capture.dispose()
    }
  }

  /**
   * 把入站媒体落成 DSH 原生内容块。
   *   image → attachments.saveImage → {type:'image', attachment}
   *   file  → attachments.saveFile  → {type:'file',  attachment}
   *   voice → 优先用服务端转写（已在 extractText 里带回）；无转写时保存原始 SILK 并说明
   * 任何一步失败都不阻断整条消息，而是降级成文字说明。
   */
  async function buildContentBlocks({ userId, text, mediaItems }) {
    const textParts = []
    const extraBlocks = []
    if (text) textParts.push(text)

    if (mediaItems.length === 0) {
      if (textParts.length) return [{ type: 'text', text: textParts.join('\n') }]
      return []
    }

    const attachments = ctx.get('attachments')
    if (!attachments) {
      textParts.push(`[收到 ${mediaItems.length} 个媒体项，但本部署未提供 attachments 服务]`)
      return [{ type: 'text', text: textParts.join('\n') }]
    }

    const extOf = (mime) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mime] ?? 'bin'

    for (const item of mediaItems) {
      try {
        if (item.type === MessageItemType.IMAGE) {
          const it = item.image_item ?? {}
          const media = it.media ?? {}
          if (!media.encrypt_query_param && !media.full_url) {
            textParts.push('[图片：消息里没有 CDN 地址，跳过]')
            continue
          }
          // 图片优先用 image_item.aeskey（hex）；都没有则走明文下载
          const aesKeyBase64 = it.aeskey ? Buffer.from(it.aeskey, 'hex').toString('base64') : media.aes_key
          const common = { encryptQueryParam: media.encrypt_query_param, cdnBaseUrl: account.cdnBaseUrl, fullUrl: media.full_url, label: 'image', log }
          const buf = aesKeyBase64
            ? await downloadAndDecrypt({ ...common, aesKeyBase64 })
            : await downloadPlain(common)
          const mediaType = sniffImageMediaType(buf)
          if (mediaType) {
            try {
              const ref = await attachments.saveImage({ data: buf, mediaType })
              extraBlocks.push({ type: 'image', attachment: ref })
              textParts.push('[用户发来一张图片，已作为原生图片附件交给模型]')
              continue
            } catch (error) {
              log.warn(`saveImage 被拒，降级为文件: ${String(error)}`)
            }
          }
          const name = `wechat-image-${Date.now()}.${mediaType ? extOf(mediaType) : 'bin'}`
          const ref = await attachments.saveFile({ data: buf, name })
          extraBlocks.push({ type: 'file', attachment: ref })
          textParts.push(`[图片已保存为文件 ${name}${mediaType ? '' : '（类型无法识别）'}]`)
        } else if (item.type === MessageItemType.FILE) {
          const it = item.file_item ?? {}
          const media = it.media ?? {}
          if ((!media.encrypt_query_param && !media.full_url) || !media.aes_key) {
            textParts.push('[文件：缺少 CDN 地址或密钥，跳过]')
            continue
          }
          const buf = await downloadAndDecrypt({
            encryptQueryParam: media.encrypt_query_param,
            aesKeyBase64: media.aes_key,
            cdnBaseUrl: account.cdnBaseUrl,
            fullUrl: media.full_url,
            label: 'file',
            log,
          })
          const name = it.file_name || `wechat-file-${Date.now()}.bin`
          const ref = await attachments.saveFile({ data: buf, name })
          extraBlocks.push({ type: 'file', attachment: ref })
          textParts.push(`[文件已保存：${name}（${buf.length} 字节）]`)
        } else if (item.type === MessageItemType.VOICE) {
          const it = item.voice_item ?? {}
          if (it.text) continue // 服务端已转写，extractText 已带回正文
          if (!it.media?.aes_key || (!it.media.encrypt_query_param && !it.media.full_url)) {
            textParts.push('[语音：服务端没有转写，也没有可取回的音频，无法理解]')
            continue
          }
          const buf = await downloadAndDecrypt({
            encryptQueryParam: it.media.encrypt_query_param,
            aesKeyBase64: it.media.aes_key,
            cdnBaseUrl: account.cdnBaseUrl,
            fullUrl: it.media.full_url,
            label: 'voice',
            log,
          })
          const name = `wechat-voice-${Date.now()}.silk`
          const ref = await attachments.saveFile({ data: buf, name })
          extraBlocks.push({ type: 'file', attachment: ref })
          textParts.push(`[语音已保存为 ${name}；本次服务端未给转写，我无法直接听音频，请改用文字]`)
        } else if (item.type === MessageItemType.VIDEO) {
          const it = item.video_item ?? {}
          const media = it.media ?? {}
          const sizeText = it.video_size ? `${it.video_size} 字节` : '大小未知'
          const lenText = it.play_length ? `，时长 ${it.play_length}` : ''
          if ((!media.encrypt_query_param && !media.full_url) || !media.aes_key) {
            textParts.push(`[视频：${sizeText}${lenText}，但消息里缺少 CDN 地址或密钥，取不回]`)
            continue
          }
          const buf = await downloadAndDecrypt({
            encryptQueryParam: media.encrypt_query_param,
            aesKeyBase64: media.aes_key,
            cdnBaseUrl: account.cdnBaseUrl,
            fullUrl: media.full_url,
            label: 'video',
            log,
          })
          const name = `wechat-video-${Date.now()}.mp4`
          const ref = await attachments.saveFile({ data: buf, name })
          extraBlocks.push({ type: 'file', attachment: ref })
          /** 本地路径：抽帧要把它喂给 PowerShell。 */
          const filePath = typeof attachments.fileHostPath === 'function'
            ? attachments.fileHostPath(ref)
            : undefined
          /**
           * 只存不分析（用户要求：收到视频不要自行分析，以免浪费 token），
           * 记下信息，等用户发 /分析 再抽帧。
           */
          const history = videoHistory.get(userId) ?? []
          history.unshift({
            path: filePath,
            name,
            bytes: buf.length,
            playLength: it.play_length,
            at: Date.now(),
          })
          videoHistory.set(userId, history.slice(0, VIDEO_HISTORY_MAX))
          log.info(`视频已存(未分析) from=${userId} name=${name} bytes=${buf.length} path=${filePath ?? '(无本地路径)'}`)
          textParts.push(
            `[用户发来一段视频，已保存为 ${name}（${buf.length} 字节${lenText}）。`
            + '按用户要求：我**没有**抽取画面，也看不到内容。'
            + '如果用户要我看，需要用户明确说「分析视频」（或发 /分析），我再抽帧。]',
          )
        }
      } catch (error) {
        log.error(`媒体处理失败 type=${item.type}: ${String(error)}`)
        textParts.push(`[媒体处理失败：${String(error).slice(0, 150)}]`)
      }
    }

    const blocks = []
    if (textParts.length) blocks.push({ type: 'text', text: textParts.join('\n') })
    return blocks.concat(extraBlocks)
  }

  // ── 入站 ──────────────────────────────────────────────────────────────────

  async function processMessage(message) {
    const userId = message.from_user_id ?? ''
    if (!userId) return

    if (!isAllowed(userId)) {
      log.warn(`丢弃未授权消息 from=${userId}`)
      return
    }

    const contextToken = message.context_token
    if (contextToken) store.setContextToken(account.accountId, userId, contextToken)

    const text = extractText(message)
    const mediaItems = (message.item_list ?? []).filter(isMediaItem)
    log.info(`入站 from=${userId} textLen=${text.length} media=${mediaItems.length} hasContextToken=${Boolean(contextToken)}`)
    // 侦察：把入站媒体的真实字段结构写进审计日志，便于核对协议假设
    for (const item of mediaItems) log.info(`媒体侦察 ${JSON.stringify(describeMediaItem(item))}`)
    if (!text && mediaItems.length === 0) return

    // 视频抽帧数指令：`/frames N`（也认中文「帧数 N」）。1~16 之间，超出钳制。
    // 只影响之后的视频，所以立刻回执并终止本轮，不进模型。
    const framesMatch = /^\s*(?:\/frames|帧数|抽帧数)\s*[:：]?\s*(\d{1,3})\s*$/i.exec(text)
    if (framesMatch) {
      const wanted = Math.min(16, Math.max(1, Number.parseInt(framesMatch[1], 10)))
      videoFrameOverride.set(userId, wanted)
      log.info(`收到抽帧数指令 from=${userId} frames=${wanted}`)
      await sendReply(
        userId,
        contextToken,
        `已设置：之后分析视频时取 ${wanted} 帧（均匀分布${wanted >= 3 ? ' + 场景变化处补帧' : ''}）。\n发 /frames 3 可改回默认。`,
      )
      return
    }

    // 视频指令：收到视频默认只存不分析，这里是唯一触发分析的入口。
    //   `/分析` / `分析视频` / `/analyze`        → 分析最近 1 条
    //   `/分析 2`                                → 分析倒数第 2 条
    //   `/视频信息`(/videoinfo)                  → 只报信息
    //   `/视频列表`(/videos)                     → 列最近几条
    const infoMatch = /^\s*(?:\/videoinfo|\/视频信息|视频信息|视频详情)\s*$/i.exec(text)
    const listMatch = /^\s*(?:\/videos|\/视频列表|视频列表)\s*$/i.exec(text)
    const analyzeMatch = /^\s*(?:\/analyze|\/分析|分析视频|\/分析视频|看看视频|看视频)\s*(?:(\d{1,2}))?\s*$/i.exec(text)
    if (infoMatch || listMatch) {
      const history = videoHistory.get(userId) ?? []
      if (history.length === 0) {
        await sendReply(userId, contextToken, '还没有收到过视频。')
        return
      }
      if (listMatch) {
        await sendReply(userId, contextToken, history
          .map((v, i) => `${i + 1}. ${v.name}（${v.bytes} 字节${v.playLength ? `，${v.playLength}s` : ''}）`)
          .join('\n'))
        return
      }
      const v = history[0]
      await sendReply(
        userId,
        contextToken,
        `最近一条视频：\n文件名：${v.name}\n大小：${v.bytes} 字节\n时长：${v.playLength ?? '(未知)'}\n本地路径：${v.path ?? '(无)'}\n\n发 /分析 我抽帧看内容。`,
      )
      return
    }
    if (analyzeMatch) {
      const history = videoHistory.get(userId) ?? []
      if (history.length === 0) {
        await sendReply(userId, contextToken, '我还没收到过视频，先发一条吧。')
        return
      }
      const idx = analyzeMatch[1] ? Math.max(1, Number.parseInt(analyzeMatch[1], 10)) : 1
      const v = history[idx - 1]
      if (!v) {
        await sendReply(userId, contextToken, `只存了最近 ${history.length} 条视频，没有第 ${idx} 条。发 /视频列表 看有哪些。`)
        return
      }
      if (!v.path) {
        await sendReply(userId, contextToken, `这条视频没有本地路径（${v.name}），取不到画面，没法分析。`)
        return
      }
      const wanted = Math.min(16, Math.max(1,
        videoFrameOverride.get(userId) ?? config.videoFrameCount ?? 3))
      const sceneExtra = wanted >= 3 ? Math.max(0, config.videoSceneExtra ?? 2) : 0
      const durationSec = Number(v.playLength) || undefined
      log.info(`收到分析指令 from=${userId} video=${v.name} frames=${wanted}+${sceneExtra}`)
      const stopTypingAnalyze = startTyping(userId, contextToken)
      try {
        const sheet = await extractVideoSheetPng({
          videoPath: v.path,
          seconds: evenTimestamps(durationSec, wanted),
          columns: wanted,
          tileWidth: config.videoFrameTileWidth ?? 640,
          tileHeight: config.videoFrameTileHeight ?? 360,
          duration: durationSec,
          sceneExtra,
          log,
        })
        if (!sheet) {
          await sendReply(userId, contextToken, `抽帧失败（${v.name}）。可能是编码不支持，或解码路径不可用。`)
          return
        }
        // 宫格同时做两件事：作为原生图片进本轮上下文交给我分析；存成附件后回发给你看。
        let imgRef
        try {
          imgRef = await attachments.saveImage({ data: sheet, mediaType: 'image/png' })
        } catch (error) {
          log.warn(`分析图 saveImage 被拒: ${String(error)}`)
        }
        const caption = `视频分析：${v.name}（${v.bytes} 字节${v.playLength ? `，${v.playLength}s` : ''}）\n`
          + `抽了 ${wanted} 帧${sceneExtra ? `（含场景变化处补 ${sceneExtra} 帧）` : ''}，宫格见下。`
        const content = [{ type: 'text', text: `${caption}\n请分析这段视频的画面内容与变化。` }]
        if (imgRef) content.push({ type: 'image', attachment: imgRef })

        const { reply } = await runTurn({ userId, content, preview: `视频分析 ${v.name}` })
        if (reply?.trim()) await sendReply(userId, contextToken, reply)
        const hostPath = imgRef && typeof attachments.imageHostPath === 'function'
          ? attachments.imageHostPath(imgRef)
          : undefined
        if (hostPath) {
          try {
            await sendLocalFile(userId, contextToken, hostPath)
          } catch (error) {
            log.error(`回发宫格失败 path=${hostPath}: ${String(error)}`)
          }
        }
      } finally {
        await stopTypingAnalyze()
      }
      return
    }

    // 开新对话：只解除映射，不销毁旧会话（旧对话仍在 DSH 会话列表里可查）
    if (NEW_CHAT_RE.test(text)) {
      const previous = store.getSessionId(account.accountId, userId)
      store.clearSessionId(account.accountId, userId)
      liveHandles.delete(userId)
      log.info(`收到开新对话指令 from=${userId} previous=${previous ?? '(无)'}`)
      await sendReply(userId, contextToken, previous
        ? `已开启新对话。\n旧会话（${previous}）仍可在 DSH 会话列表中查看。下一条消息将在新会话里回答。`
        : '已就绪。下一条消息将开启一个新会话。')
      return
    }

    if (text.startsWith('/status')) {
      const sid = store.getSessionId(account.accountId, userId) ?? '(尚未建立)'
      await sendReply(userId, contextToken, `账号：${account.accountId}\n当前会话：${sid}\n权限：${config.permissionPreset}`)
      return
    }

    const content = await buildContentBlocks({ userId, text, mediaItems })
    if (content.length === 0) {
      log.warn(`入站消息未能构造出任何内容块（text 与媒体都为空），跳过 from=${userId}`)
      return
    }

    const stopTyping = startTyping(userId, contextToken)
    try {
      if (config.replyProgress) await sendReply(userId, contextToken, '收到，正在处理…')
      const preview = (text || '[媒体]').replace(/\s+/g, ' ').slice(0, 24)
      const { sessionId, reply } = await runTurn({ userId, content, preview })

      // 出站媒体：先从正文里剥离 `MEDIA:<路径>` 指令，再发文字，最后逐个上传发送
      const { paths, cleaned } = extractMediaDirectives(reply)
      if (cleaned) await sendReply(userId, contextToken, cleaned)
      for (const filePath of paths) {
        try {
          await sendLocalFile(userId, contextToken, filePath)
        } catch (error) {
          log.error(`出站媒体失败 path=${filePath}: ${String(error)}`)
          await sendReply(userId, contextToken, `⚠️ 发送文件失败：${filePath}\n${String(error).slice(0, 200)}`).catch(() => {})
        }
      }
      if (!cleaned && paths.length === 0) {
        await sendReply(userId, contextToken, `（本轮没有产出文本回复，会话：${sessionId}）`)
      }
    } catch (error) {
      log.error(`处理消息失败 from=${userId}: ${String(error)}`)
      await sendReply(userId, contextToken, `⚠️ 处理失败：${String(error).slice(0, 300)}`).catch(() => {})
    } finally {
      await stopTyping()
    }
  }

  async function greet() {
    const userId = account.userId
    if (!userId) {
      log.info('账号未记录 userId，跳过启动问候')
      return
    }
    const contextToken = store.getContextToken(account.accountId, userId)
    const known = store.getSessionId(account.accountId, userId)
    try {
      await sendReply(
        userId,
        contextToken,
        known
          ? `微信通道已连接 ✅ 将继续使用原会话（${known}）。发「新对话」可另起一个新会话。`
          : '微信通道已连接 ✅ 直接发消息即可。发「新对话」可另起一个新会话。',
      )
      log.info(`启动问候已发送 to=${userId} knownSession=${known ?? '(无)'}`)
    } catch (error) {
      log.warn(`启动问候发送失败（不影响接收消息）: ${String(error)}`)
    }
  }

  return { processMessage, mediaDir, appId, greet }
}
