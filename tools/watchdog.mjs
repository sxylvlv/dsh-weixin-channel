#!/usr/bin/env node
/**
 * [watchdog] 通道自愈看门狗 —— 独立进程。
 *
 * 由 index.mjs 在每次挂载通道时拉起（`detached + unref`），**故意不随插件卸载而退出**：
 * 起因是 2026-09-14 实测的一次「通道静默失效」——热重组把 patch 里的行拆掉后没插回来，
 * mount-status 停在 stopped、微信侧毫无反应。插件自身的代码此时已经不运行了，
 * 它**不可能自救**，所以必须由外部进程定期检查并重挂。
 *
 * 判定「失效」：mount-status 里的 stage 不是 running，或 running 但记的 pid 已不存在。
 * （`apply` / `waiting-login` 视为"正在挂载中"，不算失效。）
 *
 * 重挂方式：**先移除行 → 等 10s → 用新 id 重新插入**。
 * 为什么必须换新 id：deploy.mjs 里记过——同一个 id 只换 name 时，重组会移除旧行却插不进新行。
 *
 * 安全阀：
 *   - `<状态目录>/watchdog.off` 存在 → 不干预
 *   - 任何 profile 里都没有微信行 → 视为人工卸载，不再干预
 *   - patch 在 60s 内被写过 → 本轮跳过（可能正在部署）
 *   - 连续 3 次（约 60s）判定失效才动手；动手后进入 5 分钟冷却
 *   - 同一时刻只有一个看门狗（pidfile 去重）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'weixin')
const STATUS = path.join(STATE_DIR, 'mount-status.json')
const LOG = path.join(STATE_DIR, 'channel.log')
const OFF = path.join(STATE_DIR, 'watchdog.off')
const PIDFILE = path.join(STATE_DIR, 'watchdog.pid')

const CHECK_MS = 20_000
const DEAD_ROUNDS = 3
const COOLDOWN_MS = 5 * 60_000
const PATCH_SETTLE_MS = 60_000
const REMOVE_WAIT_MS = 10_000
const VERIFY_MS = 60_000
const MARKER = ', { insert: [ { id: weixin-channel'

function note(message) {
  const line = `${new Date().toISOString()} [dsh-weixin][watchdog] ${message}\n`
  try {
    fs.appendFileSync(LOG, line, 'utf-8')
  } catch {
    // 日志写不进去也不能让看门狗死掉
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS, 'utf-8'))
  } catch {
    return undefined
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 所有带着微信行的 profile patch 文件。 */
function patchesWithRow() {
  const dir = path.join(DSH_HOME, 'profiles')
  const hits = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(dir, entry.name, 'cordis.patch.yml')
      if (!fs.existsSync(file)) continue
      if (fs.readFileSync(file, 'utf-8').includes(MARKER)) hits.push({ profile: entry.name, file })
    }
  } catch {
    // profiles 目录不可读：当作没有
  }
  return hits
}

async function remount(hit) {
  const original = fs.readFileSync(hit.file, 'utf-8')
  const start = original.indexOf(MARKER)
  if (start < 0) {
    note(`profile ${hit.profile} 的 patch 里已没有微信行，放弃本轮`)
    return false
  }
  const prefix = original.slice(0, start)
  const block = original.slice(start).replace(/\]\s*$/, '').trimEnd()
  const freshId = `weixin-channel-wd${Date.now().toString(36)}`
  const reinsert = block.replace(/id:\s*weixin-channel[a-z0-9-]*/, `id: ${freshId}`)

  note(`重挂 ${hit.profile}：第 1 步移除行`)
  fs.writeFileSync(hit.file, `${prefix} ]\n\n`, 'utf-8')
  await sleep(REMOVE_WAIT_MS)

  note(`重挂 ${hit.profile}：第 2 步以新 id (${freshId}) 重新插入`)
  fs.writeFileSync(hit.file, `${prefix}${reinsert} ]\n\n`, 'utf-8')

  const deadline = Date.now() + VERIFY_MS
  while (Date.now() < deadline) {
    await sleep(5000)
    const status = readStatus()
    if (status?.stage === 'running' && alive(status.pid)) {
      note(`重挂成功 ✓ build=${status.build ?? '?'} pid=${status.pid}`)
      return true
    }
  }
  note('重挂后 60s 内仍未进入 running，本轮放弃（下次循环再试）')
  return false
}

// ── 单例：同一时刻只允许一个看门狗 ─────────────────────────────────────────
try {
  const previous = Number.parseInt(fs.readFileSync(PIDFILE, 'utf-8').trim(), 10)
  if (alive(previous) && previous !== process.pid) {
    note(`已有看门狗在运行 pid=${previous}，本进程退出`)
    process.exit(0)
  }
} catch {
  // 没有 pidfile 属正常
}
fs.mkdirSync(STATE_DIR, { recursive: true })
fs.writeFileSync(PIDFILE, String(process.pid), 'utf-8')
process.on('exit', () => {
  try {
    if (fs.readFileSync(PIDFILE, 'utf-8').trim() === String(process.pid)) fs.rmSync(PIDFILE, { force: true })
  } catch {
    // 退出清理失败无所谓
  }
})

note(`看门狗启动 pid=${process.pid}，每 ${CHECK_MS / 1000}s 检查一次`)

let deadRounds = 0
let cooldownUntil = 0

for (;;) {
  await sleep(CHECK_MS)
  try {
    if (fs.existsSync(OFF)) {
      continue
    }

    const status = readStatus()
    const stage = status?.stage
    const settling = stage === 'apply' || stage === 'waiting-login'
    const healthy = settling || (stage === 'running' && alive(status?.pid))
    if (healthy) {
      deadRounds = 0
      continue
    }

    deadRounds += 1
    note(`第 ${deadRounds}/${DEAD_ROUNDS} 次判定异常：stage=${stage ?? '(无)'} pid=${status?.pid ?? '-'}`)
    if (deadRounds < DEAD_ROUNDS) continue
    if (Date.now() < cooldownUntil) continue

    const hits = patchesWithRow()
    if (hits.length === 0) {
      note('没有任何 profile 还带微信行 → 视为人工卸载，不再干预')
      deadRounds = 0
      continue
    }

    const hit = hits[0]
    const age = Date.now() - fs.statSync(hit.file).mtimeMs
    if (age < PATCH_SETTLE_MS) {
      note(`patch 在 ${Math.round(age / 1000)}s 前刚被写过（可能正在部署），本轮跳过`)
      deadRounds = 0
      continue
    }

    note(`判定通道已失效，开始重挂 profile=${hit.profile}`)
    await remount(hit)
    cooldownUntil = Date.now() + COOLDOWN_MS
    deadRounds = 0
  } catch (error) {
    note(`检查异常（忽略继续）: ${String(error)}`)
  }
}
