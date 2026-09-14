/**
 * 状态与凭据持久化。
 *
 * 移植自 @tencent-weixin/openclaw-weixin@2.4.8 的
 *   src/storage/state-dir.ts
 *   src/auth/accounts.ts
 *   src/messaging/inbound.ts（context token 部分）
 *   src/storage/sync-buf.ts
 * 并新增 DSH 侧需要的「微信用户 ↔ DSH session」映射。
 *
 * 与原实现的差异：状态根目录从 ~/.openclaw 改为 <DSH_HOME>/weixin，
 * 去掉一切 openclaw.json 读写（含 routeTag / botAgent / triggerWeixinChannelReload）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** <DSH_HOME>/weixin；DSH_HOME 未设时退回 ~/.dsh */
export function resolveStateDir() {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'weixin')
}

function accountsDir() {
  return path.join(resolveStateDir(), 'accounts')
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath, value, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
  if (mode !== undefined) {
    try {
      fs.chmodSync(filePath, mode)
    } catch {
      // best-effort（Windows 上 chmod 语义有限）
    }
  }
}

/**
 * 账号 id 规范化：把 ilink_bot_id 变成文件名安全的形式。
 *
 * ⚠️ 待核（清单 §6-5）：原实现来自 openclaw/plugin-sdk/account-id 的 normalizeAccountId。
 * 已观测到的映射是 `b0f5860fdecb@im.bot` → `b0f5860fdecb-im-bot`（@ 与 . 都变 -）。
 * 该规则决定凭据文件名，**改错就读不到已登录的 token**；下文 deriveRawAccountId 是原实现里的反向兜底。
 */
export function normalizeAccountId(raw) {
  return String(raw).trim().replace(/[^a-zA-Z0-9-]/g, '-')
}

/** 反向映射，用于兼容旧文件名（原实现 src/auth/accounts.ts）。 */
export function deriveRawAccountId(normalizedId) {
  if (normalizedId.endsWith('-im-bot')) return `${normalizedId.slice(0, -7)}@im.bot`
  if (normalizedId.endsWith('-im-wechat')) return `${normalizedId.slice(0, -10)}@im.wechat`
  return undefined
}

export function createStore(config = {}) {
  const root = resolveStateDir()
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true })

  const indexPath = path.join(root, 'accounts.json')
  const accountPath = (id) => path.join(accountsDir(), `${id}.json`)
  const contextPath = (id) => path.join(accountsDir(), `${id}.context-tokens.json`)
  const syncPath = (id) => path.join(accountsDir(), `${id}.sync.json`)
  const allowPath = (id) => path.join(accountsDir(), `${id}.allowFrom.json`)

  /** in-process context_token 缓存，落盘兜底重启（原 inbound.ts 同构）。 */
  const contextTokens = new Map()

  const api = {
    root,

    // ── 账号索引 ────────────────────────────────────────────────────────────
    listAccountIds() {
      const ids = readJson(indexPath, [])
      return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.trim() !== '') : []
    },

    registerAccountId(accountId) {
      const existing = api.listAccountIds()
      if (existing.includes(accountId)) return
      writeJson(indexPath, [...existing, accountId])
    },

    unregisterAccountId(accountId) {
      writeJson(indexPath, api.listAccountIds().filter((id) => id !== accountId))
    },

    // ── 凭据 ────────────────────────────────────────────────────────────────
    loadAccount(accountId) {
      const primary = readJson(accountPath(accountId), null)
      if (primary) return primary
      const raw = deriveRawAccountId(accountId)
      if (raw) return readJson(accountPath(raw), null)
      return null
    },

    saveAccount(accountId, update) {
      const existing = api.loadAccount(accountId) ?? {}
      const token = update.token?.trim() || existing.token
      const baseUrl = update.baseUrl?.trim() || existing.baseUrl
      const userId =
        update.userId !== undefined ? update.userId.trim() || undefined : existing.userId?.trim() || undefined
      const data = {
        ...(token ? { token, savedAt: new Date().toISOString() } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(userId ? { userId } : {}),
      }
      writeJson(accountPath(accountId), data, 0o600)
    },

    clearAccount(accountId) {
      for (const file of [accountPath(accountId), syncPath(accountId), contextPath(accountId), allowPath(accountId)]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // ignore
        }
      }
      for (const key of [...contextTokens.keys()]) {
        if (key.startsWith(`${accountId}:`)) contextTokens.delete(key)
      }
    },

    /** 同一 userId 重复登录时清掉旧账号，避免 context_token 归属二义。 */
    clearStaleAccountsForUserId(currentAccountId, userId) {
      if (!userId) return
      for (const id of api.listAccountIds()) {
        if (id === currentAccountId) continue
        if (api.loadAccount(id)?.userId?.trim() === userId) {
          api.clearAccount(id)
          api.unregisterAccountId(id)
        }
      }
    },

    /**
     * 解析出当前要使用的账号。
     * @returns {{accountId, baseUrl, cdnBaseUrl, token, userId}} | undefined
     */
    resolveAccount(preferredId) {
      const wanted = preferredId?.trim()
      const candidates = wanted ? [normalizeAccountId(wanted)] : api.listAccountIds()
      for (const id of candidates) {
        const data = api.loadAccount(id)
        const token = data?.token?.trim()
        if (!token) continue
        return {
          accountId: id,
          baseUrl: data.baseUrl?.trim() || DEFAULT_BASE_URL,
          cdnBaseUrl: config.cdnBaseUrl?.trim() || CDN_BASE_URL,
          token,
          userId: data.userId?.trim(),
        }
      }
      return undefined
    },

    // ── context_token（回发消息必须原样带回）───────────────────────────────
    setContextToken(accountId, userId, token) {
      contextTokens.set(`${accountId}:${userId}`, token)
      const prefix = `${accountId}:`
      const out = {}
      for (const [k, v] of contextTokens) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
      writeJson(contextPath(accountId), out)
    },

    getContextToken(accountId, userId) {
      return contextTokens.get(`${accountId}:${userId}`)
    },

    /**
     * 缓存令牌的年龄（毫秒）。用凭据文件 mtime 推断——
     * 每次 setContextToken 都会重写该文件，所以 mtime 就是最近一次入站消息的时间。
     * 实测：令牌约十余分钟后失效，此时 sendmessage 会回 ret=-2 prepare failed。
     */
    contextTokenAgeMs(accountId) {
      try {
        return Date.now() - fs.statSync(contextPath(accountId)).mtimeMs
      } catch {
        return undefined
      }
    },

    restoreContextTokens(accountId) {
      const saved = readJson(contextPath(accountId), {})
      for (const [userId, token] of Object.entries(saved)) {
        if (typeof token === 'string' && token) contextTokens.set(`${accountId}:${userId}`, token)
      }
    },

    // ── 长轮询游标 ──────────────────────────────────────────────────────────
    loadSyncBuf(accountId) {
      return readJson(syncPath(accountId), { get_updates_buf: '' })?.get_updates_buf ?? ''
    },

    saveSyncBuf(accountId, getUpdatesBuf) {
      writeJson(syncPath(accountId), { get_updates_buf: getUpdatesBuf })
    },

    // ── 白名单（移植自 src/auth/pairing.ts 的语义）─────────────────────────
    readAllowFrom(accountId) {
      const stored = readJson(allowPath(accountId), [])
      if (Array.isArray(stored) && stored.length > 0) return stored
      const uid = api.loadAccount(accountId)?.userId?.trim()
      return uid ? [uid] : []
    },

    appendAllowFrom(accountId, userId) {
      if (!userId) return
      const current = api.readAllowFrom(accountId)
      if (current.includes(userId)) return
      writeJson(allowPath(accountId), [...current, userId])
    },

    // ── 微信用户 ↔ DSH session 映射（DSH 侧新增）────────────────────────────
    sessionMapPath() {
      return path.join(root, 'sessions.json')
    },

    getSessionId(accountId, userId) {
      const map = readJson(api.sessionMapPath(), {})
      return map[`${accountId}:${userId}`]
    },

    setSessionId(accountId, userId, sessionId) {
      const map = readJson(api.sessionMapPath(), {})
      map[`${accountId}:${userId}`] = sessionId
      writeJson(api.sessionMapPath(), map)
    },

    clearSessionId(accountId, userId) {
      const map = readJson(api.sessionMapPath(), {})
      delete map[`${accountId}:${userId}`]
      writeJson(api.sessionMapPath(), map)
    },
  }

  return api
}
