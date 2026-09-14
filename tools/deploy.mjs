#!/usr/bin/env node
/**
 * 内容寻址部署：把插件源码部署成「按内容哈希命名的版本化目录」，并改写 web profile 的 patch 行。
 *
 * 为什么需要它：
 *   运行中的 DSH 对插件模块按 URL 缓存。实测结论——改 cordis.patch.yml 会触发重组、
 *   重新执行 apply，但**模块仍来自缓存**，源码改动不会生效。只有换掉入口 URL 才会重新导入。
 *   用内容哈希做目录名即可：内容不变→同一 URL（不触发无谓重挂）；内容变了→新 URL（必然重载）。
 *
 * 用法：node tools/deploy.mjs
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', 'web')
const patchPath = path.join(profileDir, 'cordis.patch.yml')

/**
 * 参与哈希与部署的文件（相对 pkgRoot）。运行时不依赖 qrcode，故不含 bin/node_modules。
 *
 * 注意：**每一个运行时 import 的模块都必须列进来**。曾经漏了 lib/media.mjs 与
 * lib/outbound.mjs，导致只改这两个文件时 rev 不变、patch 不变、进程不重载，
 * 改动静默不生效。新增 lib/*.mjs 时必须同步补进来。
 */
const DEPLOY_FILES = ['index.mjs', 'package.json',
  'lib/store.mjs', 'lib/ilink.mjs', 'lib/login.mjs', 'lib/monitor.mjs', 'lib/message.mjs',
  'lib/bridge.mjs', 'lib/media.mjs', 'lib/video-frame.mjs', 'lib/outbound.mjs', 'lib/log.mjs',
  // 运行时要用 tools/ 下的这几个脚本（video-frame.mjs 通过路径调用它们），
  // 所以它们也必须进哈希：只改 .ps1 而不改 .mjs 时同样需要触发重载。
  'tools/ffmpeg-common.ps1', 'tools/ffmpeg-frames.ps1', 'tools/ffmpeg-scene.ps1',
  'tools/mf-frames.ps1', 'tools/shell-frame.ps1']

function hashSources() {
  const h = crypto.createHash('sha256')
  for (const rel of DEPLOY_FILES) {
    const abs = path.join(pkgRoot, rel)
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(abs))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 8)
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

const rev = hashSources()
const dirName = `dsh-weixin-channel-${rev}`
const deployDir = path.join(profileDir, dirName)
const entryName = `./${dirName}/index.mjs`

if (fs.existsSync(path.join(deployDir, 'index.mjs'))) {
  console.log(`[deploy] 复用已有版本目录（内容未变）: ${dirName}`)
} else {
  copyDir(pkgRoot, deployDir)
  // 部署目录只保留运行时需要的部分。
  // ⚠️ **tools/ 不能整个删**：lib/video-frame.mjs 运行时要用 tools/shell-frame.ps1，
  //    这里只剔除运行时不用的东西（保证 shell-frame.ps1 会被带过去）。
  for (const junk of ['docs', 'bin', 'node_modules', 'restart-watchdog.ps1', 'cordis.patch.snippet.yml',
    'README.md', 'package-lock.json', 'restart.log', 'restart-status.json', 'dsh-web.out.log', 'dsh-web.err.log']) {
    fs.rmSync(path.join(deployDir, junk), { recursive: true, force: true })
  }
  for (const unused of ['deploy.mjs', 'retoggle.mjs', 'cdn-probe.mjs', 'cdn-verify.mjs',
    'cdn-decode.mjs', 'send-test.mjs', 'send-file-test.mjs', 'test-video-frame.mjs',
    'shell-frames.ps1']) {
    fs.rmSync(path.join(deployDir, 'tools', unused), { force: true })
  }
  console.log(`[deploy] 已创建版本目录: ${dirName}`)
}

// 改写 patch 行：
//   - id 一并随版本号变化。实测：同一个 id 只换 name 时，重组会移除旧行却插不进新行（id 冲突）。
//   - name 指向新版本目录（URL 变化才会重新导入模块）。
const original = fs.readFileSync(patchPath, 'utf-8')
let updated = original
  .replace(/id:\s*weixin-channel[a-z0-9-]*/g, `id: weixin-channel-${rev}`)
  .replace(/\.\/dsh-weixin-channel[^"]*\/index\.mjs/g, entryName)

if (updated === original && !original.includes(entryName)) {
  console.error('[deploy] patch 中找不到 weixin 行，请先手动插入一行（insert 形式）')
  process.exit(1)
}
if (updated !== original) {
  fs.writeFileSync(patchPath, updated, 'utf-8')
  console.log('[deploy] 已更新 cordis.patch.yml 的入口路径')
} else {
  console.log('[deploy] patch 已是当前版本，未改动')
}

// 注意：**不要**删除历史版本目录。
// 运行中的实例仍持有旧目录下的模块文件；在它卸载之前删掉该目录，
// 会让后续重组无法完成导入（实测表现为 mount-status 停在 stopped、新行插不进去）。
// 目录体积很小，保留即可。
const stale = fs.readdirSync(profileDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('dsh-weixin-channel-') && e.name !== dirName)
  .map((e) => e.name)
if (stale.length > 0) console.log(`[deploy] 保留历史版本目录（不删除）: ${stale.join(', ')}`)

console.log(`[deploy] rev=${rev} entry=${entryName}`)
