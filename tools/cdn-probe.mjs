#!/usr/bin/env node
/**
 * CDN 上传协议侦察：把 getUploadUrl 的响应、实际上传的 URL、以及
 * CDN 返回的**全部响应头与响应体**原样打印出来。
 *
 * 目的：在"发出去但对方打不开"的情况下，搞清下载引用到底该用哪个字段。
 *
 * 用法：node tools/cdn-probe.mjs <绝对路径>
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import { getUploadUrl } from '../lib/ilink.mjs'
import { encryptAesEcb, aesEcbPaddedSize, buildCdnUploadUrl, UploadMediaType } from '../lib/media.mjs'

const filePath = process.argv[2]
if (!filePath || !fs.existsSync(filePath)) {
  console.error('用法: node tools/cdn-probe.mjs <存在的绝对路径>')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const stateDir = path.join(dshHome, 'weixin')
const accountIds = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts.json'), 'utf-8'))
const account = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts', `${accountIds.at(-1)}.json`), 'utf-8'))
const baseUrl = account.baseUrl ?? 'https://ilinkai.weixin.qq.com'
const cdnBaseUrl = account.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c'

const plaintext = fs.readFileSync(filePath)
const rawsize = plaintext.length
const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
const filesize = aesEcbPaddedSize(rawsize)
const filekey = randomBytes(16).toString('hex')
const aeskey = randomBytes(16)

console.log('=== 文件 ===')
console.log(JSON.stringify({ filePath, rawsize, filesize, rawfilemd5, filekey, aeskeyHex: aeskey.toString('hex') }, null, 2))

console.log('\n=== getUploadUrl 响应（原始）===')
const resp = await getUploadUrl({
  baseUrl, token: account.token, filekey,
  mediaType: UploadMediaType.IMAGE,
  toUserId: account.userId,
  rawsize, rawfilemd5, filesize,
  aeskeyHex: aeskey.toString('hex'),
  botAgent: 'DSH-Weixin-Channel/0.1.0',
})
console.log(JSON.stringify(resp, null, 2))

const uploadFullUrl = resp.upload_full_url?.trim()
const uploadParam = resp.upload_param
const url = uploadFullUrl || buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey)
console.log('\n=== 实际上传 URL ===')
console.log(url)
console.log('（来自 upload_full_url:', Boolean(uploadFullUrl), '来自 upload_param:', Boolean(uploadParam), '）')

const ciphertext = encryptAesEcb(plaintext, aeskey)
console.log('\n=== POST 密文 ===')
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: new Uint8Array(ciphertext),
})
console.log('status =', res.status, res.statusText)
console.log('--- 全部响应头 ---')
for (const [k, v] of res.headers.entries()) console.log(`  ${k}: ${v}`)
const body = await res.text().catch(() => '(不可读)')
console.log('--- 响应体 ---')
console.log(body.slice(0, 2000) || '(空)')

// 尝试用响应里出现的每一个候选值构造下载 URL，看看哪个能 200
console.log('\n=== 下载候选探测 ===')
const candidates = []
for (const [k, v] of res.headers.entries()) {
  if (/param|url|token/i.test(k)) candidates.push({ from: `header:${k}`, value: v })
}
if (resp.upload_param && resp.upload_param !== candidates.find((c) => c.from === 'header:x-encrypted-param')?.value) {
  candidates.push({ from: 'getUploadUrl.upload_param', value: resp.upload_param })
}
for (const c of candidates) {
  const dl = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(c.value)}`
  try {
    const r = await fetch(dl)
    console.log(`  ${c.from} (len=${c.value.length}) → download HTTP ${r.status}`)
  } catch (error) {
    console.log(`  ${c.from} → 网络错误 ${String(error)}`)
  }
}
