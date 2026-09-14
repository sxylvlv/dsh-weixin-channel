#!/usr/bin/env node
/**
 * 出站 CDN 引用的**逐字节**定案：上传后，穷举候选下载参数与 URL 形态，
 * 每个能 200 的都解密并与原文件比对，找出唯一正确的组合。
 *
 * 用法：node tools/cdn-verify.mjs <绝对路径>
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import { getUploadUrl } from '../lib/ilink.mjs'
import { encryptAesEcb, aesEcbPaddedSize, buildCdnUploadUrl, decryptAesEcb, parseAesKey, classifyOutboundFile, UploadMediaType } from '../lib/media.mjs'

const filePath = process.argv[2]
if (!filePath || !fs.existsSync(filePath)) {
  console.error('用法: node tools/cdn-verify.mjs <存在的绝对路径>')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const stateDir = path.join(dshHome, 'weixin')
const accountIds = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts.json'), 'utf-8'))
const account = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts', `${accountIds.at(-1)}.json`), 'utf-8'))
const baseUrl = account.baseUrl ?? 'https://ilinkai.weixin.qq.com'
const cdnBaseUrl = (account.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/+$/, '')

const plaintext = fs.readFileSync(filePath)
const rawsize = plaintext.length
const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
const filesize = aesEcbPaddedSize(rawsize)
const filekey = randomBytes(16).toString('hex')
const aeskey = randomBytes(16)
const kind = classifyOutboundFile(filePath)
const mediaType = kind === 'image' ? UploadMediaType.IMAGE : kind === 'video' ? UploadMediaType.VIDEO : UploadMediaType.FILE

console.log(`文件: ${path.basename(filePath)}  rawsize=${rawsize}  filesize=${filesize}  kind=${kind}`)

const resp = await getUploadUrl({
  baseUrl, token: account.token, filekey, mediaType,
  toUserId: account.userId, rawsize, rawfilemd5, filesize,
  aeskeyHex: aeskey.toString('hex'), botAgent: 'DSH-Weixin-Channel/0.1.0',
})
const uploadParam = resp.upload_param
const uploadUrl = resp.upload_full_url?.trim() || buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey)

const ciphertext = encryptAesEcb(plaintext, aeskey)
const up = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(ciphertext) })
const headerParam = up.headers.get('x-encrypted-param')
console.log(`上传: HTTP ${up.status}   x-encrypted-param present=${Boolean(headerParam)} (len=${headerParam ? headerParam.length : 0})`)

/** 候选：(说明, 完整下载 URL) */
const candidates = [
  ['header-param', `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(headerParam ?? '')}`],
  ['header-param + filekey', `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(headerParam ?? '')}&filekey=${filekey}`],
  ['upload_param', `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(uploadParam)}`],
  ['upload_param + filekey', `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${filekey}`],
]

const key = parseAesKey(Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'))
let winner = null
for (const [label, url] of candidates) {
  let status = 'n/a'
  try {
    const r = await fetch(url)
    status = r.status
    if (r.status !== 200) {
      console.log(`  ${label.padEnd(24)} HTTP ${status}`)
      continue
    }
    const body = Buffer.from(await r.arrayBuffer())
    let verdict
    try {
      const dec = decryptAesEcb(body, key)
      verdict = dec.length === plaintext.length && Buffer.compare(dec, plaintext) === 0
        ? `✅ 解密后逐字节一致（${dec.length} 字节）`
        : `⚠️ 解密成功但内容不同（${dec.length} vs ${plaintext.length}）`
      if (verdict.startsWith('✅') && !winner) winner = label
    } catch (error) {
      verdict = `⚠️ 解密失败: ${String(error).slice(0, 80)}`
    }
    console.log(`  ${label.padEnd(24)} HTTP 200  ${verdict}`)
  } catch (error) {
    console.log(`  ${label.padEnd(24)} 网络错误 ${String(error)}`)
  }
}

console.log('')
console.log(winner ? `>>> 唯一可用组合: ${winner}` : '>>> 没有任何组合可用')
