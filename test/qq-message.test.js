'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQQMessage, privatePokeText } = require('../lib/qq-message');

test('structured messages preserve mixed text and decode faces without raw CQ duplication', () => {
  const result = normalizeQQMessage({ raw_message: 'wrong', message: [
    { type: 'text', data: { text: '你好[狗头]' } },
    { type: 'face', data: { id: 14 } },
    { type: 'image', data: { summary: '[抱抱]', url: 'secret-url' } },
  ] });
  assert.match(result, /^你好\[狗头\]\[QQ表情：微笑\]/);
  assert.match(result, /抱抱.*未读取画面/);
  assert.doesNotMatch(result, /secret-url|wrong/);
});

test('CQ fallback handles escaped text, parameters and unknown faces safely', () => {
  const result = normalizeQQMessage({ raw_message: 'A&amp;B[CQ:face,id=99999][CQ:image,summary=你&#44;好,url=secret]&#91;CQ:face,id=14&#93;' });
  assert.match(result, /^A&B\[QQ表情：未知表情 ID 99999\]/);
  assert.match(result, /你,好/);
  assert.ok(result.endsWith('[CQ:face,id=14]'));
  assert.doesNotMatch(result, /secret/);
});

test('attachments and unavailable quotes never expose payloads or invent their content', () => {
  const message = ['record', 'video', 'file', 'reply', 'json', 'xml', 'forward', 'new_type'].map(type => ({ type, data: { id: '123', data: 'secret', url: 'secret' } }));
  const result = normalizeQQMessage({ message });
  assert.match(result, /未转写/);
  assert.match(result, /消息ID：123；原文未提供/);
  assert.match(result, /未展开/);
  assert.doesNotMatch(result, /secret/);
  assert.equal(normalizeQQMessage({ message: [null, {}, { type: 'text', data: null }] }), '[QQ暂不支持的消息类型]');
});

test('only incoming private pokes aimed at this bot are accepted', () => {
  const event = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 123, self_id: 456, target_id: '456' };
  assert.match(privatePokeText(event), /对方戳了戳你/);
  for (const patch of [{ group_id: 99 }, { target_id: 123 }, { user_id: 456 }, { self_id: undefined }, { sub_type: 'input_status' }]) {
    assert.equal(privatePokeText({ ...event, ...patch }), '');
  }
});

test('cards expose only bounded titles and descriptions, including malformed payloads', () => {
  const result = normalizeQQMessage({ message: [{ type: 'json', data: { data: JSON.stringify({ prompt: '音乐分享', meta: { music: { title: '春日影', desc: 'CRYCHIC', jumpUrl: 'secret-url' } } }) } }] });
  assert.match(result, /春日影.*CRYCHIC/);
  assert.doesNotMatch(result, /secret-url/);
  assert.match(normalizeQQMessage({ raw_message: '[CQ:json,data=invalid]' }), /无法解析/);
});

test('game outcomes and mentions use supplied facts only', () => {
  const result = normalizeQQMessage({ self_id: 456, message: [
    { type: 'at', data: { qq: '456' } }, { type: 'dice', data: { result: '6' } },
    { type: 'rps', data: { result: '2' } }, { type: 'dice', data: {} },
  ] });
  assert.match(result, /你（机器人）/);
  assert.match(result, /6点/);
  assert.match(result, /剪刀/);
  assert.match(result, /点数未提供/);
});
