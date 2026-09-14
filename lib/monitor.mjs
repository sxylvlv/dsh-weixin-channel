/**
 * getUpdates 长轮询循环。
 *
 * 移植自 @tencent-weixin/openclaw-weixin@2.4.8 的 src/monitor/monitor.ts（8.5KB）。
 * 原文件只从 openclaw 引入【类型】，循环本身逐行保留：
 *   游标持久化 / longpolling_timeout_ms 自适应 / 3 次失败→30s 退避 / 否则 2s / 失效令牌暂停。
 * 唯一实质改动：每条消息交给 bridge.processMessage（DSH 侧新建会话）。
 */

import { classifyResponse, getUpdates, notifyStart, notifyStop } from './ilink.mjs'

const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000
/** 原实现 src/api/session-guard.ts 的暂停时长未公开；取 30 分钟。 */
const STALE_TOKEN_PAUSE_MS = 30 * 60_000

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

export async function startMonitor({ config, store, account, bridge, log, signal }) {
  store.restoreContextTokens(account.accountId)

  let getUpdatesBuf = store.loadSyncBuf(account.accountId)
  log.info?.(getUpdatesBuf ? `从游标恢复（${getUpdatesBuf.length} 字节）` : '无历史游标，从头开始')

  let nextTimeoutMs = config.longPollTimeoutMs
  let consecutiveFailures = 0

  await notifyStart({ baseUrl: account.baseUrl, token: account.token, botAgent: config.botAgent })

  // 主动问候：既是给用户的即时反馈，也是出站链路的自证。
  // 部署/热重载都会重启长轮询，此时再问候一次纯属打扰，可用环境变量关掉。
  if (config.greetOnStart !== false && process.env.DSH_WEIXIN_NO_GREET !== '1') {
    try {
      await bridge.greet?.()
    } catch (error) {
      log.warn?.(`启动问候异常: ${String(error)}`)
    }
  }

  try {
    while (!signal?.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
          signal,
          botAgent: config.botAgent,
        })

        if (resp.longpolling_timeout_ms > 0) nextTimeoutMs = resp.longpolling_timeout_ms

        const { isError, isStaleToken } = classifyResponse(resp)

        if (isError) {
          if (isStaleToken) {
            log.error?.(`令牌已失效，暂停 ${Math.ceil(STALE_TOKEN_PAUSE_MS / 60_000)} 分钟后重试`)
            consecutiveFailures = 0
            await sleep(STALE_TOKEN_PAUSE_MS, signal)
            continue
          }
          consecutiveFailures += 1
          log.warn?.(
            `getUpdates 失败 ret=${resp.ret ?? ''} errcode=${resp.errcode ?? ''} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          )
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf
          store.saveSyncBuf(account.accountId, getUpdatesBuf)
        }

        for (const message of resp.msgs ?? []) {
          if (signal?.aborted) break
          // 串行处理：微信是对话式输入，并发会打乱用户体验
          try {
            await bridge.processMessage(message)
          } catch (error) {
            log.error?.(`处理入站消息失败 from=${message.from_user_id ?? '?'}: ${String(error)}`)
          }
        }
      } catch (error) {
        if (signal?.aborted) break
        consecutiveFailures += 1
        log.warn?.(`getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(error)}`)
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }
  } finally {
    await notifyStop({ baseUrl: account.baseUrl, token: account.token, botAgent: config.botAgent }).catch(() => {})
    log.info?.('长轮询已停止')
  }
}
