/**
 * 出站守卫：节流、断路器、令牌新鲜度、发送台账。
 *
 * 存在的理由（2026-09-13 实测教训）：
 *   在一个会被限流的通道上密集发送，会**一边测一边污染测试环境**——
 *   后半段所有发送都失败，还查不出原因。因此把所有出站收敛到这一层：
 *     - 令牌过期就**不带令牌**发（实测：过期令牌会被拒 ret=-2，而不带令牌可发）
 *     - 强制最小发送间隔（防止突发）
 *     - 连续失败进入**冷却**（断路器），而不是继续猛撞
 *     - 每次发送写台账（含令牌年龄、配方、结果），便于事后一次对比
 */

import fs from 'node:fs'
import path from 'node:path'

export function createOutboundGuard({
  store,
  accountId,
  log,
  ledgerPath,
  minIntervalMs = 1500,
  staleTokenMs = 10 * 60_000,
  maxConsecutiveFailures = 3,
  cooldownMs = 5 * 60_000,
} = {}) {
  let lastSendAt = 0
  let consecutiveFailures = 0
  let pausedUntil = 0

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function tokenAgeMs() {
    try {
      return store?.contextTokenAgeMs?.(accountId)
    } catch {
      return undefined
    }
  }

  function appendLedger(entry) {
    if (!ledgerPath) return
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
      fs.appendFileSync(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf-8')
    } catch {
      // 台账失败不影响业务
    }
  }

  return {
    /** 发送前的门禁：冷却检查 + 节流 + 令牌新鲜度判定。返回实际要用的令牌（可能为 undefined）。 */
    async beforeSend(userId, contextToken, label) {
      const now = Date.now()
      if (now < pausedUntil) {
        const rest = Math.ceil((pausedUntil - now) / 1000)
        throw new Error(`出站处于冷却期（连续失败 ${consecutiveFailures} 次），剩余 ${rest}s`)
      }
      const wait = minIntervalMs - (now - lastSendAt)
      if (wait > 0) await sleep(wait)
      lastSendAt = Date.now()

      let token = contextToken
      if (token) {
        const age = tokenAgeMs()
        if (age !== undefined && age > staleTokenMs) {
          log?.warn?.(`${label}: 令牌已 ${Math.round(age / 60_000)} 分钟（阈值 ${Math.round(staleTokenMs / 60_000)}），按过期处理 → 不带令牌发送`)
          token = undefined
        }
      }
      return token
    },

    ageMs: tokenAgeMs,

    onSuccess(label, detail) {
      consecutiveFailures = 0
      appendLedger({ label, ...detail, ok: true, tokenAgeMs: tokenAgeMs() })
    },

    onFailure(label, detail, error) {
      const text = String(error)
      const recoverable = text.includes('ret=-2') || text.includes('prepare failed')
      if (recoverable) {
        consecutiveFailures += 1
        if (consecutiveFailures >= maxConsecutiveFailures) {
          pausedUntil = Date.now() + cooldownMs
          log?.error?.(
            `${label}: 连续 ${consecutiveFailures} 次可恢复失败 → 暂停出站 ${Math.round(cooldownMs / 60_000)} 分钟（疑似限流/令牌风暴）`,
          )
        }
      }
      appendLedger({ label, ...detail, ok: false, tokenAgeMs: tokenAgeMs(), error: text.slice(0, 300) })
    },

    ledger: appendLedger,

    /** 只读状态，便于诊断。 */
    state() {
      return { consecutiveFailures, pausedForMs: Math.max(0, pausedUntil - Date.now()), lastSendAt }
    },
  }
}
