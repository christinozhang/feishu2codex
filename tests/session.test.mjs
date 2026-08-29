import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bindSessionThreadRecord,
  buildSessionRecord,
  clearRuntimeSessionId,
  listClaudeProjectThreads,
  listRuntimeSessionThreads,
  makeSessionKey,
  normalizeSessionMap,
  runtimeSessionIdField,
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

test('selects the session id field for each runtime kind', () => {
  assert.equal(runtimeSessionIdField('exec-sdk'), 'codex_thread_id');
  assert.equal(runtimeSessionIdField('app-server'), 'codex_thread_id');
  assert.equal(runtimeSessionIdField('claude-code'), 'claude_session_id');
});

test('clears only the current runtime session identity', () => {
  const previous = {
    session_key: 'chat:open',
    chat_id: 'chat',
    sender_open_id: 'open',
    codex_thread_id: 'codex-thread-1',
    claude_session_id: 'claude-session-1',
    model: 'gpt-5.4',
    updated_at: '2026-08-28T00:00:00.000Z',
  };

  const codexCleared = clearRuntimeSessionId(previous, 'app-server');
  assert.equal(codexCleared.codex_thread_id, undefined);
  assert.equal(codexCleared.claude_session_id, 'claude-session-1');
  assert.equal(codexCleared.model, 'gpt-5.4');
  assert.equal(previous.codex_thread_id, 'codex-thread-1');

  const claudeCleared = clearRuntimeSessionId(previous, 'claude-code');
  assert.equal(claudeCleared.codex_thread_id, 'codex-thread-1');
  assert.equal(claudeCleared.claude_session_id, undefined);
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

test('binding a selected Claude session writes the Claude session field only', () => {
  const previous = {
    session_key: 'chat:open',
    chat_id: 'chat',
    sender_open_id: 'open',
    codex_thread_id: 'codex-thread-1',
    claude_session_id: 'claude-session-1',
    model: 'sonnet',
    updated_at: '2026-08-29T00:00:00.000Z',
  };

  const next = bindSessionThreadRecord({
    sessionKey: 'chat:open',
    threadId: 'claude-session-2',
    previous,
    title: 'Claude 会话',
    runtimeKind: 'claude-code',
  });

  assert.equal(next.codex_thread_id, 'codex-thread-1');
  assert.equal(next.claude_session_id, 'claude-session-2');
  assert.equal(next.title, 'Claude 会话');
  assert.equal(next.model, 'sonnet');
});

test('lists stored Claude sessions as thread picker candidates', () => {
  const sessions = {
    'chat-a:open-a': {
      session_key: 'chat-a:open-a',
      chat_id: 'chat-a',
      sender_open_id: 'open-a',
      claude_session_id: 'claude-session-a',
      title: 'README 调整',
      updated_at: '2026-08-29T02:00:00.000Z',
    },
    'chat-b:open-b': {
      session_key: 'chat-b:open-b',
      chat_id: 'chat-b',
      sender_open_id: 'open-b',
      claude_session_id: 'claude-session-b',
      title: '其他任务',
      updated_at: '2026-08-29T03:00:00.000Z',
    },
    'chat-c:open-c': {
      session_key: 'chat-c:open-c',
      chat_id: 'chat-c',
      sender_open_id: 'open-c',
      codex_thread_id: 'codex-thread-c',
      title: 'README Codex',
      updated_at: '2026-08-29T04:00:00.000Z',
    },
  };

  const threads = listRuntimeSessionThreads(sessions, 'claude-code', {
    searchTerm: 'readme',
    limit: 1,
  });

  assert.deepEqual(threads, [{
    id: 'claude-session-a',
    title: 'README 调整',
    preview: 'chat-a:open-a',
    cwd: '',
    source: 'claude-code',
    status: 'idle',
    updatedAt: Date.parse('2026-08-29T02:00:00.000Z'),
  }]);
});

test('lists Claude project JSONL history as thread picker candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'));
  const projectDir = path.join(root, '-tmp-project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-a.jsonl'), [
    JSON.stringify({
      type: 'user',
      sessionId: 'session-a',
      timestamp: '2026-08-29T02:00:00.000Z',
      cwd: '/tmp/project',
      message: { role: 'user', content: 'older prompt' },
    }),
    JSON.stringify({
      type: 'last-prompt',
      sessionId: 'session-a',
      lastPrompt: 'Fix README threads',
    }),
  ].join('\n'));
  fs.writeFileSync(path.join(projectDir, 'session-b.jsonl'), JSON.stringify({
    type: 'user',
    sessionId: 'session-b',
    timestamp: '2026-08-29T03:00:00.000Z',
    cwd: '/tmp/project',
    message: { role: 'user', content: 'other prompt' },
  }));

  const threads = listClaudeProjectThreads(root, {
    searchTerm: 'readme',
    limit: 1,
  });

  assert.deepEqual(threads, [{
    id: 'session-a',
    title: 'Fix README threads',
    preview: 'Fix README threads',
    cwd: '/tmp/project',
    source: 'claude-code',
    status: 'idle',
    updatedAt: Date.parse('2026-08-29T02:00:00.000Z'),
  }]);
});
