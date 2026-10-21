'use strict';

// OneBot 11 / NapCat message segments: https://napneko.github.io/develop/msg
const FACE_NAMES = new Map(Object.entries({
  0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪',
  6: '害羞', 7: '闭嘴', 8: '睡', 9: '大哭', 10: '尴尬', 11: '发怒',
  12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过', 16: '酷',
  21: '可爱', 24: '饥饿', 25: '困', 28: '憨笑', 29: '悠闲',
  30: '奋斗', 31: '咒骂', 32: '疑问', 33: '嘘', 34: '晕',
  36: '衰', 37: '骷髅', 38: '敲打', 39: '再见', 49: '拥抱',
  66: '爱心', 67: '心碎', 74: '太阳', 75: '月亮', 76: '赞',
  78: '握手', 85: '飞吻', 96: '冷汗', 97: '擦汗', 98: '抠鼻',
  99: '鼓掌', 104: '哈欠', 105: '鄙视', 106: '委屈', 107: '快哭了',
  109: '左亲亲', 110: '吓', 111: '可怜', 146: '爆筋', 147: '棒棒糖',
}));

function label(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/[\r\n\[\]]/g, ' ').slice(0, 160).trim() : '';
}

function decodeCQ(text) {
  return text.replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',').replace(/&amp;/g, '&');
}

function cardText(value) {
  try {
    if (typeof value === 'string' && value.length > 32000) return '[QQ分享卡片；内容过长，未解析]';
    const card = typeof value === 'string' ? JSON.parse(value) : value;
    if (!card || typeof card !== 'object') return '[QQ分享卡片；未解析卡片内容]';
    const details = [label(card.prompt)];
    if (card.meta && typeof card.meta === 'object') {
      for (const item of Object.values(card.meta).slice(0, 4)) {
        if (!item || typeof item !== 'object') continue;
        details.push(label(item.title), label(item.desc));
      }
    }
    const summary = [...new Set(details.filter(Boolean))].join('；').slice(0, 480);
    return `[QQ分享卡片${summary ? `，文字摘要：${summary}` : ''}；未打开链接或读取媒体]`;
  } catch {
    return '[QQ分享卡片；内容无法解析]';
  }
}

function segmentText(segment, selfId) {
  if (!segment || typeof segment !== 'object') return '';
  const d = segment.data && typeof segment.data === 'object' ? segment.data : {};
  const name = label(d.summary || d.name);
  switch (segment.type) {
    case 'text': return typeof d.text === 'string' ? d.text : '';
    case 'face': return `[QQ表情：${FACE_NAMES.get(String(d.id)) || name || `未知表情 ID ${label(d.id)}`}]`;
    case 'mface': return `[QQ表情包${name ? `：${name}` : '：无文字摘要'}]`;
    case 'image': return `[QQ${d.file === 'marketface' || Number(d.sub_type) > 0 ? '表情图片' : '图片'}${name ? `，文字摘要：${name}` : ''}；未读取画面]`;
    case 'record': return '[QQ语音；未转写内容]';
    case 'video': return '[QQ视频；未读取画面或声音]';
    case 'file': return `[QQ文件${name ? `：${name}` : ''}；未读取文件内容]`;
    case 'reply': return `[QQ引用回复，消息ID：${label(d.id)}；原文未提供]`;
    case 'at': return `[QQ提及：${String(d.qq) === String(selfId) ? '你（机器人）' : d.qq === 'all' ? '全体成员' : label(d.qq)}]`;
    case 'shake': return '[QQ窗口抖动：对方提醒你注意消息]';
    case 'poke': return '[QQ戳一戳互动]';
    case 'dice': return `[QQ骰子${/^[1-6]$/.test(String(d.result)) ? `：${d.result}点` : '；点数未提供'}]`;
    case 'rps': return `[QQ猜拳${['1', '2', '3'].includes(String(d.result)) ? `：${{ 1: '石头', 2: '剪刀', 3: '布' }[d.result]}` : '；结果未提供'}]`;
    case 'share': case 'music': case 'location': case 'contact':
      return `[QQ${{ share: '链接分享', music: '音乐分享', location: '位置分享', contact: '名片分享' }[segment.type]}：${label(d.title || d.name || d.content) || '未提供标题'}；未读取分享内容]`;
    case 'json': return cardText(d.data);
    case 'xml': return '[QQ分享卡片；未解析卡片内容]';
    case 'forward': case 'node': return '[QQ合并转发；未展开聊天记录]';
    default: return '[QQ暂不支持的消息类型]';
  }
}

function normalizeQQMessage(event) {
  if (Array.isArray(event.message)) return event.message.map((s) => segmentText(s, event.self_id)).join('');
  const raw = typeof event.message === 'string' ? event.message : event.raw_message;
  if (typeof raw !== 'string') return '';
  // Decode plain text only after matching, so escaped CQ-looking text remains text.
  let result = '';
  let offset = 0;
  for (const match of raw.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
    result += decodeCQ(raw.slice(offset, match.index));
    const data = Object.create(null);
    for (const field of match[2].split(',').slice(1)) {
      const pos = field.indexOf('=');
      if (pos > 0) data[field.slice(0, pos)] = decodeCQ(field.slice(pos + 1));
    }
    result += segmentText({ type: match[1], data }, event.self_id);
    offset = match.index + match[0].length;
  }
  return result + decodeCQ(raw.slice(offset));
}

function privatePokeText(event) {
  if (event.post_type !== 'notice' || event.notice_type !== 'notify' || event.sub_type !== 'poke') return '';
  if (event.group_id || event.self_id == null || event.target_id == null) return '';
  if (String(event.target_id) !== String(event.self_id) || String(event.user_id) === String(event.self_id)) return '';
  return '[QQ戳一戳：对方戳了戳你，这是QQ互动提醒]';
}

module.exports = { normalizeQQMessage, privatePokeText };
