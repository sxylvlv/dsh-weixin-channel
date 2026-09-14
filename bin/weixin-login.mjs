#!/usr/bin/env node
/**
 * 独立扫码登录 CLI —— 不需要 DSH 运行。
 *
 *   node bin/weixin-login.mjs            登录/新增一个微信号
 *   node bin/weixin-login.mjs --force    强制重新取码
 *
 * 二维码同时以三种方式给出：
 *   1. 终端 ASCII（qrcode-terminal，可选依赖）
 *   2. PNG 文件 <DSH_HOME>/weixin/login-qr.png（qrcode，可选依赖）
 *   3. 原始链接
 * 成功后 token 写入 <DSH_HOME>/weixin/accounts/<accountId>.json（chmod 0600），
 * 并把扫码者加入 allowFrom。
 */

import fs from 'node:fs'
import path from 'node:path'

import { createStore, normalizeAccountId } from '../lib/store.mjs'
import { displayQRCode, startWeixinLogin, waitForWeixinLogin } from '../lib/login.mjs'
import { makeLog } from '../lib/log.mjs'

const log = makeLog('login')

function parseArgs(argv) {
  const out = { force: false, accountId: undefined, timeoutMinutes: 60, once: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') out.force = true
    else if (argv[i] === '--once') out.once = true
    else if (argv[i] === '--account') out.accountId = argv[++i]
    else if (argv[i] === '--timeout-minutes') out.timeoutMinutes = Number(argv[++i]) || 60
  }
  return out
}

async function readLine(prompt) {
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

/** 二维码额外产出 PNG，方便在电脑屏幕上用手机扫。 */
async function writeQrPng(url, filePath) {
  try {
    const mod = await import('qrcode')
    const qrcode = mod.default ?? mod
    await qrcode.toFile(filePath, url, { width: 420, margin: 1 })
    return filePath
  } catch (error) {
    log.warn(`未能生成 PNG（缺 qrcode 依赖）: ${String(error)}`)
    return undefined
  }
}

/**
 * 取手机确认码。
 * 交互终端直接读 stdin；**非交互环境（后台任务）改读文件通道**，
 * 否则 readLine 会永久挂住，扫码流程静默卡死。
 */
async function readVerifyCode(prompt, stateDir) {
  if (process.stdin.isTTY) return readLine(prompt)

  const file = path.join(stateDir, 'verify-code.txt')
  try { fs.unlinkSync(file) } catch { }
  process.stdout.write(`\n${prompt}\n`)
  process.stdout.write(`[非交互环境] 请把手机上显示的数字写入: ${file}\n\n`)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      if (fs.existsSync(file)) {
        const code = fs.readFileSync(file, 'utf-8').trim()
        if (code) {
          fs.unlinkSync(file)
          return code
        }
      }
    } catch {
      // 继续等待
    }
  }
  return ''
}

function appendProgress(stateDir, line) {
  try {
    fs.appendFileSync(
      path.join(stateDir, 'login-progress.log'),
      `[${new Date().toISOString()}] ${line}\n`,
      'utf-8',
    )
  } catch {
    // 观测失败不影响登录
  }
}

/** 一轮登录尝试。返回 'connected' | 'already' | 'retry' */
async function attemptLogin({ args, store, localTokenList, pngPath }) {
  const start = await startWeixinLogin({ accountId: args.accountId, force: true, localTokenList })
  if (!start.qrcodeUrl) {
    log.error(start.message)
    appendProgress(store.root, `start-failed: ${start.message}`)
    return 'retry'
  }

  const showQr = async (url) => {
    process.stdout.write('\n用手机微信扫描以下二维码：\n\n')
    await displayQRCode(url)
    await writeQrPng(url, pngPath)
    try { fs.writeFileSync(path.join(store.root, 'login-qr-url.txt'), url, 'utf-8') } catch { }
    process.stdout.write(`\n二维码图片(已更新): ${pngPath}\n原始链接: ${url}\n\n`)
    appendProgress(store.root, `qr-issued: ${url}`)
  }

  await showQr(start.qrcodeUrl)

  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    timeoutMs: args.timeoutMinutes * 60_000,
    onVerifyCode: (prompt) => readVerifyCode(prompt, store.root),
    // 二维码过期刷新时，PNG 与终端同步更新，避免扫到过期的码
    onQrcode: showQr,
    onStatus: (status, raw) => appendProgress(store.root, `status=${status}${raw?.redirect_host ? ' redirect=' + raw.redirect_host : ''}`),
  })

  appendProgress(store.root, `round-finished: connected=${result.connected} already=${result.alreadyConnected ?? false} message=${result.message}`)

  if (result.alreadyConnected) {
    log.info(result.message)
    return 'already'
  }
  if (!result.connected) {
    log.warn(`${result.message} —— 将重新生成二维码`)
    return 'retry'
  }

  const accountId = normalizeAccountId(result.accountId)
  store.saveAccount(accountId, { token: result.botToken, baseUrl: result.baseUrl, userId: result.userId })
  store.registerAccountId(accountId)
  if (result.userId) {
    store.clearStaleAccountsForUserId(accountId, result.userId)
    store.appendAllowFrom(accountId, result.userId)
  }

  log.info('登录成功。')
  process.stdout.write(
    `\n  账号 id : ${accountId}\n  网关    : ${result.baseUrl ?? '(默认)'}\n  扫码者  : ${result.userId ?? '(未知，需手动加入 allowFrom)'}\n\n`,
  )
  return 'connected'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const store = createStore({})
  const pngPath = path.join(store.root, 'login-qr.png')
  log.info(`状态目录: ${store.root}`)

  const localTokenList = []
  for (const id of store.listAccountIds().slice(-10)) {
    const token = store.loadAccount(id)?.token?.trim()
    if (token) localTokenList.push(token)
  }

  // 默认常驻：扫码超时/二维码多次失效后自动重新取码，直到登录成功。
  let round = 0
  for (;;) {
    round += 1
    const outcome = await attemptLogin({ args, store, localTokenList, pngPath })
    if (outcome === 'connected' || outcome === 'already') return
    if (args.once) process.exit(1)
    if (round >= 200) {
      log.error('重试次数已达上限，退出。')
      process.exit(1)
    }
    log.info(`第 ${round} 轮未完成，3 秒后重新生成二维码…`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

main().catch((error) => {
  log.error(String(error))
  process.exit(1)
})
