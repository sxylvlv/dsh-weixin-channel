#!/usr/bin/env node
/**
 * 出站链路自证：用真实 token + 真实 context_token 直接调用 ilink sendmessage。
 *
 * 目的：在不打扰运行中插件的前提下，单独证明 sendmessage 是否可用
 *（这是"会话建了却收不到回复"唯一可能的剩余故障点）。
 *
 * 用法：node tools/send-test.mjs [自定义文本]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sendText } from '../lib/ilink.mjs'

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const stateDir = path.join(dshHome, 'weixin')
const accountsDir = path.join(stateDir, 'accounts')

const accountIds = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts.json'), 'utf-8'))
if (!accountIds.length) {
  console.error('没有已登录账号')
  process.exit(1)
}
const accountId = accountIds[accountIds.length - 1]
const account = JSON.parse(fs.readFileSync(path.join(accountsDir, `${accountId}.json`), 'utf-8'))

const contextFile = path.join(accountsDir, `${accountId}.context-tokens.json`)
const tokens = fs.existsSync(contextFile) ? JSON.parse(fs.readFileSync(contextFile, 'utf-8')) : {}
const userId = account.userId
if (!userId) {
  console.error('账号未记录 userId，无法指定收件人')
  process.exit(1)
}

const contextToken = process.argv.includes('--no-context') ? undefined : tokens[userId]
const text = process.argv[2] ?? '出站链路自检：这是一条由 DSH 侧直接调用 sendmessage 发出的测试消息。'

console.log(JSON.stringify({
  accountId,
  toUserId: userId,
  hasContextToken: Boolean(contextToken),
  tokenLength: (account.token ?? '').length,
  textLength: text.length,
}, null, 2))

try {
  const resp = await sendText({
    baseUrl: account.baseUrl ?? 'https://ilinkai.weixin.qq.com',
    token: account.token,
    toUserId: userId,
    text,
    contextToken,
    botAgent: 'DSH-Weixin-Channel/0.1.0',
  })
  console.log('SEND OK ->', JSON.stringify(resp))
} catch (error) {
  console.error('SEND FAILED ->', String(error))
  process.exit(1)
}
