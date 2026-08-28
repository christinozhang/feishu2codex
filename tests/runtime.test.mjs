import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  AppServerJsonRpcClient,
  CodexAppServerRuntime,
  buildCodexAppServerSpawn,
  mapAppServerNotification,
} from '../dist/appServerRuntime.js';
import {
  createClaudeCodeEventMapper,
} from '../dist/claudeCodeRuntime.js';
import {
  applyCodexResourceEnv,
  buildRuntimePolicy,
  loadCodexResourceLimits,
  selectCodexRuntimeKind,
} from '../dist/runtime.js';

function createRpcHarness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const writes = [];
  stdin.on('data', (chunk) => {
    writes.push(...String(chunk).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  });
  const client = new AppServerJsonRpcClient({ stdin, stdout });
  return { client, stdout, writes };
}

test('selects exec SDK runtime unless app-server is explicitly enabled', () => {
  assert.equal(selectCodexRuntimeKind({}), 'exec-sdk');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'exec-sdk' }), 'exec-sdk');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'app-server' }), 'app-server');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'claude-code' }), 'claude-code');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'invalid' }), 'exec-sdk');
});

test('builds shared runtime policy from environment and task policy', () => {
  const policy = buildRuntimePolicy({
    env: {
      CODEX_MODEL: 'gpt-5.4',
      CODEX_REASONING_EFFORT: 'high',
      CODEX_WEB_SEARCH_ENABLED: 'false',
      CODEX_SKIP_GIT_CHECK: 'false',
      CODEX_DESKTOP_LIST_DIRECTORY: '/tmp/sidebar',
    },
    workingDirectory: '/tmp/project',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  });

  assert.equal(policy.model, 'gpt-5.4');
  assert.equal(policy.reasoningEffort, 'high');
  assert.equal(policy.webSearchEnabled, false);
  assert.equal(policy.skipGitRepoCheck, false);
  assert.equal(policy.workingDirectory, '/tmp/project');
  assert.equal(policy.desktopListDirectory, '/tmp/sidebar');
  assert.equal(policy.sandboxMode, 'workspace-write');
});

test('loads resource limits with protective defaults and env overrides', () => {
  const defaults = loadCodexResourceLimits({}, 'darwin');
  assert.equal(defaults.maxActiveTasks, 1);
  assert.equal(defaults.taskTimeoutMs, 20 * 60 * 1000);
  assert.equal(defaults.processNice, 10);
  assert.equal(defaults.goMaxProcs, 2);
  assert.equal(defaults.goFlags, '-p=1');
  assert.equal(defaults.goMemoryLimit, '');
  assert.equal(defaults.appServerIdleShutdownMs, 60 * 1000);
  assert.equal(defaults.interruptKillGraceMs, 5000);
  assert.equal(defaults.processGroupKill, true);

  const custom = loadCodexResourceLimits({
    CODEX_MAX_ACTIVE_TASKS: '2',
    CODEX_TASK_TIMEOUT_MS: '30000',
    CODEX_PROCESS_NICE: '5',
    CODEX_CPU_TIME_SECONDS: '600',
    CODEX_CHILD_GOMAXPROCS: '4',
    CODEX_CHILD_GOFLAGS: '-p=2 -vet=off',
    CODEX_CHILD_GOMEMLIMIT: '3GiB',
    CODEX_APP_SERVER_IDLE_SHUTDOWN_MS: '10000',
    CODEX_INTERRUPT_KILL_GRACE_MS: '1000',
    CODEX_PROCESS_GROUP_KILL: 'false',
  }, 'darwin');
  assert.equal(custom.maxActiveTasks, 2);
  assert.equal(custom.taskTimeoutMs, 30000);
  assert.equal(custom.processNice, 5);
  assert.equal(custom.cpuTimeSeconds, 600);
  assert.equal(custom.goMaxProcs, 4);
  assert.equal(custom.goFlags, '-p=2 -vet=off');
  assert.equal(custom.goMemoryLimit, '3GiB');
  assert.equal(custom.appServerIdleShutdownMs, 10000);
  assert.equal(custom.interruptKillGraceMs, 1000);
  assert.equal(custom.processGroupKill, false);
});

test('applies Go resource limits to Codex child environment', () => {
  const env = applyCodexResourceEnv({
    PATH: '/usr/bin',
    GOMAXPROCS: '8',
  }, {
    maxActiveTasks: 1,
    taskTimeoutMs: 1000,
    processNice: 10,
    cpuTimeSeconds: 0,
    goMaxProcs: 2,
    goFlags: '-p=1',
    goMemoryLimit: '3GiB',
    appServerIdleShutdownMs: 1000,
    interruptKillGraceMs: 5000,
    processGroupKill: true,
  });

  assert.equal(env.GOMAXPROCS, '2');
  assert.equal(env.GOFLAGS, '-p=1');
  assert.equal(env.GOMEMLIMIT, '3GiB');
  assert.equal(env.PATH, '/usr/bin');
});

test('builds app-server spawn command with unix resource wrapper', () => {
  const spawn = buildCodexAppServerSpawn('/usr/local/bin/codex', {
    maxActiveTasks: 1,
    taskTimeoutMs: 1000,
    processNice: 10,
    cpuTimeSeconds: 60,
    goMaxProcs: 2,
    goFlags: '-p=1',
    goMemoryLimit: '',
    appServerIdleShutdownMs: 1000,
    interruptKillGraceMs: 5000,
    processGroupKill: true,
  }, 'darwin');

  assert.equal(spawn.command, '/bin/bash');
  assert.deepEqual(spawn.args.slice(2), ['/usr/local/bin/codex', 'app-server', '--listen', 'stdio://']);
  assert.match(spawn.args[1], /ulimit -t 60/);
  assert.match(spawn.args[1], /nice -n 10/);
  assert.equal(spawn.detached, true);
});

test('JSON-RPC client writes newline-delimited requests and resolves matching response', async () => {
  const { client, stdout, writes } = createRpcHarness();
  const promise = client.request('thread/list', { limit: 1 });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'thread/list');
  assert.deepEqual(writes[0].params, { limit: 1 });

  stdout.write(JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'other' } }) + '\n');
  stdout.write(JSON.stringify({ id: writes[0].id, result: { data: [] } }) + '\n');

  assert.deepEqual(await promise, { data: [] });
  client.close();
});

test('JSON-RPC client rejects app-server errors', async () => {
  const { client, stdout, writes } = createRpcHarness();
  const promise = client.request('thread/read', { threadId: 'missing' });

  stdout.write(JSON.stringify({ id: writes[0].id, error: { message: 'not found' } }) + '\n');

  await assert.rejects(promise, /not found/);
  client.close();
});

test('app-server runtime lists desktop threads without reading turns', async () => {
  const { client, stdout, writes } = createRpcHarness();
  const runtime = new CodexAppServerRuntime({ env: {}, client });

  const promise = runtime.listThreads({ searchTerm: 'desktop', limit: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes[0].method, 'thread/list');
  assert.deepEqual(writes[0].params, {
    limit: 2,
    archived: false,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    sourceKinds: ['vscode'],
    searchTerm: 'desktop',
  });

  stdout.write(JSON.stringify({
    id: writes[0].id,
    result: {
      data: [{
        id: 'thread-1',
        name: '命名线程',
        preview: '查看问题',
        cwd: '/tmp/project',
        source: 'vscode',
        status: { type: 'idle' },
        updatedAt: 1779190000,
      }],
      nextCursor: null,
    },
  }) + '\n');

  const threads = await promise;
  assert.deepEqual(threads, [{
    id: 'thread-1',
    title: '命名线程',
    preview: '查看问题',
    cwd: '/tmp/project',
    source: 'vscode',
    status: 'idle',
    updatedAt: 1779190000,
  }]);
  assert.equal(writes.some((entry) => entry.method === 'thread/read'), false);
  client.close();
});

test('maps app-server assistant deltas and completed item to Codex stream events', () => {
  const first = mapAppServerNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'msg-1', delta: 'hello ' },
  });
  const second = mapAppServerNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'msg-1', delta: 'world' },
  });
  const completed = mapAppServerNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      completedAtMs: 1,
      item: { type: 'agentMessage', id: 'msg-1', text: 'hello world', phase: null, memoryCitation: null },
    },
  });

  assert.deepEqual(first, { type: 'item.updated', item: { type: 'agent_message', id: 'msg-1', text: 'hello ' } });
  assert.deepEqual(second, { type: 'item.updated', item: { type: 'agent_message', id: 'msg-1', text: 'hello world' } });
  assert.deepEqual(completed, { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1', text: 'hello world' } });
});

test('maps app-server command events to existing command_execution items', () => {
  const started = mapAppServerNotification({
    method: 'item/started',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      startedAtMs: 1,
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'pwd',
        cwd: '/tmp/project',
        processId: null,
        source: 'exec',
        status: 'running',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    },
  });
  const delta = mapAppServerNotification({
    method: 'item/commandExecution/outputDelta',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'cmd-1', delta: '/tmp/project\n' },
  });
  const completed = mapAppServerNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      completedAtMs: 1,
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'pwd',
        cwd: '/tmp/project',
        processId: null,
        source: 'exec',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: '/tmp/project\n',
        exitCode: 0,
        durationMs: 2,
      },
    },
  });

  assert.equal(started.type, 'item.started');
  assert.equal(started.item.type, 'command_execution');
  assert.equal(started.item.command, 'pwd');
  assert.equal(delta.item.aggregated_output, '/tmp/project\n');
  assert.equal(completed.item.status, 'completed');
  assert.equal(completed.item.exit_code, 0);
});

test('maps turn completion and app-server errors', () => {
  assert.deepEqual(mapAppServerNotification({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'turn', status: { type: 'completed' }, error: null } },
  }), { type: 'turn.completed' });

  assert.deepEqual(mapAppServerNotification({
    method: 'error',
    params: { threadId: 'thread', turnId: 'turn', willRetry: false, error: { message: 'failed' } },
  }), { type: 'error', message: 'failed' });
});

test('maps Claude Code text deltas and result into stream events', () => {
  const mapper = createClaudeCodeEventMapper();

  assert.deepEqual(mapper({
    type: 'system',
    subtype: 'init',
    session_id: 'claude-session-1',
  }), { type: 'session.updated', id: 'claude-session-1' });

  assert.deepEqual(mapper({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
  }), null);

  assert.deepEqual(mapper({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'hello' },
    },
  }), {
    type: 'item.updated',
    item: { type: 'agent_message', id: 'claude-message-1', text: 'hello' },
  });

  assert.deepEqual(mapper({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'claude-session-1',
    result: 'hello',
  }), { type: 'turn.completed' });
});

test('maps Claude Code tool use into command execution events', () => {
  const mapper = createClaudeCodeEventMapper();

  const started = mapper({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
    },
  });
  assert.equal(started.type, 'item.started');
  assert.equal(started.item.type, 'command_execution');
  assert.equal(started.item.command, 'Bash');

  assert.equal(mapper({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
    },
  }), null);

  const completed = mapper({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 2 },
  });
  assert.equal(completed.type, 'item.completed');
  assert.equal(completed.item.type, 'command_execution');
  assert.equal(completed.item.command, 'pwd');
});
