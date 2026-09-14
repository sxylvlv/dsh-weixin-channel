/**
 * dsh-weixin-channel —— 微信（腾讯 ilink bot）通道插件 for DSH
 *
 * 来源：@tencent-weixin/openclaw-weixin@2.4.8（Tencent，MIT）的移植。
 * 平面：host 组合（一个长轮询连接 + 多个微信用户 → 多个独立会话）。
 * 本插件不发布任何 service，纯消费者 + 后台循环，无需 isolate realm。
 *
 * 挂载：dsh-weixin-channel/ 与 $DSH_HOME/profiles/web/cordis.patch.yml 同级，
 *       并在该 patch 里追加一行。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import z from '@deepseek-ai/schemastery'

import { createStore } from './lib/store.mjs'
import { createBridge } from './lib/bridge.mjs'
import { startMonitor } from './lib/monitor.mjs'
import { makeLog } from './lib/log.mjs'
import { DEFAULT_APP_ID, DEFAULT_BOT_AGENT } from './lib/ilink.mjs'

export const name = 'dsh-weixin-channel'

/** 构建标记：写进 mount-status.json，用于判断热重组时模块是否被重新导入。 */
export const BUILD = 'r26'

/** 硬依赖：会话创建与驱动所必需的服务。 */
export const inject = ['agents', 'agentPresets', 'workspaceRegistry', 'sessionTitle', 'agentDefaultModel']

export const Config = z.object({
  /** 每个微信会话的工作区目录（绝对路径）。 */
  workspacePath: z.string().required(),
  /** 微信 userId 白名单（xxx@im.wechat）。空数组 = 未授权一律拒绝。 */
  allowFrom: z.array(z.string()).default([]),
  /** 未授权时允许发送 /pair 自助加入白名单（仅建议内网/自用开启）。 */
  autoPair: z.boolean().default(false),
  /** 指定账号 id；留空时取状态目录里第一个已登录账号。 */
  accountId: z.string().default(''),
  /** agent preset 名。 */
  agentPreset: z.string().default('standard'),
  /** 权限预设名。默认满权限（sandbox=danger-full-access + approval=never）。 */
  permissionPreset: z.string().default('danger-full-access'),
  /**
   * 保证通道会话在浏览器侧栏里可见：每次复用/新建时取消归档，挂载时再整体捞回
   * `weixin-` 前缀的历史会话。归档 = 在所有分组和搜索里彻底隐藏，且 DSH 没有反归档 API，
   * 一旦被隐藏用户就再也找不到，因此默认开启。
   */
  ensureSessionVisible: z.boolean().default(true),
  /** 单条出站文本上限（腾讯侧 4000）。 */
  maxReplyChars: z.number().default(4000),
  /** 是否先回执「收到，正在处理…」。 */
  replyProgress: z.boolean().default(true),
  /** 长轮询超时。 */
  longPollTimeoutMs: z.number().default(35000),
  /** 出站媒体发送前是否做「下载回来逐字节比对」的自检。 */
  verifyBeforeSend: z.boolean().default(true),
  /** 出站媒体的引用参数来源：ack-header（实测可用）/ upload-param / split。 */
  mediaReferenceMode: z.string().default('ack-header'),
  /** 缓存令牌超过这个年龄（毫秒）就判定过期，直接不带令牌发送。 */
  staleTokenMs: z.number().default(600000),
  /** 出站最小间隔（毫秒）——防止突发送把通道打限。 */
  minSendIntervalMs: z.number().default(1500),
  /** 连续可恢复失败达到这个次数就进入冷却。 */
  maxConsecutiveSendFailures: z.number().default(3),
  /** 冷却时长（毫秒）。 */
  sendCooldownMs: z.number().default(300000),
  /** 出站媒体是否带 encrypt_type: 1（实测必须带）。 */
  includeMediaEncryptType: z.boolean().default(true),
  /** 出站媒体是否带 full_url（实测**带上会导致不投递**，默认关闭）。 */
  includeMediaFullUrl: z.boolean().default(false),
  /** 视频入站：封面(CDN)拿不到时，是否用本机解码器抽画面给模型看。 */
  extractVideoFrame: z.boolean().default(true),
  /** 抽几帧拼成宫格（1 = 只取一帧）。微信里发 `/frames N` 可临时覆盖。 */
  videoFrameCount: z.number().default(3),
  /** 场景感知补帧数：在画面变化最大的时刻额外补几张（0 = 关闭）。 */
  videoSceneExtra: z.number().default(2),
  /** 宫格每格尺寸。 */
  videoFrameTileWidth: z.number().default(640),
  videoFrameTileHeight: z.number().default(360),
  /** 首帧兜底（多帧失败时用）的抽帧尺寸。 */
  videoFrameWidth: z.number().default(1280),
  videoFrameHeight: z.number().default(720),
  /** iLink-App-Id，默认 bot（与原插件一致）。 */
  appId: z.string().default(DEFAULT_APP_ID),
  /** base_info.bot_agent，仅供观测。 */
  botAgent: z.string().default(DEFAULT_BOT_AGENT),
})

function dshHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}

/** 挂载探针：写一行状态文件，便于不依赖服务端日志判断插件是否真的装上。 */
function writeMountStatus(payload) {
  try {
    const dir = path.join(dshHome(), 'weixin')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mount-status.json'), JSON.stringify(payload, null, 2), 'utf-8')
  } catch {
    // 探针失败不影响功能
  }
}

export function apply(ctx, config) {
  // 同时写 DSH 宿主日志与磁盘审计文件 <DSH_HOME>/weixin/channel.log。
  // 磁盘审计是外部判断「收/发是否真的发生」的唯一可靠证据（宿主日志在别的终端里）。
  const fileLog = makeLog('weixin')
  const logger = {
    debug: (m) => { ctx.logger?.debug?.(m); fileLog.debug(m) },
    info: (m) => { ctx.logger?.info?.(m); fileLog.info(m) },
    warn: (m) => { ctx.logger?.warn?.(m); fileLog.warn(m) },
    error: (m) => { ctx.logger?.error?.(m); fileLog.error(m) },
  }
  const stamp = new Date().toISOString()

  writeMountStatus({ stage: 'apply', at: stamp, build: BUILD, plugin: name, pid: process.pid })

  let store
  try {
    store = createStore(config)
  } catch (error) {
    logger.error?.(`[weixin] 状态目录不可用，插件不激活: ${String(error)}`)
    writeMountStatus({ stage: 'aborted', at: stamp, reason: `store: ${String(error)}` })
    return
  }

  // 允许「先挂载、后扫码」：未登录时每 5s 轮询一次，登录成功即自动接管。
  ctx.effect(() => {
    let controller
    let started = false

    const attempt = () => {
      if (started) return
      let account
      try {
        account = store.resolveAccount(config.accountId)
      } catch (error) {
        logger.error?.(`[weixin] 读取账号失败: ${String(error)}`)
        return
      }
      if (!account) return

      started = true
      controller = new AbortController()
      const bridge = createBridge({ ctx, config, store, account, log: logger })

      startMonitor({ config, store, account, bridge, log: logger, signal: controller.signal })
        .then(() => writeMountStatus({ stage: 'stopped', at: new Date().toISOString(), accountId: account.accountId }))
        .catch((error) => {
          logger.error?.(`[weixin] 长轮询意外退出: ${String(error)}`)
          writeMountStatus({ stage: 'crashed', at: new Date().toISOString(), reason: String(error) })
        })

      logger.info?.(`[weixin] 通道已启动 account=${account.accountId} baseUrl=${account.baseUrl}`)
      writeMountStatus({
        stage: 'running',
        at: new Date().toISOString(),
        build: BUILD,
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        appId: config.appId,
      })
    }

    attempt()
    if (!started) {
      logger.warn?.('[weixin] 尚未登录，等待扫码结果（每 5s 重试）')
      writeMountStatus({ stage: 'waiting-login', at: stamp, build: BUILD, stateDir: store.root })
    }
    const timer = setInterval(attempt, 5000)

    return () => {
      clearInterval(timer)
      controller?.abort()
      logger.info?.('[weixin] 通道正在停止…')
    }
  })
}
