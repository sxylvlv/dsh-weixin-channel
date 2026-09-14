#!/usr/bin/env node
/**
 * 把 CDN 的各个参数**解码出来看结构**，而不是继续猜组合。
 *
 * 对比三样东西：
 *   1. 入站报文里的 encrypted_query_param（服务端给的、确定可用，且带 taskid）
 *   2. getUploadUrl 返回的 upload_param（我 GET 得到 200，但服务端不投递）
 *   3. 上传响应头 x-encrypted-param（服务端肯投递，但 GET 400）
 *
 * 若它们是 base64 的 JSON/结构体，就能看出 taskid 之类的字段藏在哪。
 *
 * 用法：node tools/cdn-decode.mjs [可选:要上传的文件]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import { getUploadUrl } from '../lib/ilink.mjs'
import { encryptAesEcb, aesEcbPaddedSize, buildCdnUploadUrl, UploadMediaType } from '../lib/media.mjs'

const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const stateDir = path.join(dshHome, 'weixin')
const accountIds = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts.json'), 'utf-8'))
const account = JSON.parse(fs.readFileSync(path.join(stateDir, 'accounts', `${accountIds.at(-1)}.json`), 'utf-8'))
const baseUrl = account.baseUrl ?? 'https://ilinkai.weixin.qq.com'
const cdnBaseUrl = (account.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/+$/, '')

function b64ToBuf(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/')
  const pad = t + '='.repeat((4 - (t.length % 4)) % 4)
  return Buffer.from(pad, 'base64')
}

function describe(label, s) {
  if (!s) {
    console.log(`\n=== ${label} ===\n  (缺失)`)
    return
  }
  const buf = b64ToBuf(s)
  const text = buf.toString('utf8')
  const printableRatio = [...text].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length / Math.max(1, text.length)
  console.log(`\n=== ${label} ===`)
  console.log(`  原始长度 ${s.length}   解码后 ${buf.length} 字节`)
  console.log(`  前 8 字节 hex: ${buf.subarray(0, 8).toString('hex')}`)
  if (/^[\s]*[{[]/.test(text)) {
    console.log('  >>> 疑似 JSON，尝试解析：')
    try {
      const obj = JSON.parse(text)
      console.log('  ', JSON.stringify(obj, null, 2).slice(0, 1200))
    } catch (e) {
      console.log('   解析失败:', String(e).slice(0, 100))
    }
  } else if (printableRatio > 0.9) {
    console.log(`  >>> 疑似纯文本，前 300 字符：`)
    console.log('  ', text.slice(0, 300))
  } else {
    console.log('  >>> 二进制。可打印片段：')
    console.log('  ', text.replace(/[^\x20-\x7e]/g, '.').slice(0, 300))
  }
}

// 1) 入站样本
const log = fs.readFileSync(path.join(stateDir, 'channel.log'), 'utf-8').split('\n').filter(Boolean)
const reconLine = log.filter((l) => l.includes('媒体侦察')).pop()
if (reconLine) {
  const j = JSON.parse(reconLine.slice(reconLine.indexOf('{')))
  const u = j.media?.full_url
  if (u) {
    const q = u.slice(u.indexOf('?') + 1).split('&')
    const get = (k) => decodeURIComponent((q.find((p) => p.startsWith(`${k}=`)) ?? '').slice(k.length + 1))
    console.log('### 入站样本（服务端给的，确定可用）')
    console.log('  URL 参数:', q.map((p) => p.slice(0, p.indexOf('='))).join(', '))
    describe('入站 encrypted_query_param', get('encrypted_query_param'))
    console.log(`\n  入站 taskid = ${get('taskid')}  (长度 ${get('taskid').length})`)
  }
} else {
  console.log('### 未找到入站样本（channel.log 里没有媒体侦察记录）')
}

// 2) 我自己上传产生的一组参数
const filePath = process.argv[2] || path.join(stateDir, 'perm-test.txt')
const plaintext = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.from('probe')
const rawsize = plaintext.length
const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
const filesize = aesEcbPaddedSize(rawsize)
const filekey = randomBytes(16).toString('hex')
const aeskey = randomBytes(16)

const resp = await getUploadUrl({
  baseUrl, token: account.token, filekey, mediaType: UploadMediaType.IMAGE,
  toUserId: account.userId, rawsize, rawfilemd5, filesize,
  aeskeyHex: aeskey.toString('hex'), botAgent: 'DSH-Weixin-Channel/0.1.0',
})
console.log('\n\n### 我上传产生的参数（对照）')
console.log('  getUploadUrl 返回字段:', Object.keys(resp).join(', '))
describe('getUploadUrl.upload_param', resp.upload_param)

const ciphertext = encryptAesEcb(plaintext, aeskey)
const url = resp.upload_full_url?.trim() || buildCdnUploadUrl(cdnBaseUrl, resp.upload_param, filekey)
const up = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(ciphertext) })
const ack = up.headers.get('x-encrypted-param')
describe('上传响应头 x-encrypted-param', ack)
console.log(`\n  filekey = ${filekey}  (长度 ${filekey.length})`)
