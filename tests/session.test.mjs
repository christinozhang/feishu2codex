import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindSessionThreadRecord,
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

test('normalizes model-only session preferences', () => {
  const sessions = normalizeSessionMap({
    'chat-a:open-a': {
      session_key: 'chat-a:open-a',
      chat_id: 'chat-a',
      sender_open_id: 'open-a',
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    },
  });
  assert.equal(sessions['chat-a:open-a'].model, 'gpt-5.4');
  assert.equal(sessions['chat-a:open-a'].reasoning_effort, 'high');
  assert.equal(sessions['chat-a:open-a'].codex_thread_id, undefined);
});

test('normalizes independent Codex and Claude session identities', () => {
  const sessions = normalizeSessionMap({
    'chat-a:open-a': {
      session_key: 'chat-a:open-a',
      chat_id: 'chat-a',
      sender_open_id: 'open-a',
      codex_thread_id: 'codex-thread-1',
      claude_session_id: 'claude-session-1',
      model: 'gpt-5.4',
    },
  });

  assert.equal(sessions['chat-a:open-a'].codex_thread_id, 'codex-thread-1');
  assert.equal(sessions['chat-a:open-a'].claude_session_id, 'claude-session-1');
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

test('builds session record without losing selected model', () => {
  const first = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'thread-1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
  });
  const second = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'thread-2',
    previous: first,
  });

  assert.equal(second.model, 'gpt-5.4');
  assert.equal(second.reasoning_effort, 'high');
});

test('builds Claude session record without changing Codex thread id', () => {
  const previous = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'codex-thread-1',
  });
  const next = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'claude-session-1',
    runtimeKind: 'claude-code',
    previous,
  });

  assert.equal(next.codex_thread_id, 'codex-thread-1');
  assert.equal(next.claude_session_id, 'claude-session-1');
});

test('binds a selected desktop thread without losing session preferences', () => {
  const previous = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'thread-1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    messageId: 'msg-1',
    userText: '旧任务',
  });

  const next = bindSessionThreadRecord({
    sessionKey: 'chat:open',
    threadId: 'thread-desktop',
    previous,
    title: 'Desktop 线程',
  });

  assert.equal(next.codex_thread_id, 'thread-desktop');
  assert.equal(next.model, 'gpt-5.4');
  assert.equal(next.reasoning_effort, 'high');
  assert.equal(next.first_message_id, 'msg-1');
  assert.equal(next.title, 'Desktop 线程');
});

test('binding a selected desktop thread does not change Claude session id', () => {
  const previous = buildSessionRecord({
    sessionKey: 'chat:open',
    chatId: 'chat',
    senderOpenId: 'open',
    threadId: 'claude-session-1',
    runtimeKind: 'claude-code',
  });

  const next = bindSessionThreadRecord({
    sessionKey: 'chat:open',
    threadId: 'codex-thread-2',
    previous,
  });

  assert.equal(next.codex_thread_id, 'codex-thread-2');
  assert.equal(next.claude_session_id, 'claude-session-1');
});
