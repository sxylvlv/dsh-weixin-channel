/**
 * 日志器：同时写 stderr 与磁盘审计文件。
 *
 * 磁盘审计文件 <DSH_HOME>/weixin/channel.log 是判断「收/发是否真的发生过」的唯一可靠证据——
 * DSH 宿主日志在另一个进程的终端里，外部读不到。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = '[dsh-weixin]'

/** 脱敏：token 只留头尾，避免日志泄漏凭据。 */
export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value.length <= 12) return '***'
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function resolveLogFile() {
  try {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
    return path.join(home, 'weixin', 'channel.log')
  } catch {
    return undefined
  }
}

function appendToFile(file, line) {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf-8')
  } catch {
    // 审计写盘失败不得影响业务
  }
}

export function makeLog(scope) {
  const tag = `${PREFIX}[${scope}]`
  const file = resolveLogFile()
  const sink = (level, message) => {
    const line = `${tag} ${level} ${message}`
    process.stderr.write(`${line}\n`)
    appendToFile(file, line)
  }
  return {
    debug: (message) => {
      if (process.env.DSH_WEIXIN_DEBUG === '1') sink('debug', message)
    },
    info: (message) => sink('info', message),
    warn: (message) => sink('warn', message),
    error: (message) => sink('error', message),
  }
}
