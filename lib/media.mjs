/**
 * 入站媒体：CDN 下载 + AES-128-ECB 解密 + 类型识别。
 *
 * 全部按 @tencent-weixin/openclaw-weixin@2.4.8 的源实现照搬语义：
 *   src/cdn/pic-decrypt.ts   downloadAndDecryptBuffer / parseAesKey
 *   src/cdn/cdn-url.ts       buildCdnDownloadUrl（ENABLE_CDN_URL_FALLBACK = true）
 *   src/cdn/aes-ecb.ts       decryptAesEcb（aes-128-ecb + PKCS7）
 *   src/media/media-download.ts  每种类型的取 key / URL 规则
 *
 * 已知的坑（照搬自源注释）：
 *   - aes_key 有两种编码：base64(16 字节裸密钥) 与 base64(32 字符 hex 字符串)
 *   - 图片优先用 image_item.aeskey（hex），否则用 media.aes_key；**两者都没有时走明文下载**
 *   - 语音/文件/视频必须同时有 URL 与 aes_key
 */

import { createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getUploadUrl } from './ilink.mjs'

/** 源实现 UploadMediaType */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }

/** 源实现的 WEIXIN_MEDIA_MAX_BYTES */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

/** 源实现 ENABLE_CDN_URL_FALLBACK = true */
export const CDN_URL_FALLBACK = true

export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }

export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** base64 → 16 字节裸密钥，或 32 字符 hex → 16 字节。 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64), 'base64')
  if (decoded.length === 16) return decoded
  const ascii = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex')
  throw new Error(`aes_key 无法解析：base64 解码后 ${decoded.length} 字节（期望 16 字节裸密钥或 32 字符 hex）`)
}

async function fetchCdnBytes(url, label, log) {
  let res
  try {
    res = await fetch(url)
  } catch (error) {
    throw new Error(`${label}: 网络错误 url=${url} err=${String(error)}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)')
    throw new Error(`${label}: CDN 返回 ${res.status} body=${String(body).slice(0, 200)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_MEDIA_BYTES) throw new Error(`${label}: 媒体超过上限 ${buf.length} > ${MAX_MEDIA_BYTES}`)
  log.debug(`${label}: 下载 ${buf.length} 字节`)
  return buf
}

function resolveUrl({ encryptQueryParam, fullUrl, cdnBaseUrl, label }) {
  if (fullUrl) return fullUrl
  if (CDN_URL_FALLBACK && encryptQueryParam) return buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl)
  throw new Error(`${label}: 缺少 full_url 且无法回退拼接 CDN 地址`)
}

/** 下载并 AES 解密。 */
export async function downloadAndDecrypt({ encryptQueryParam, aesKeyBase64, cdnBaseUrl, fullUrl, label, log }) {
  const key = parseAesKey(aesKeyBase64)
  const url = resolveUrl({ encryptQueryParam, fullUrl, cdnBaseUrl, label })
  const encrypted = await fetchCdnBytes(url, label, log)
  const plain = decryptAesEcb(encrypted, key)
  log.debug(`${label}: 解密后 ${plain.length} 字节`)
  return plain
}

/** 明文下载（图片无密钥时的路径）。 */
export async function downloadPlain({ encryptQueryParam, cdnBaseUrl, fullUrl, label, log }) {
  const url = resolveUrl({ encryptQueryParam, fullUrl, cdnBaseUrl, label })
  return fetchCdnBytes(url, label, log)
}

/** 按 magic bytes 识别图片类型；DSH 只接受 png/jpeg/webp/gif。 */
export function sniffImageMediaType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.toString('ascii', 0, 6).startsWith('GIF8')) return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

// ── 出站：本地文件 → CDN 上传 → 消息项 ──────────────────────────────────────
// 全部按 @tencent-weixin/openclaw-weixin@2.4.8 的 src/cdn/{upload,cdn-upload}.ts 照搬：
//   getUploadUrl(filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, no_need_thumb, aeskey)
//   → POST 密文到 upload_full_url 或 {cdnBaseUrl}/upload?encrypted_query_param=<uploadParam>&filekey=<filekey>
//   → 下载参数取自响应头 `x-encrypted-param`
//   → CDNMedia = { encrypt_query_param: 下载参数, aes_key: base64(16字节密钥), encrypt_type: 1 }

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** PKCS7 补齐后的密文长度 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

export function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'])

/** 按扩展名决定走图片 / 视频 / 普通文件通道。 */
export function classifyOutboundFile(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return 'file'
}

/**
 * 上传一个本地文件到微信 CDN，返回可直接放进 item_list 的消息项。
 * 4xx 立即失败；5xx/网络错误最多重试 3 次（与源实现一致）。
 *
 * ⚠️ 2026-09-13 实测确认可用的配方（微信端能正常显示，已由用户肉眼确认两次）：
 *      referenceMode   = 'ack-header'   → encrypt_query_param 用上传响应头 x-encrypted-param
 *      includeEncryptType = true        → encrypt_type: 1
 *      includeFullUrl  = false          → **不提供** full_url
 *      aes_key         = base64(32 字符 hex 字符串)
 *   曾把引用参数换成 getUploadUrl 的 upload_param（自认为"更对"），结果媒体不再投递；
 *   也试过加 full_url、去掉 encrypt_type，均失败。三个都是**源实现的原样做法**，
 *   偏离任何一项都会坏——因此全部按源实现，并用本注释钉住。
 */
export async function uploadLocalFileToWeixin({ filePath, toUserId, baseUrl, token, cdnBaseUrl, botAgent, log, includeEncryptType = true, referenceMode = 'ack-header', includeFullUrl = false }) {
  const plaintext = await readFile(filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)
  const kind = classifyOutboundFile(filePath)
  const mediaType = kind === 'image' ? UploadMediaType.IMAGE : kind === 'video' ? UploadMediaType.VIDEO : UploadMediaType.FILE

  log.info(`上传准备 kind=${kind} file=${path.basename(filePath)} rawsize=${rawsize} filesize=${filesize}`)

  const resp = await getUploadUrl({
    baseUrl, token, filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize,
    aeskeyHex: aeskey.toString('hex'), botAgent,
  })
  const uploadFullUrl = resp.upload_full_url?.trim()
  const uploadParam = resp.upload_param
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`getUploadUrl 未返回上传地址: ${JSON.stringify(resp).slice(0, 200)}`)
  }
  if (!uploadParam) {
    throw new Error('getUploadUrl 未返回 upload_param —— 下载引用需要它（见下方实测结论）')
  }

  const ciphertext = encryptAesEcb(plaintext, aeskey)
  const url = uploadFullUrl || buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey)

  let uploaded = false
  let ackParam
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const detail = res.headers.get('x-error-message') ?? (await res.text().catch(() => ''))
        throw new Error(`CDN 上传客户端错误 ${res.status}: ${String(detail).slice(0, 200)}`)
      }
      if (res.status !== 200) {
        throw new Error(`CDN 上传服务端错误 ${res.status}: ${res.headers.get('x-error-message') ?? ''}`)
      }
      ackParam = res.headers.get('x-encrypted-param') ?? undefined
      uploaded = true
      log.info(`CDN 上传成功 attempt=${attempt} filekey=${filekey} ackHeader=${ackParam ? 'present' : 'absent'}`)
      break
    } catch (error) {
      lastError = error
      if (String(error).includes('客户端错误')) throw error
      if (attempt < 3) log.warn(`CDN 上传第 ${attempt} 次失败，重试: ${String(error)}`)
    }
  }
  if (!uploaded) throw lastError ?? new Error('CDN 上传三次均失败')

  // ⚠️ 实测结论（tools/cdn-verify.mjs 逐字节验证，2026-09-13）：
  //   下载引用必须用 getUploadUrl 返回的 **upload_param**；
  //   用上传响应头 x-encrypted-param 去 /download?encrypted_query_param=… 会得到 HTTP 400。
  //   这一点**与源实现的写法不同**（源用响应头），以字节级回环自检结果为准。
  const downloadUrlFrom = (param) => `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(param)}`

  // 观测事实（两次用户反馈合起来）：
  //   用上传响应头 x-encrypted-param 作 encrypt_query_param → 消息**被投递**，但客户端取不到（400/已过期）
  //   用 upload_param 作 encrypt_query_param → 消息**根本不投递**，但我立刻 GET 得到 200
  // 推论：服务端校验用的参数 ≠ 客户端取图用的参数，因此支持分开指定。
  //   upload-param : 两者都用 upload_param
  //   ack-header   : 两者都用响应头
  //   split        : encrypt_query_param 用响应头（求投递）、full_url 用 upload_param（求可取）
  const encParam = referenceMode === 'upload-param' ? uploadParam : (ackParam ?? uploadParam)
  const urlParam = referenceMode === 'ack-header' ? (ackParam ?? uploadParam) : uploadParam

  const media = {
    encrypt_query_param: encParam,
    // base64(32 字符 hex 字符串)，不是 base64(16 字节裸密钥)
    aes_key: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'),
    // ⚠️ 已验证可用的配方（2026-09-13 21:31 实测在微信端正常显示）：
    //    encrypt_query_param = getUploadUrl 返回的 upload_param
    //    aes_key             = base64(hex 字符串)
    //    encrypt_type        = 1
    //    full_url            = **不提供**（提供后消息反而不投递）
    // 后续实验证明：去掉 encrypt_type、或加上 full_url、或改用上传响应头参数，都会失败。
    ...(includeEncryptType ? { encrypt_type: 1 } : {}),
    ...(includeFullUrl ? { full_url: downloadUrlFrom(urlParam) } : {}),
  }
  const fileName = path.basename(filePath)
  let item
  if (kind === 'image') item = { type: MessageItemType.IMAGE, image_item: { media, mid_size: filesize } }
  else if (kind === 'video') item = { type: MessageItemType.VIDEO, video_item: { media, video_size: filesize } }
  else item = { type: MessageItemType.FILE, file_item: { media, file_name: fileName, len: String(rawsize) } }

  return { item, kind, fileName, rawsize, filesize, filekey }
}

/**
 * 侦察用：把一个媒体项的**字段结构**描述出来，便于确认真实协议字段。
 * 只输出键名与长度，不泄漏密钥明文。
 */
export function describeMediaItem(item) {
  const t = item?.type
  const pick = (obj, keys) => {
    const out = {}
    for (const k of keys) {
      if (obj?.[k] === undefined) continue
      const v = obj[k]
      out[k] = typeof v === 'string' && k !== 'full_url' ? `${v.slice(0, 16)}…(len=${v.length})` : v
    }
    return out
  }
  if (t === MessageItemType.IMAGE) {
    const it = item.image_item ?? {}
    return { type: 'IMAGE', keys: Object.keys(it), media: pick(it.media, ['encrypt_query_param', 'aes_key', 'encrypt_type', 'full_url']), hasAeskeyHex: Boolean(it.aeskey), url: it.url ? 'present' : undefined, mid_size: it.mid_size }
  }
  if (t === MessageItemType.VOICE) {
    const it = item.voice_item ?? {}
    return { type: 'VOICE', keys: Object.keys(it), media: pick(it.media, ['encrypt_query_param', 'aes_key', 'full_url']), encode_type: it.encode_type, hasText: Boolean(it.text), playtime: it.playtime }
  }
  if (t === MessageItemType.FILE) {
    const it = item.file_item ?? {}
    return { type: 'FILE', keys: Object.keys(it), media: pick(it.media, ['encrypt_query_param', 'aes_key', 'full_url']), file_name: it.file_name, len: it.len, md5: it.md5 ? 'present' : undefined }
  }
  if (t === MessageItemType.VIDEO) {
    const it = item.video_item ?? {}
    return { type: 'VIDEO', keys: Object.keys(it), media: pick(it.media, ['encrypt_query_param', 'aes_key', 'full_url']), video_size: it.video_size, play_length: it.play_length }
  }
  return { type: `UNKNOWN(${t})`, keys: Object.keys(item ?? {}) }
}
