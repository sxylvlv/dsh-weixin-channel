#!/usr/bin/env node
/**
 * 强制重挂：先移除 patch 中的微信行并等待重组稳定，再重新插入。
 *
 * 背景（实测）：同一进程内热重组时，直接改 name/id 会出现「旧实例被拆掉、新行插不进去」，
 * 表现为 mount-status 停在 stopped。分两步（先移除、后插入）可让 loader 回到干净状态再插。
 *
 * 用法：node tools/retoggle.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const patchPath = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
const stateDir = path.join(dshHome, 'weixin')

const MARKER = ', { insert: [ { id: weixin-channel'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readState() {
  const p = path.join(stateDir, 'mount-status.json')
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

const original = fs.readFileSync(patchPath, 'utf-8')
const start = original.indexOf(MARKER)
if (start < 0) {
  console.error('[retoggle] patch 中找不到微信行')
  process.exit(1)
}

const prefix = original.slice(0, start)
const tail = original.slice(start)          // ", { insert: ... } ] } ]" 到文件末尾
const block = tail.replace(/\]\s*$/, '').trimEnd()   // 去掉最外层数组的 " ]"

console.log('[retoggle] 第 1 步：移除微信行')
fs.writeFileSync(patchPath, `${prefix} ]\n\n`, 'utf-8')
await sleep(15000)
console.log('[retoggle]   mount-status =', JSON.stringify(readState()))

console.log('[retoggle] 第 2 步：重新插入微信行')
fs.writeFileSync(patchPath, `${prefix}${block} ]\n\n`, 'utf-8')

for (let i = 0; i < 12; i += 1) {
  await sleep(5000)
  const st = readState()
  console.log(`[retoggle]   +${(i + 1) * 5}s mount-status =`, JSON.stringify(st))
  if (st && st.stage === 'running') break
}

const logFile = path.join(stateDir, 'channel.log')
console.log('[retoggle] channel.log 存在 =', fs.existsSync(logFile))
if (fs.existsSync(logFile)) console.log(fs.readFileSync(logFile, 'utf-8').split('\n').slice(-15).join('\n'))
