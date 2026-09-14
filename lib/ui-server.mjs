/**
 * 面板的宿主半：把「微信通道」可视化所需的数据与动作暴露成几个本机 HTTP 路由。
 *
 * 为什么不走 Client→Host 私有 RPC：`harness.handle` / `host.call` 是**动态包专用**的。
 * 固化进插件包后，客户端是一个静态客户端模块（`client/client.js`），拿不到它；
 * 而注册 Remote 服务要走 typert/gateway 生成器，对 out-of-tree 插件不现实。
 * 于是用最朴素的一条路：宿主注册本机路由，客户端同源 fetch。
 *
 * 路由（全部精确匹配，前缀 `/dsh-weixin`）：
 *   GET  /dsh-weixin/status        → 状态 JSON（不含任何 token）
 *   GET  /dsh-weixin/qr.png        → 当前登录二维码 PNG（没有则 404）
 *   POST /dsh-weixin/login-start   → 拉起扫码登录进程
 *   POST /dsh-weixin/login-stop    → 结束登录进程
 *   POST /dsh-weixin/login-verify  → 写入手持设备上的确认码
 *   POST /dsh-weixin/reload        → 换新 id 重挂通道（换号后让它生效）
 *
 * 服务只绑 DSH 自己的本机监听（配置项 host 为 127.0.0.1 时），不额外开端口。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PREFIX = '/dsh-weixin'

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendBytes(res, status, type, bytes) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': bytes.length,
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

/** 读取 POST 的 JSON 体；空体按 {} 处理。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        resolve({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

/** 长串密钥形态的字符串一律遮掉，日志与状态里都不外传。 */
function maskSecret(text) {
  return String(text).replace(/[A-Za-z0-9+/=_-]{40,}/g, '«已脱敏»')
}

export function createUiServer({ ctx, config, store, log, pluginRoot }) {
  const server = ctx.get('webServer')
  if (server === undefined) {
    log.warn?.('[ui] 没有 webServer 服务，面板数据接口未注册（不影响微信通道）')
    return () => {}
  }

  const stateDir = store.root
  const patchPath = path.join(
    process.env.DSH_HOME?.trim() || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'),
    'profiles',
    'web',
    'cordis.patch.yml',
  )
  const loginScript = config.loginScript?.trim()
    ? config.loginScript.trim()
    : path.join(pluginRoot, 'bin', 'weixin-login.mjs')

  let loginChild = null

  function loginRunning() {
    return loginChild !== null && loginChild.exitCode === null && !loginChild.killed
  }

  function collectAccounts() {
    const dir = path.join(stateDir, 'accounts')
    if (!existsSync(dir)) return []
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      if (name.includes('context-tokens') || name.includes('.sync.')) continue
      let data = {}
      try {
        data = JSON.parse(readFileSync(path.join(dir, name), 'utf-8'))
      } catch {
        data = {}
      }
      out.push({
        id: name.replace(/\.json$/, ''),
        userId: typeof data.userId === 'string' ? data.userId : null,
        savedAt: typeof data.savedAt === 'string' ? data.savedAt : null,
      })
    }
    return out
  }

  function collectLog(lines) {
    const text = readTextSafe(path.join(stateDir, 'channel.log'))
    if (text === null) return []
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-lines)
      .map((line) => maskSecret(line.length > 240 ? `${line.slice(0, 240)}…` : line))
  }

  function loginState() {
    const png = path.join(stateDir, 'login-qr.png')
    const url = readTextSafe(path.join(stateDir, 'login-qr-url.txt'))
    const progress = readTextSafe(path.join(stateDir, 'login-progress.log'))
    const progressLines = progress === null
      ? []
      : progress.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).slice(-10)
    return {
      running: loginRunning(),
      hasQr: existsSync(png),
      qrUrl: url === null ? null : url.trim(),
      progressLines,
    }
  }

  function statusPayload() {
    let mount = null
    try {
      mount = JSON.parse(readTextSafe(path.join(stateDir, 'mount-status.json')) ?? 'null')
    } catch {
      mount = null
    }
    const watchdogRaw = readTextSafe(path.join(stateDir, 'watchdog.pid'))
    let watchdogAlive = false
    if (watchdogRaw !== null) {
      const pid = Number.parseInt(watchdogRaw.trim(), 10)
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          watchdogAlive = true
        } catch {
          watchdogAlive = false
        }
      }
    }
    return {
      mount: mount === null ? null : {
        stage: mount.stage ?? null,
        build: mount.build ?? null,
        pid: typeof mount.pid === 'number' ? mount.pid : null,
        accountId: mount.accountId ?? null,
        at: mount.at ?? null,
      },
      accounts: collectAccounts(),
      logLines: collectLog(16),
      watchdog: { alive: watchdogAlive },
      login: loginState(),
    }
  }

  function startLogin() {
    if (loginRunning()) return { ok: true, already: true }
    if (!existsSync(loginScript)) {
      return { ok: false, error: `找不到登录脚本：${loginScript}` }
    }
    log.info?.(`[ui] 拉起扫码登录: ${loginScript}`)
    const child = spawn(process.execPath, [loginScript], {
      cwd: path.dirname(loginScript),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk) => log.warn?.(`[ui] 登录进程 stderr: ${String(chunk).trim().slice(0, 200)}`))
    child.on('exit', (code) => {
      log.info?.(`[ui] 登录进程结束 code=${code}`)
      loginChild = null
    })
    loginChild = child
    return { ok: true }
  }

  function stopLogin() {
    if (!loginRunning()) return { ok: true, already: true }
    try {
      loginChild.kill()
    } catch {
      // 已经退出
    }
    loginChild = null
    return { ok: true }
  }

  /** 换新 id 重挂：同一 id 只换 name 会「拆得掉、插不回」，必须换 id。 */
  async function reloadChannel() {
    const marker = ', { insert: [ { id: weixin-channel'
    let original
    try {
      original = readFileSync(patchPath, 'utf-8')
    } catch (error) {
      return { ok: false, error: `读不到 profile patch：${String(error)}` }
    }
    const at = original.indexOf(marker)
    if (at < 0) return { ok: false, error: 'profile patch 里找不到微信行' }
    const prefix = original.slice(0, at)
    const block = original.slice(at).replace(/\]\s*$/, '').trimEnd()
    const freshId = `weixin-channel-ui${Date.now().toString(36)}`
    const reinsert = block.replace(/id:\s*weixin-channel[a-z0-9-]*/, `id: ${freshId}`)
    writeFileSync(patchPath, `${prefix} ]\n\n`, 'utf-8')
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    writeFileSync(patchPath, `${prefix}${reinsert} ]\n\n`, 'utf-8')
    return { ok: true, newId: freshId }
  }

  const disposers = []

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}/status`,
    handler: (req, res) => sendJson(res, 200, statusPayload()),
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}/qr.png`,
    handler: (req, res) => {
      const file = path.join(stateDir, 'login-qr.png')
      if (!existsSync(file)) return sendBytes(res, 404, 'text/plain; charset=utf-8', Buffer.from('no qr'))
      try {
        return sendBytes(res, 200, 'image/png', readFileSync(file))
      } catch (error) {
        return sendBytes(res, 500, 'text/plain; charset=utf-8', Buffer.from(String(error)))
      }
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}/login-start`,
    handler: async (req, res) => sendJson(res, 200, startLogin()),
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}/login-stop`,
    handler: async (req, res) => sendJson(res, 200, stopLogin()),
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}/login-verify`,
    handler: async (req, res) => {
      const body = await readJsonBody(req)
      const code = String(body.code ?? '').trim()
      if (!/^[0-9]{2,8}$/.test(code)) return sendJson(res, 200, { ok: false, error: '确认码应为 2~8 位数字' })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(path.join(stateDir, 'verify-code.txt'), code, 'utf-8')
      return sendJson(res, 200, { ok: true })
    },
  }))

  disposers.push(server.register({
    kind: 'exact',
    path: `${PREFIX}/reload`,
    handler: async (req, res) => sendJson(res, 200, await reloadChannel()),
  }))

  log.info?.(`[ui] 面板数据接口已注册：${PREFIX}/status · qr.png · login-start · login-stop · login-verify · reload`)

  return () => {
    stopLogin()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载顺序无关紧要
      }
    }
  }
}
