import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  AppServerJsonRpcClient,
  CodexAppServerRuntime,
  buildCodexAppServerSpawn,
  mapAppServerNotification,
  shouldTerminateAppServerChild,
} from '../dist/appServerRuntime.js';
import {
  createClaudeCodeEventMapper,
} from '../dist/claudeCodeRuntime.js';
import {
  applyCodexResourceEnv,
  buildRuntimeRetryParams,
  buildRuntimePolicy,
  isRuntimeConnectionClosedEvent,
  isRetryableThreadError,
  loadCodexResourceLimits,
  runtimeDisplayNameForKind,
  selectCodexRuntimeKind,
  shouldFlushFinalStreamState,
} from '../dist/runtime.js';

const collectTimeout = Symbol('collectTimeout');

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

function createChildHarness(pid = 1234) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes = [];
  stdin.on('data', (chunk) => {
    writes.push(...String(chunk).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid,
    exitCode: null,
    kill() {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      return true;
    },
  });
  return { child, stdout, writes };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function collectEvents(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function collectEventsWithTimeout(iterable, timeoutMs = 50) {
  return Promise.race([
    collectEvents(iterable),
    new Promise((resolve) => setTimeout(() => resolve(collectTimeout), timeoutMs)),
  ]);
}

function findRequest(writes, method, predicate = () => true) {
  for (let index = writes.length - 1; index >= 0; index--) {
    const entry = writes[index];
    if (entry.method === method && predicate(entry)) return entry;
  }
  return null;
}

function writeResponse(stdout, request, result) {
  stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
}

test('selects exec SDK runtime unless app-server is explicitly enabled', () => {
  assert.equal(selectCodexRuntimeKind({}), 'exec-sdk');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'exec-sdk' }), 'exec-sdk');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'app-server' }), 'app-server');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'claude-code' }), 'claude-code');
  assert.equal(selectCodexRuntimeKind({ CODEX_RUNTIME: 'invalid' }), 'exec-sdk');
});

test('formats runtime display name from Claude model by default', () => {
  assert.equal(runtimeDisplayNameForKind('exec-sdk', {}, undefined), 'Codex');
  assert.equal(runtimeDisplayNameForKind('app-server', {}, undefined), 'Codex');
  assert.equal(runtimeDisplayNameForKind('claude-code', {}, undefined), 'ClaudeCode');
  assert.equal(runtimeDisplayNameForKind('claude-code', {}, 'sonnet'), 'ClaudeCode/sonnet');
  assert.equal(runtimeDisplayNameForKind('claude-code', { CODEX_MODEL: 'opus' }, undefined), 'ClaudeCode/opus');
  assert.equal(runtimeDisplayNameForKind('claude-code', { CLAUDE_CODE_MODEL: 'haiku' }, 'sonnet'), 'ClaudeCode/haiku');
  assert.equal(runtimeDisplayNameForKind('claude-code', { CLAUDE_CODE_DISPLAY_NAME: 'Claude Bot' }, 'sonnet'), 'Claude Bot');
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

test('app-server stop is skipped while another active turn still uses the same child', () => {
  const currentChild = { pid: 123, exitCode: null };
  const replacementChild = { pid: 456, exitCode: null };

  assert.equal(shouldTerminateAppServerChild(currentChild, currentChild, 1), false);
  assert.equal(shouldTerminateAppServerChild(replacementChild, currentChild, 0), false);
  assert.equal(shouldTerminateAppServerChild(currentChild, currentChild, 0), true);
});

test('runtime retry keeps the existing Feishu target message id', () => {
  const params = {
    chatId: 'chat-1',
    senderOpenId: 'ou-user',
    sessionKey: 'chat-1:ou-user',
    sourceMessageId: 'om-source',
    userText: 'hello',
    id: 'task-1',
    privileged: false,
    targetMessageId: null,
    isInterrupted: () => false,
  };

  const retryParams = buildRuntimeRetryParams(params, 'om-target');

  assert.equal(retryParams.targetMessageId, 'om-target');
  assert.equal(retryParams.retried, true);
  assert.equal(params.targetMessageId, null);
  assert.equal(params.retried, undefined);
});

test('runtime retry accepts stale thread errors only once', () => {
  assert.equal(isRetryableThreadError('thread not found: thread-1', false), true);
  assert.equal(isRetryableThreadError('app-server JSON-RPC client closed', false), true);
  assert.equal(isRetryableThreadError('JSON-RPC client closed', false), true);
  assert.equal(isRetryableThreadError('thread not found: thread-1', true), false);
  assert.equal(isRetryableThreadError('permission denied', false), false);
});

test('detects runtime connection closed events for session identity cleanup', () => {
  assert.equal(isRuntimeConnectionClosedEvent({
    type: 'turn.failed',
    error: { message: 'app-server JSON-RPC client closed' },
  }), true);
  assert.equal(isRuntimeConnectionClosedEvent({
    type: 'error',
    message: 'JSON-RPC client is closed',
  }), true);
  assert.equal(isRuntimeConnectionClosedEvent({
    type: 'turn.failed',
    error: { message: 'permission denied' },
  }), false);
  assert.equal(isRuntimeConnectionClosedEvent({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'done' },
  }), false);
});

test('stream final update is skipped after delegating retry to avoid stale card overwrite', () => {
  const runningState = { phase: 'running', responseText: 'partial' };
  const failedState = { phase: 'failed', responseText: 'partial' };

  assert.equal(shouldFlushFinalStreamState(failedState, runningState, true), false);
  assert.equal(shouldFlushFinalStreamState(failedState, runningState, false), true);
  assert.equal(shouldFlushFinalStreamState(runningState, runningState, false), false);
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

test('JSON-RPC client reports close instead of request abort for pending signaled requests', async () => {
  const { client } = createRpcHarness();
  const controller = new AbortController();
  const promise = client.request('turn/start', { threadId: 'thread-1' }, controller.signal);

  client.close();

  await assert.rejects(promise, /app-server JSON-RPC client closed/);
});

test('app-server runtime throws when the JSON-RPC client closes mid-turn so caller can retry', async () => {
  const { client, stdout, writes } = createRpcHarness();
  const runtime = new CodexAppServerRuntime({ env: {}, client });
  const policy = buildRuntimePolicy({
    env: {},
    workingDirectory: '/tmp/project',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  });

  const threadPromise = runtime.startThread(policy);
  await tick();
  stdout.write(JSON.stringify({ id: writes[0].id, result: { thread: { id: 'thread-1' } } }) + '\n');
  const thread = await threadPromise;

  const { events } = await thread.runStreamed('hello');
  const collected = collectEventsWithTimeout(events);
  await tick();
  stdout.write(JSON.stringify({ id: writes[1].id, result: { turn: { id: 'turn-1' } } }) + '\n');
  await tick();
  client.close();

  await assert.rejects(collected, /app-server JSON-RPC client closed/);
});

test('app-server runtime creates a new client after cached client closes before process exit', async () => {
  const first = createRpcHarness();
  let spawned = null;
  const runtime = new CodexAppServerRuntime({
    env: {},
    client: first.client,
    spawnFn: () => {
      spawned = createChildHarness(5678);
      return spawned.child;
    },
  });

  first.client.close();
  const listPromise = runtime.listThreads({ limit: 1 });
  await tick();

  assert.notEqual(spawned, null);
  assert.equal(spawned.writes[0].method, 'initialize');
  spawned.stdout.write(JSON.stringify({ id: spawned.writes[0].id, result: {} }) + '\n');
  await tick();
  const listRequest = spawned.writes.find((entry) => entry.method === 'thread/list');
  assert.ok(listRequest);
  spawned.stdout.write(JSON.stringify({
    id: listRequest.id,
    result: { data: [], nextCursor: null },
  }) + '\n');

  assert.deepEqual(await listPromise, []);
  spawned.child.emit('exit', 0, null);
});

test('aborting one app-server turn does not terminate a shared child while another turn is active', async () => {
  const spawned = createChildHarness(24680);
  const originalKill = process.kill;
  const killCalls = [];
  process.kill = (pid, signal) => {
    killCalls.push({ pid, signal });
    return true;
  };

  try {
    const runtime = new CodexAppServerRuntime({
      env: {},
      spawnFn: () => spawned.child,
      resourceLimits: {
        maxActiveTasks: 2,
        taskTimeoutMs: 1000,
        processNice: 0,
        cpuTimeSeconds: 0,
        goMaxProcs: 2,
        goFlags: '-p=1',
        goMemoryLimit: '',
        appServerIdleShutdownMs: 0,
        interruptKillGraceMs: 5,
        processGroupKill: false,
      },
    });
    const policy = buildRuntimePolicy({
      env: {},
      workingDirectory: '/tmp/project',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });

    const firstThreadPromise = runtime.startThread(policy);
    await tick();
    writeResponse(spawned.stdout, findRequest(spawned.writes, 'initialize'), {});
    await tick();
    writeResponse(spawned.stdout, findRequest(spawned.writes, 'thread/start'), { thread: { id: 'thread-1' } });
    const firstThread = await firstThreadPromise;

    const secondThreadPromise = runtime.startThread(policy);
    await tick();
    writeResponse(spawned.stdout, findRequest(spawned.writes, 'thread/start'), { thread: { id: 'thread-2' } });
    const secondThread = await secondThreadPromise;

    const controller = new AbortController();
    const { events: firstEvents } = await firstThread.runStreamed('one', { signal: controller.signal });
    const { events: secondEvents } = await secondThread.runStreamed('two');
    const firstCollected = collectEventsWithTimeout(firstEvents, 100);
    const secondCollected = collectEventsWithTimeout(secondEvents, 100);
    await tick();

    writeResponse(
      spawned.stdout,
      findRequest(spawned.writes, 'turn/start', (entry) => entry.params.threadId === 'thread-1'),
      { turn: { id: 'turn-1' } },
    );
    writeResponse(
      spawned.stdout,
      findRequest(spawned.writes, 'turn/start', (entry) => entry.params.threadId === 'thread-2'),
      { turn: { id: 'turn-2' } },
    );
    await tick();

    controller.abort();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(await firstCollected, []);
    assert.deepEqual(killCalls, []);

    spawned.stdout.write(JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-2',
        turnId: 'turn-2',
        turn: { id: 'turn-2', status: 'completed' },
      },
    }) + '\n');

    assert.deepEqual(await secondCollected, [{ type: 'turn.completed' }]);
    assert.deepEqual(killCalls, []);
    spawned.child.emit('exit', 0, null);
  } finally {
    process.kill = originalKill;
  }
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
