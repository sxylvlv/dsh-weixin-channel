/**
 * 从视频文件里抽画面，作为「我看到的画面」。
 *
 * 两条路，按可靠性排序：
 *   1. tools/mf-frames.ps1  —— Media Foundation 顺序解码，按时间戳取多帧拼成宫格。
 *      实测（2026-09-13）720x1280/30fps 的 4 秒视频约 1.7s 出 3 帧。
 *   2. tools/shell-frame.ps1 —— Shell 缩略图工厂只给首帧，作为兜底。
 *
 * 为什么不 seek：MF 的 IMFSourceReader::SetCurrentPosition 在本机对任何手工构造的
 * PROPVARIANT 都返回「参数错误」，所以 mf-frames 改为顺序解码 + 时间窗采样。
 *
 * 失败一律返回 undefined —— 抽画面只是锦上添花，绝不能拖垮视频本身。
 */

import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本模块所在目录 → 向上找到包根，再定位 tools/*.ps1。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MF_SCRIPT = path.join(HERE, '..', 'tools', 'mf-frames.ps1')
const SHELL_SCRIPT = path.join(HERE, '..', 'tools', 'shell-frame.ps1')
const FFMPEG_SCRIPT = path.join(HERE, '..', 'tools', 'ffmpeg-frames.ps1')

/**
 * Node 侧等待上限：多帧要顺序解码（MF 在当前环境拒绝 seek），
 * 4 秒视频实测约 2s；给足余量，但不允许挂死。
 */
const TIMEOUT_MS = 60_000

/**
 * 找一个能用的 ffmpeg。
 *
 * 为什么要自己找：这台机器上 winget 的 FFmpeg 是**半装状态**（包目录里 bin/ 是空的），
 * PATH 里那条 `...\ffmpeg-8.0.1-full_build\bin` 是残渣，`where ffmpeg` 也找不到。
 * 所以按「显式路径 → PATH → 已知安装位置 → 随包 bin/」逐个探，探到再缓存。
 */
let ffmpegCache
export function resolveFfmpeg({ log } = {}) {
  if (ffmpegCache !== undefined) return ffmpegCache
  const candidates = []
  if (process.env.DSH_WEIXIN_FFMPEG?.trim()) candidates.push(process.env.DSH_WEIXIN_FFMPEG.trim())
  const home = os.homedir()
  candidates.push(
    path.join(HERE, '..', '..', 'bin', 'ffmpeg.exe'), // 可选：随项目放置的 ffmpeg
    path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    path.join(home, 'scoop', 'shims', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  )
  // PATH 上的也试
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir.trim()) candidates.push(path.join(dir.trim(), 'ffmpeg.exe'))
  }
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) {
        ffmpegCache = c
        log?.info?.(`找到 ffmpeg: ${c}`)
        return ffmpegCache
      }
    } catch {
      // 忽略非法路径
    }
  }
  ffmpegCache = null
  log?.info?.('未找到 ffmpeg，视频抽帧将走 Media Foundation')
  return ffmpegCache
}

function runPowershell(args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', args, { windowsHide: true })
    } catch (error) {
      resolve({ code: -1, stderr: String(error) })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已退出
      }
      resolve({ code: -2, stdout: out, stderr: `${err}\n(超时 ${timeoutMs}ms，已杀进程)` })
    }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d.toString('utf8') })
    child.stderr?.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: out, stderr: err })
    })
  })
}

/** 生成一个临时输出路径，跑完即删。 */
function tempPng(tag) {
  return path.join(
    os.tmpdir(),
    `dsh-weixin-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`,
  )
}

/**
 * 按秒数算出均匀采样点（按比例，15% → 85%）。
 *
 * 为什么用比例而不是「留固定边距」：实测两条视频里，微信报的 play_length 都**大于**
 * 实际可解码时长（8s 的视频到 7.47s 就没了）。按固定边距取点会把最后两个点都挤到
 * 尾部附近，两格画面几乎相同；按比例取点能把它们分散到整段内容上。
 * 真正的保险在 mf-frames.ps1 里：每个采样点只在自己的时间窗内匹配，取不到才克隆。
 */
export function evenTimestamps(durationSec, count) {
  const n = Math.max(1, Math.floor(count))
  const d = Number(durationSec)
  if (!Number.isFinite(d) || d <= 0) {
    // 时长未知：按 0.5s 间隔取前 n 个点
    return Array.from({ length: n }, (_, i) => Number((0.3 + i * 0.5).toFixed(2)))
  }
  const first = 0.15
  const last = 0.85
  if (n === 1) return [Number((d * 0.5).toFixed(2))]
  return Array.from({ length: n }, (_, i) =>
    Number((d * (first + ((last - first) * i) / (n - 1))).toFixed(2)))
}

/**
 * 用 ffmpeg 一次出图：`fps` 按真实时间轴采样，`tile` 拼宫格。
 * 取 1 帧时不拼图，直接给全分辨率单帧。
 * @returns {Promise<Uint8Array|undefined>}
 */
async function extractWithFfmpeg({ videoPath, count, duration, sceneExtra = 0, log }) {
  const ffmpeg = resolveFfmpeg({ log })
  if (!ffmpeg || !existsSync(FFMPEG_SCRIPT)) return undefined
  try {
    const outPath = tempPng('ffsheet')
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', FFMPEG_SCRIPT,
      '-Path', videoPath,
      '-Out', outPath,
      '-Frames', String(Math.max(1, count)),
      '-Ffmpeg', ffmpeg,
    ]
    if (Number.isFinite(duration) && duration > 0) args.push('-Duration', String(duration))
    if (sceneExtra > 0) args.push('-SceneExtra', String(sceneExtra))
    const r = await runPowershell(args, TIMEOUT_MS)
    try {
      if (r.code !== 0) {
        log?.warn?.(`ffmpeg 抽帧失败 code=${r.code}: ${String(r.stderr).trim().slice(0, 200)}`)
        return undefined
      }
      const png = await readFile(outPath)
      log?.info?.(`ffmpeg 抽帧成功: ${count} 帧${sceneExtra ? `+场景补 ${sceneExtra}` : ''} → ${png.length} 字节`)
      return png
    } finally {
      await rm(outPath, { force: true }).catch(() => {})
    }
  } catch (error) {
    log?.warn?.(`ffmpeg 抽帧异常（将退回 MF）: ${String(error)}`)
    return undefined
  }
}

/**
 * 取视频画面，返回 PNG 字节。
 *
 * 顺序：ffmpeg（若可用）→ Media Foundation → 失败返回 undefined。
 *   - ffmpeg 走 `fps` + `tile` 滤镜，一次编码出宫格，没有逐帧解码的探测开销
 *   - ffmpeg 不可用时退回 mf-frames.ps1（顺序解码 + 时间窗采样）
 *
 * @param {{ videoPath: string, seconds: number[], columns?: number,
 *           tileWidth?: number, tileHeight?: number, duration?: number, log?: object }} input
 * @returns {Promise<Uint8Array|undefined>}
 */
export async function extractVideoSheetPng({
  videoPath,
  seconds,
  columns = 3,
  tileWidth = 640,
  tileHeight = 360,
  duration,
  sceneExtra = 0,
  log,
}) {
  const list = (seconds ?? []).filter((s) => Number.isFinite(s) && s >= 0)
  if (list.length === 0) return undefined
  if (process.platform !== 'win32') return undefined

  const viaFfmpeg = await extractWithFfmpeg({ videoPath, count: list.length, duration, sceneExtra, log })
  if (viaFfmpeg) return viaFfmpeg

  try {
    if (!existsSync(MF_SCRIPT)) {
      log?.warn?.(`多帧脚本不存在: ${MF_SCRIPT}`)
      return undefined
    }

    const outPath = tempPng('sheet')
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', MF_SCRIPT,
      '-Path', videoPath,
      '-Out', outPath,
      '-Seconds', list.join(','),
      '-Columns', String(columns),
      '-TileWidth', String(tileWidth),
      '-TileHeight', String(tileHeight),
    ]
    const r = await runPowershell(args, TIMEOUT_MS)
    try {
      if (r.code !== 0) {
        log?.warn?.(`多帧抽取失败 code=${r.code}: ${String(r.stderr).trim().slice(0, 200)}`)
        return undefined
      }
      const png = await readFile(outPath)
      log?.info?.(`多帧抽取成功（MF）: ${list.length} 帧 → ${png.length} 字节`)
      return png
    } finally {
      await rm(outPath, { force: true }).catch(() => {})
    }
  } catch (error) {
    log?.warn?.(`多帧抽取异常（不影响视频）: ${String(error)}`)
    return undefined
  }
}

/**
 * 单帧兜底：Shell 缩略图工厂（只给首帧）。
 * @returns {Promise<Uint8Array|undefined>} PNG 字节；失败时 undefined
 */
export async function extractVideoFramePng({ videoPath, width = 1280, height = 720, log }) {
  try {
    if (process.platform !== 'win32') {
      log?.warn?.('抽帧仅实现了 Windows（Shell 缩略图工厂），跳过')
      return undefined
    }
    if (!existsSync(SHELL_SCRIPT)) {
      log?.warn?.(`抽帧脚本不存在: ${SHELL_SCRIPT}`)
      return undefined
    }
    const outPath = tempPng('frame')
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', SHELL_SCRIPT,
      '-Path', videoPath,
      '-Out', outPath,
      '-Width', String(width),
      '-Height', String(height),
    ]
    const r = await runPowershell(args, TIMEOUT_MS)
    try {
      if (r.code !== 0) {
        log?.warn?.(`抽帧失败 code=${r.code}: ${String(r.stderr).trim().slice(0, 200)}`)
        return undefined
      }
      const png = await readFile(outPath)
      log?.info?.(`抽帧成功: ${png.length} 字节 → ${width}x${height}`)
      return png
    } finally {
      await rm(outPath, { force: true }).catch(() => {})
    }
  } catch (error) {
    log?.warn?.(`抽帧异常（不影响视频）: ${String(error)}`)
    return undefined
  }
}
