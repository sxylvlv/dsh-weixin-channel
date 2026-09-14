/**
 * 腾讯 ilink bot HTTP 客户端。
 *
 * 端点、请求头、base_info 均已于 2026 年从插件源码 src/api/api.ts（v2.4.8）核对确认：
 *   所有端点前缀统一为 ilink/bot/
 *   每个请求体都必须携带 base_info = { channel_version, bot_agent }
 *   请求头必须携带 iLink-App-Id / iLink-App-ClientVersion
 */

import { randomBytes } from 'node:crypto'

export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
export const DEFAULT_API_TIMEOUT_MS = 15_000
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000
/** README 举例 -14 = 会话超时；原实现以此判定令牌失效。 */
export const STALE_TOKEN_ERRCODE = -14

/**
 * iLink-App-Id：原插件 package.json 顶层 ilink_appid 字段，值为 "bot"。
 * 若服务端拒绝非 OpenClaw 宿主，这里是最可能的拒绝点之一，可通过 config 覆盖排查。
 */
export const DEFAULT_APP_ID = 'bot'
export const CHANNEL_VERSION = '0.1.0'
export const DEFAULT_BOT_AGENT = 'DSH-Weixin-Channel/0.1.0'

/** uint32 = 0x00MMNNPP，与原实现 buildClientVersion 一致。 */
export function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((p) => parseInt(p, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')
}

export function buildBaseInfo(botAgent = DEFAULT_BOT_AGENT) {
  return { channel_version: CHANNEL_VERSION, bot_agent: botAgent }
}

function buildHeaders(opts) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': opts.appId ?? DEFAULT_APP_ID,
    'iLink-App-ClientVersion': String(opts.appClientVersion ?? buildClientVersion(CHANNEL_VERSION)),
  }
  if (opts.token?.trim()) headers.Authorization = `Bearer ${opts.token.trim()}`
  return headers
}

function joinUrl(baseUrl, endpoint) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(endpoint).replace(/^\/+/, '')}`
}

async function request({ baseUrl, endpoint, method, body, token, timeoutMs, signal, label, appId, appClientVersion }) {
  const signals = []
  if (signal) signals.push(signal)
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))

  const response = await fetch(joinUrl(baseUrl, endpoint), {
    method,
    headers: buildHeaders({ token, appId, appClientVersion }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`)
  return text
}

export async function apiGetFetch({ baseUrl, endpoint, timeoutMs, label, appId, appClientVersion }) {
  return request({ baseUrl, endpoint, method: 'GET', timeoutMs, label, appId, appClientVersion })
}

export async function apiPostFetch({ baseUrl, endpoint, body, token, timeoutMs, signal, label, appId, appClientVersion }) {
  return request({ baseUrl, endpoint, method: 'POST', body, token, timeoutMs, signal, label, appId, appClientVersion })
}

// ── 扫码登录（路径已核对：ilink/bot/get_bot_qrcode、ilink/bot/get_qrcode_status）──

export async function fetchQRCode({ baseUrl = FIXED_BASE_URL, botType = '3', localTokenList = [] }) {
  const raw = await apiPostFetch({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokenList },
    label: 'fetchQRCode',
  })
  return JSON.parse(raw)
}

export async function pollQRStatus({ baseUrl = FIXED_BASE_URL, qrcode, verifyCode, timeoutMs = 35_000 }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
  try {
    const raw = await apiGetFetch({ baseUrl, endpoint, timeoutMs, label: 'pollQRStatus' })
    return JSON.parse(raw)
  } catch (error) {
    // 网关超时 / 客户端超时都按「等待」处理，与原实现一致
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { status: 'wait' }
    return { status: 'wait' }
  }
}

// ── 消息收发 ────────────────────────────────────────────────────────────────

/**
 * 长轮询取消息。
 * 客户端超时/外部 abort 都是长轮询的正常退出路径 → 返回空响应，与原实现一致。
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = '', timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS, signal, botAgent }) {
  try {
    const raw = await apiPostFetch({
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      token,
      body: { get_updates_buf: getUpdatesBuf ?? '', base_info: buildBaseInfo(botAgent) },
      timeoutMs,
      signal,
      label: 'getUpdates',
    })
    return JSON.parse(raw)
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
    }
    throw error
  }
}

export async function sendMessage({ baseUrl, token, msg, timeoutMs = DEFAULT_API_TIMEOUT_MS, botAgent }) {
  const raw = await apiPostFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token,
    body: { msg, base_info: buildBaseInfo(botAgent) },
    timeoutMs,
    label: 'sendmessage',
  })
  const resp = JSON.parse(raw)
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
  }
  return resp
}

/** 客户端消息 id；格式与源实现 generateId 一致：`{prefix}:{timestamp}-{8位hex}`。 */
export function generateClientId() {
  return `dsh-weixin:${Date.now()}-${randomBytes(4).toString('hex')}`
}

/** 发文本。
 * msg 形状**必须与源实现 buildTextMessageReq 一致**：
 * 除 README 记录的 to_user_id/item_list/context_token 外，还必需
 * from_user_id / client_id / message_type=BOT / message_state=FINISH，
 * 否则服务端可能拒绝或异常路由（会话建了却没有回复）。
 */
export async function sendText({ baseUrl, token, toUserId, text, contextToken, botAgent, runId }) {
  const msg = {
    from_user_id: '',
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: 2, // MessageType.BOT
    message_state: 2, // MessageState.FINISH
    item_list: [{ type: 1, text_item: { text } }],
    context_token: contextToken ?? undefined,
    run_id: runId ?? undefined,
  }
  return sendMessage({ baseUrl, token, msg, botAgent })
}

export async function getConfig({ baseUrl, token, ilinkUserId, contextToken, botAgent }) {  const raw = await apiPostFetch({
    baseUrl,
    endpoint: 'ilink/bot/getconfig',
    token,
    body: { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: buildBaseInfo(botAgent) },
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getconfig',
  })
  return JSON.parse(raw)
}

/** status: 1 正在输入 / 2 取消。 */
export async function sendTyping({ baseUrl, token, ilinkUserId, typingTicket, status, botAgent }) {
  await apiPostFetch({
    baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    token,
    body: { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: buildBaseInfo(botAgent) },
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'sendtyping',
  })
}

/** 路径已核对：ilink/bot/msg/notifystart、ilink/bot/msg/notifystop。失败不致命。 */
export async function notifyStart({ baseUrl, token, botAgent }) {
  try {
    const raw = await apiPostFetch({
      baseUrl,
      endpoint: 'ilink/bot/msg/notifystart',
      token,
      body: { base_info: buildBaseInfo(botAgent) },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: 'notifystart',
    })
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function notifyStop({ baseUrl, token, botAgent }) {
  try {
    const raw = await apiPostFetch({
      baseUrl,
      endpoint: 'ilink/bot/msg/notifystop',
      token,
      body: { base_info: buildBaseInfo(botAgent) },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: 'notifystop',
    })
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * 取 CDN 上传预签名参数。
 * 请求体字段与源实现 src/cdn/upload.ts 一致（no_need_thumb: true，aeskey 为 hex）。
 * 返回 upload_full_url（优先）或 upload_param；下载参数在真正上传后由
 * CDN 响应的 `x-encrypted-param` 头给出。
 */
export async function getUploadUrl({ baseUrl, token, filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskeyHex, botAgent }) {
  const raw = await apiPostFetch({
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    token,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
      base_info: buildBaseInfo(botAgent),
    },
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'getuploadurl',
  })
  return JSON.parse(raw)
}

export function classifyResponse(resp) {
  const ret = resp?.ret
  const errcode = resp?.errcode
  const isError = (ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)
  const isStaleToken = errcode === STALE_TOKEN_ERRCODE || ret === STALE_TOKEN_ERRCODE
  return { isError, isStaleToken }
}
