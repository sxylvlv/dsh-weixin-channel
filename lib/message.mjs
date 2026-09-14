/**
 * 入站消息归一化。
 *
 * 移植自 @tencent-weixin/openclaw-weixin@2.4.8 的 src/messaging/inbound.ts
 * 的 bodyFromItemList / isMediaItem 部分（原文件 9.4KB，其余是 context_token 存储，
 * 已搬到 lib/store.mjs）。
 *
 * 已核语义：
 *   - 文本项 type=1；语音 type=3 且 voice_item.text 可能是服务端转写文本
 *   - 引用消息 ref_msg：若引用的是媒体，正文只取当前文本；否则拼成 `[引用: ...]`
 */

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
}

export function isMediaItem(item) {
  return (
    item?.type === MessageItemType.IMAGE ||
    item?.type === MessageItemType.VIDEO ||
    item?.type === MessageItemType.FILE ||
    item?.type === MessageItemType.VOICE
  )
}

/** 从 item_list 提取文本正文（含引用拼接、语音转写兜底）。 */
export function extractText(message) {
  const itemList = message?.item_list
  if (!itemList?.length) return ''

  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      if (ref.message_item && isMediaItem(ref.message_item)) return text

      const parts = []
      if (ref.title) parts.push(ref.title)
      if (ref.message_item) {
        const refBody = bodyOnly([ref.message_item])
        if (refBody) parts.push(refBody)
      }
      if (parts.length === 0) return text
      return `[引用: ${parts.join(' | ')}]\n${text}`
    }
    // 语音转文字：服务端若已给出 text，直接使用
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

function bodyOnly(itemList) {
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text)
    }
  }
  return ''
}

export const CLASSIFY_UNKNOWN = {
  /** 长任务先回执，避免微信端长时间无响应（原实现走 reply-progress）。 */
  progressAck: '收到，正在处理…',
}
