import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionRecord,
  makeSessionKey,
  normalizeSessionMap,
} from '../dist/session.js';

test('session key includes chat and sender', () => {
  assert.equal(makeSessionKey('chat-a', 'open-a'), 'chat-a:open-a');
  assert.notEqual(makeSessionKey('chat-a', 'open-a'), makeSessionKey('chat-a', 'open-b'));
});

test('normalizes legacy bot_sessions string values', () => {
  const sessions = normalizeSessionMap({ 'chat-a': 'thread-1' });
  assert.equal(sessions['chat-a'].codex_thread_id, 'thread-1');
  assert.equal(sessions['chat-a'].sender_open_id, 'unknown');
});

test('builds structured session record without losing first message', () => {
  const first = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'thread-1',
    messageId: 'msg-1',
    userText: '这是第一条很长的消息'.repeat(10),
  });
  const second = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'thread-1',
    previous: first,
    messageId: 'msg-2',
    userText: '第二条',
  });

  assert.equal(second.first_message_id, 'msg-1');
  assert.equal(second.last_message_id, 'msg-2');
  assert.equal(second.title.length, 60);
});
