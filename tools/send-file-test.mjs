#!/usr/bin/env node
/**
 * 出站媒体自证：用真实 token 走完整上传链路，把本地文件通过微信发给扫码者。
 *
 * 用法：node tools/send-file-test.mjs <绝对路径>
 *
 * 链路（与源插件一致）：
 *   getUploadUrl → AES-128-ECB 加密 → POST 密文到 CDN → 取响应头 x-encrypted-param
 *   → 组装 image_item / file_item → sendmessage
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sendMessage, generateClientId, sendText } from '../lib/ilink.mjs'
import { uploadLocalFileToWeixin, downloadAndDecrypt } from '../lib/media.mjs'

const filePath = process.argv[2]
if (!filePath || !fs.existsSync(filePath)) {
  console.error('用法: node tools/send-file-test.mjs <存在的绝对路径>')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const stateDir = path.join(dshHome, 'weixin')
const accountsDir = path.join(stateDir, 'accounts')

const accountIds = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts.json'), 'utf-8'))
const accountId = accountIds[accountIds.length - 1]
const account = JSON.parse(fs.readFileSync(path.join(accountsDir, `${accountId}.json`), 'utf-8'))
const contextFile = path.join(accountsDir, `${accountId}.context-tokens.json`)
const tokens = fs.existsSync(contextFile) ? JSON.parse(fs.readFileSync(contextFile, 'utf-8')) : {}
const userId = account.userId
const contextToken = tokens[userId]

const log = {
  debug: () => {},
  info: (m) => console.log('  ' + m),
  warn: (m) => console.warn('  ' + m),
  error: (m) => console.error('  ' + m),
}

console.log(JSON.stringify({
  accountId,
  toUserId: userId,
  hasContextToken: Boolean(contextToken),
  file: filePath,
  size: fs.statSync(filePath).size,
}, null, 2))

const includeEncryptType = !process.argv.includes('--no-encrypt-type')
const includeFullUrl = !process.argv.includes('--no-full-url')
const modeArg = process.argv.find((a) => a.startsWith('--mode='))
const referenceMode = modeArg ? modeArg.slice('--mode='.length) : 'upload-param'

const uploaded = await uploadLocalFileToWeixin({
  filePath,
  toUserId: userId,
  baseUrl: account.baseUrl ?? 'https://ilinkai.weixin.qq.com',
  token: account.token,
  cdnBaseUrl: account.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c',
  botAgent: 'DSH-Weixin-Channel/0.1.0',
  log,
  includeEncryptType,
  referenceMode,
  includeFullUrl,
})
console.log('  includeEncryptType =', includeEncryptType, ' referenceMode =', referenceMode, ' includeFullUrl =', includeFullUrl)
console.log('  实际 media 字段 =', JSON.stringify(Object.keys(uploaded.item.image_item?.media ?? uploaded.item.file_item?.media ?? {})))

// ── 回环自检：用刚拿到的 CDN 引用把自己下载回来，逐字节比对 ──
// 这一步能在"发到客户端"之前，先证明 CDN 引用与密钥是自洽可用的。
const ref = uploaded.item.image_item?.media ?? uploaded.item.file_item?.media ?? uploaded.item.video_item?.media
console.log('')
console.log('  CDNMedia =', JSON.stringify({
  encrypt_query_param: String(ref.encrypt_query_param).slice(0, 40) + '…(len=' + String(ref.encrypt_query_param).length + ')',
  aes_key: String(ref.aes_key).slice(0, 24) + '…(len=' + String(ref.aes_key).length + ')',
  encrypt_type: ref.encrypt_type,
}))
try {
  const back = await downloadAndDecrypt({
    encryptQueryParam: ref.encrypt_query_param,
    fullUrl: ref.full_url,
    aesKeyBase64: ref.aes_key,
    cdnBaseUrl: account.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c',
    label: 'verify',
    log,
  })
  const original = fs.readFileSync(filePath)
  console.log(
    '  回环自检:',
    back.length === original.length && Buffer.compare(back, original) === 0
      ? `✅ 逐字节一致（${back.length} 字节）`
      : `❌ 不一致：下载 ${back.length} vs 原始 ${original.length}`,
  )
} catch (error) {
  console.log('  回环自检: ❌ 下载失败:', String(error))
}

const useContext = !process.argv.includes('--no-context')
const ctxToken = useContext ? contextToken : undefined
if (!useContext) console.log('  （不带 context_token 发送）')

try {
  await sendText({
    baseUrl: account.baseUrl ?? 'https://ilinkai.weixin.qq.com',
    token: account.token,
    toUserId: userId,
    text: `[测试] 下面应该跟着一个文件：${filePath.split(/[\\/]/).pop()}（mode=${referenceMode}）。只看到这句、没有文件 → 被丢弃。`,
    contextToken: ctxToken,
    botAgent: 'DSH-Weixin-Channel/0.1.0',
  })
  console.log('  说明文字已发出')
} catch (error) {
  console.log('  说明文字发送失败（不阻塞媒体发送）:', String(error))
}

const msg = {
  from_user_id: '',
  to_user_id: userId,
  client_id: generateClientId(),
  message_type: 2,
  message_state: 2,
  item_list: [uploaded.item],
  context_token: ctxToken,
}

const resp = await sendMessage({
  baseUrl: account.baseUrl ?? 'https://ilinkai.weixin.qq.com',
  token: account.token,
  msg,
  botAgent: 'DSH-Weixin-Channel/0.1.0',
})

console.log('')
console.log(`SEND MEDIA OK -> kind=${uploaded.kind} name=${uploaded.fileName} bytes=${uploaded.rawsize}`)
console.log('resp =', JSON.stringify(resp))
