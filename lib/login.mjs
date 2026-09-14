/**
 * 扫码登录流程。
 *
 * 移植自 @tencent-weixin/openclaw-weixin@2.4.8 的 src/auth/login-qr.ts（原文件 16.7KB）。
 * 该文件【不依赖任何 openclaw 模块】——本骨架只做两处宿主化改动：
 *   1. 读验证码从「直接读 stdin」改为可注入的 onVerifyCode 回调（宿主可能无 TTY）
 *   2. 展示二维码从「直接打 stdout」改为回传 URL + 可选 onQrcode 回调
 *
 * 状态机（与原实现完全一致）：
 *   wait / scaned / confirmed / expired / scaned_but_redirect
 *   need_verifycode / verify_code_blocked / binded_redirect
 */

import { randomUUID } from 'node:crypto'

import { FIXED_BASE_URL, fetchQRCode, pollQRStatus } from './ilink.mjs'

export const DEFAULT_ILINK_BOT_TYPE = '3'
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const MAX_QR_REFRESH_COUNT = 3
const DEFAULT_LOGIN_TIMEOUT_MS = 480_000

const activeLogins = new Map()

function isFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS
}

function purgeExpired() {
  for (const [key, login] of activeLogins) {
    if (!isFresh(login)) activeLogins.delete(key)
  }
}

/** 默认的终端二维码展示：qrcode-terminal 缺失时退回打印链接。 */
export async function displayQRCode(qrcodeUrl) {
  try {
    const qrterm = await import('qrcode-terminal')
    qrterm.default.generate(qrcodeUrl, { small: true })
  } catch {
    // 无 qrcode-terminal：只打印链接
  }
  process.stdout.write('若二维码未能显示，可访问以下链接继续：\n')
  process.stdout.write(`${qrcodeUrl}\n`)
}

/** 默认的验证码读取（确认码场景）：宿主无 TTY 时请传 onVerifyCode。 */
async function readVerifyCodeFromStdin(prompt) {
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    let input = ''
    const onData = (chunk) => {
      input += chunk.toString()
      if (input.includes('\n')) {
        process.stdin.removeListener('data', onData)
        process.stdin.pause()
        resolve(input.trim())
      }
    }
    process.stdin.resume()
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', onData)
  })
}

/**
 * 第一步：取二维码。
 * @returns {{qrcodeUrl?: string, message: string, sessionKey: string}}
 */
export async function startWeixinLogin({
  accountId,
  apiBaseUrl = FIXED_BASE_URL,
  botType = DEFAULT_ILINK_BOT_TYPE,
  force = false,
  localTokenList = [],
} = {}) {
  const sessionKey = accountId || randomUUID()
  purgeExpired()

  const existing = activeLogins.get(sessionKey)
  if (!force && existing && isFresh(existing) && existing.qrcodeUrl) {
    return { qrcodeUrl: existing.qrcodeUrl, message: '二维码已显示，请用手机微信扫描。', sessionKey }
  }

  try {
    const qr = await fetchQRCode({ baseUrl: FIXED_BASE_URL, botType, localTokenList })
    const login = {
      sessionKey,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      currentApiBaseUrl: FIXED_BASE_URL,
    }
    activeLogins.set(sessionKey, login)
    return { qrcodeUrl: login.qrcodeUrl, message: '用手机微信扫描以下二维码，以继续连接：', sessionKey }
  } catch (error) {
    return { message: `获取二维码失败: ${String(error)}`, sessionKey }
  }
}

async function refreshQR(login, botType, count, onQrcode) {
  if (count > MAX_QR_REFRESH_COUNT) return { success: false, message: '二维码多次失效，连接流程已停止。' }
  try {
    const qr = await fetchQRCode({ baseUrl: FIXED_BASE_URL, botType })
    login.qrcode = qr.qrcode
    login.qrcodeUrl = qr.qrcode_img_content
    login.startedAt = Date.now()
    if (onQrcode) await onQrcode(qr.qrcode_img_content)
    else await displayQRCode(qr.qrcode_img_content)
    return { success: true }
  } catch (error) {
    return { success: false, message: `刷新二维码失败: ${String(error)}` }
  }
}

/**
 * 第二步：轮询登录状态直到成功/超时。
 *
 * @param {object} opts
 * @param {string} opts.sessionKey            startWeixinLogin 返回
 * @param {number} [opts.timeoutMs]           默认 480s
 * @param {(prompt: string) => Promise<string>} [opts.onVerifyCode] 手机确认码输入
 * @param {(url: string) => Promise<void>}     [opts.onQrcode]      二维码展示
 * @returns {Promise<{connected: boolean, alreadyConnected?: boolean, botToken?: string,
 *                    accountId?: string, baseUrl?: string, userId?: string, message: string}>}
 */
export async function waitForWeixinLogin({
  sessionKey,
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  onVerifyCode,
  onQrcode,
  onStatus,
  botType = DEFAULT_ILINK_BOT_TYPE,
}) {
  const login = activeLogins.get(sessionKey)
  if (!login) return { connected: false, message: '当前没有进行中的登录，请先发起登录。' }
  if (!isFresh(login)) {
    activeLogins.delete(sessionKey)
    return { connected: false, message: '二维码已过期，请重新生成。' }
  }

  const deadline = Date.now() + Math.max(timeoutMs, 1000)
  let qrRefreshCount = 1
  let lastStatus

  while (Date.now() < deadline) {
    const status = await pollQRStatus({
      baseUrl: login.currentApiBaseUrl ?? FIXED_BASE_URL,
      qrcode: login.qrcode,
      verifyCode: login.pendingVerifyCode,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
    })

    if (status.status !== lastStatus) {
      lastStatus = status.status
      // 状态跃迁落盘，便于事后判断「用户到底扫没扫」
      try {
        onStatus?.(status.status, status)
      } catch {
        // 观测回调失败不影响登录
      }
    }

    switch (status.status) {
      case 'wait':
        break

      case 'scaned':
        // 带验证码却返回 scaned ⇒ 验证码正确，清除暂存
        login.pendingVerifyCode = undefined
        break

      case 'need_verifycode': {
        if (!onVerifyCode) {
          activeLogins.delete(sessionKey)
          return { connected: false, message: '服务端要求输入手机确认码，但未提供 onVerifyCode 回调。' }
        }
        const prompt = login.pendingVerifyCode ? '❌ 数字不匹配，请重新输入：' : '输入手机微信显示的数字：'
        login.pendingVerifyCode = await onVerifyCode(prompt)
        continue
      }

      case 'expired':
      case 'verify_code_blocked': {
        login.pendingVerifyCode = undefined
        qrRefreshCount += 1
        const refreshed = await refreshQR(login, botType, qrRefreshCount, onQrcode)
        if (!refreshed.success) {
          activeLogins.delete(sessionKey)
          return { connected: false, message: refreshed.message }
        }
        break
      }

      case 'binded_redirect':
        // 该 bot 已绑定过本机：本地凭据仍有效，视为「已完成」
        activeLogins.delete(sessionKey)
        return { connected: false, alreadyConnected: true, message: '该微信已连接过本机，无需重复连接。' }

      case 'scaned_but_redirect':
        if (status.redirect_host) login.currentApiBaseUrl = `https://${status.redirect_host}`
        break

      case 'confirmed': {
        if (!status.ilink_bot_id) {
          activeLogins.delete(sessionKey)
          return { connected: false, message: '登录失败：服务器未返回 ilink_bot_id。' }
        }
        activeLogins.delete(sessionKey)
        return {
          connected: true,
          botToken: status.bot_token,
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl,
          userId: status.ilink_user_id,
          message: '已连接。',
        }
      }

      default:
        break
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  activeLogins.delete(sessionKey)
  return { connected: false, message: '登录超时，请重试。' }
}
