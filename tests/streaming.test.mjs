import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentCard,
  createApprovalState,
  createStreamState,
  formatStreamState,
  redact,
  updateStreamState,
} from '../dist/streaming.js';

test('formats agent response and command timeline from Codex events', () => {
  let state = createStreamState('看下状态');

  state = updateStreamState(state, {
    type: 'item.updated',
    item: {
      id: 'msg-1',
      type: 'agent_message',
      text: '正在分析代码路径',
    },
  });
  state = updateStreamState(state, {
    type: 'item.started',
    item: {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'rg "runStreamed" src',
      aggregated_output: '',
      status: 'in_progress',
    },
  });

  const text = formatStreamState(state);
  assert.match(text, /Codex 正在处理/);
  assert.match(text, /回复:\n正在分析代码路径/);
  assert.match(text, /命令执行中/);
  assert.match(text, /rg "runStreamed" src/);
});

test('keeps final response and completed mcp timeline', () => {
  let state = createStreamState('查 mcp');

  state = updateStreamState(state, {
    type: 'item.completed',
    item: {
      id: 'tool-1',
      type: 'mcp_tool_call',
      server: 'context7',
      tool: 'resolve-library-id',
      arguments: { libraryName: 'codex', token: 'secret-token' },
      status: 'completed',
    },
  });
  state = updateStreamState(state, {
    type: 'item.completed',
    item: {
      id: 'msg-2',
      type: 'agent_message',
      text: '已经完成。',
    },
  });
  state = updateStreamState(state, {
    type: 'turn.completed',
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 4,
    },
  });

  assert.equal(state.phase, 'completed');
  assert.equal(state.responseText, '已经完成。');
  assert.doesNotMatch(formatStreamState(state), /secret-token/);
});

test('reports failed turns as readable text', () => {
  let state = createStreamState('失败任务');

  state = updateStreamState(state, {
    type: 'turn.failed',
    error: {
      message: 'Codex Exec exited with code 1',
    },
  });

  assert.equal(state.phase, 'failed');
  assert.match(formatStreamState(state), /Codex 处理失败/);
  assert.match(formatStreamState(state), /Codex Exec exited with code 1/);
});

test('card renders response above collapsible process and supports approval buttons', () => {
  let state = createApprovalState('重启 bot', 'approval-1', 'Sandbox: danger-full-access');
  state = updateStreamState(state, {
    type: 'item.completed',
    item: {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'launchctl kickstart',
      status: 'completed',
      exit_code: 0,
      aggregated_output: 'ok',
    },
  });
  state = updateStreamState(state, {
    type: 'item.completed',
    item: { id: 'msg', type: 'agent_message', text: '完成' },
  });

  const card = buildAgentCard(state);
  const responseTitleIndex = card.elements.findIndex((item) => item.tag === 'markdown' && item.content === '**回复**');
  const panelIndex = card.elements.findIndex((item) => item.tag === 'collapsible_panel');
  const approvalIndex = card.elements.findIndex((item) => item.tag === 'action');
  assert.equal(card.header.template, 'yellow');
  assert.equal(card.elements[responseTitleIndex + 1].tag, 'markdown');
  assert.equal(card.elements[responseTitleIndex + 1].content, '完成');
  assert.ok(responseTitleIndex > -1 && responseTitleIndex < panelIndex);
  assert.ok(panelIndex > -1 && panelIndex < approvalIndex);
  assert.equal(card.elements[approvalIndex].actions[0].value.approval_id, 'approval-1');
  assert.doesNotThrow(() => JSON.stringify(card));
});

test('completed card collapses execution process and command output is truncated', () => {
  let state = createStreamState('长输出');
  state = updateStreamState(state, {
    type: 'item.completed',
    item: {
      id: 'cmd',
      type: 'command_execution',
      command: 'cat big.log',
      status: 'completed',
      exit_code: 0,
      aggregated_output: 'x'.repeat(700),
    },
  });
  state = updateStreamState(state, { type: 'turn.completed' });

  const card = buildAgentCard(state);
  const panel = card.elements.find((item) => item.tag === 'collapsible_panel');
  assert.equal(card.header.template, 'green');
  assert.equal(panel.expanded, false);
  assert.match(JSON.stringify(card), /truncated/);
});

test('card response renders inline code as Feishu text tags and keeps fenced code', () => {
  let state = createStreamState('查看命令');
  state = updateStreamState(state, {
    type: 'item.completed',
    item: {
      id: 'msg',
      type: 'agent_message',
      text: 'Jenkins `eks-autotest` 当前命令：\n\n```text\ncodex exec --experimental-json\n```\n\n`inline`',
    },
  });

  const card = buildAgentCard(state);
  const responseTitleIndex = card.elements.findIndex((item) => item.tag === 'markdown' && item.content === '**回复**');
  const responseContent = card.elements.slice(responseTitleIndex + 1).filter((item) => item.tag === 'markdown').map((item) => item.content).join('\n');
  assert.ok(responseTitleIndex > -1);
  assert.match(responseContent, /Jenkins <text_tag color='grey'>eks-autotest<\/text_tag> 当前命令/);
  assert.match(responseContent, /```\ncodex exec --experimental-json/);
  assert.match(responseContent, /<text_tag color='grey'>inline<\/text_tag>/);
  assert.doesNotMatch(responseContent, /```text|`eks-autotest`|`inline`/);
});

test('redacts sensitive content', () => {
  const text = redact('Authorization: Bearer abc token=secret password=hunter2 FEISHU_APP_SECRET=abc');
  assert.doesNotMatch(text, /hunter2|Bearer abc|token=secret|FEISHU_APP_SECRET=abc/);
});
