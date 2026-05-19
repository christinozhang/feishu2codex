import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentCard,
  buildQueueSummaryCard,
  buildQueuedTaskCard,
  createApprovalState,
  createStreamState,
  formatStreamState,
  markStreamInterrupted,
  redact,
  updateStreamState,
} from '../dist/streaming.js';

function cardElements(card) {
  return card.body?.elements || card.elements || [];
}

function markdownText(card) {
  return cardElements(card)
    .filter((item) => item.tag === 'markdown')
    .map((item) => item.content)
    .join('\n');
}

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

test('card renders content stream in event order and supports approval buttons', () => {
  let state = createApprovalState('重启 bot', 'approval-1', 'Sandbox: danger-full-access');
  state = updateStreamState(state, {
    type: 'item.completed',
    item: { id: 'msg-before', type: 'agent_message', text: '准备重启。' },
  });
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
    item: { id: 'msg-after', type: 'agent_message', text: '完成' },
  });

  const card = buildAgentCard(state);
  const elements = cardElements(card);
  const beforeIndex = elements.findIndex((item) => item.tag === 'markdown' && item.content.includes('准备重启。'));
  const panelIndex = elements.findIndex((item) => item.tag === 'collapsible_panel' && item.header.title.content.includes('命令'));
  const afterIndex = elements.findIndex((item) => item.tag === 'markdown' && item.content.includes('完成'));
  const approvalIndex = elements.findIndex((item) => item.tag === 'button' && item.behaviors?.[0]?.value?.action === 'approve');
  assert.equal(card.header.template, 'yellow');
  assert.equal(card.schema, '2.0');
  assert.equal(panelIndex > -1 && afterIndex > -1, true);
  assert.equal(elements[panelIndex].header.title.content, '已运行 1 条命令');
  assert.equal(elements[panelIndex].expanded, false);
  assert.ok(beforeIndex > -1 && beforeIndex < panelIndex);
  assert.ok(panelIndex < afterIndex && afterIndex < approvalIndex);
  assert.doesNotMatch(markdownText(card), /\*\*回复\*\*|执行过程/);
  assert.equal(elements[approvalIndex].behaviors[0].value.approval_id, 'approval-1');
  assert.doesNotThrow(() => JSON.stringify(card));
});

test('continuous commands are grouped and collapsed when completed', () => {
  let state = createStreamState('连续命令');
  for (const [id, command] of [['cmd-1', 'pwd'], ['cmd-2', 'git status'], ['cmd-3', 'ls']]) {
    state = updateStreamState(state, {
      type: 'item.completed',
      item: {
        id,
        type: 'command_execution',
        command,
        status: 'completed',
        exit_code: 0,
        aggregated_output: 'ok',
      },
    });
  }

  const card = buildAgentCard(state);
  const panels = cardElements(card).filter((item) => item.tag === 'collapsible_panel');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].header.title.content, '已运行 3 条命令');
  assert.equal(panels[0].expanded, false);
  assert.match(JSON.stringify(panels[0]), /pwd/);
  assert.match(JSON.stringify(panels[0]), /git status/);
  assert.match(JSON.stringify(panels[0]), /ls/);
});

test('assistant text between commands starts a new command group', () => {
  let state = createStreamState('分组');
  state = updateStreamState(state, {
    type: 'item.completed',
    item: { id: 'cmd-1', type: 'command_execution', command: 'pwd', status: 'completed' },
  });
  state = updateStreamState(state, {
    type: 'item.completed',
    item: { id: 'msg', type: 'agent_message', text: '中间说明' },
  });
  state = updateStreamState(state, {
    type: 'item.completed',
    item: { id: 'cmd-2', type: 'command_execution', command: 'git status', status: 'completed' },
  });

  const elements = cardElements(buildAgentCard(state));
  const panels = elements.filter((item) => item.tag === 'collapsible_panel');
  const middleIndex = elements.findIndex((item) => item.tag === 'markdown' && item.content.includes('中间说明'));
  assert.equal(panels.length, 2);
  assert.equal(panels[0].header.title.content, '已运行 1 条命令');
  assert.equal(panels[1].header.title.content, '已运行 1 条命令');
  assert.ok(elements.indexOf(panels[0]) < middleIndex);
  assert.ok(middleIndex < elements.indexOf(panels[1]));
});

test('running command group is expanded and completed group is folded', () => {
  let state = createStreamState('长输出');
  state = updateStreamState(state, {
    type: 'item.started',
    item: {
      id: 'cmd',
      type: 'command_execution',
      command: 'cat big.log',
      status: 'in_progress',
      aggregated_output: '',
    },
  });

  let panel = cardElements(buildAgentCard(state)).find((item) => item.tag === 'collapsible_panel');
  assert.equal(panel.header.title.content, '正在运行 1 条命令');
  assert.equal(panel.expanded, true);

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
  panel = cardElements(card).find((item) => item.tag === 'collapsible_panel');
  assert.equal(card.header.template, 'green');
  assert.equal(panel.header.title.content, '已运行 1 条命令');
  assert.equal(panel.expanded, false);
  assert.match(JSON.stringify(card), /truncated/);
});

test('failed commands render failed command group', () => {
  let state = createStreamState('长输出');
  state = updateStreamState(state, {
    type: 'item.completed',
    item: {
      id: 'cmd',
      type: 'command_execution',
      command: 'cat big.log',
      status: 'failed',
      exit_code: 1,
      aggregated_output: 'permission denied',
    },
  });

  const card = buildAgentCard(state);
  const panel = cardElements(card).find((item) => item.tag === 'collapsible_panel');
  assert.equal(panel.header.title.content, '命令失败 · 1 条命令');
  assert.equal(panel.expanded, false);
  assert.match(JSON.stringify(panel), /exit_code=1/);
});

test('running card supports interrupt and queue buttons', () => {
  const state = createStreamState('长任务');
  const card = buildAgentCard(state, {
    includeRuntimeButtons: true,
    sessionKey: 'chat:user',
    taskId: 'task-1',
    requesterOpenId: 'user',
    sourceMessageId: 'msg-1',
  });
  const buttons = cardElements(card).filter((item) => item.tag === 'button');

  assert.equal(card.schema, '2.0');
  assert.equal(buttons[0].text.content, '打断');
  assert.equal(buttons[0].behaviors[0].value.action, 'interrupt_current');
  assert.equal(buttons[1].behaviors[0].value.action, 'show_queue');
  assert.doesNotThrow(() => JSON.stringify(card));
});

test('interrupted card has dedicated phase and title', () => {
  const state = markStreamInterrupted(createStreamState('长任务'));
  const card = buildAgentCard(state);

  assert.equal(state.phase, 'interrupted');
  assert.equal(card.header.title.content, 'Codex 已被打断');
  assert.match(formatStreamState(state), /已被打断/);
  assert.match(markdownText(card), /用户已打断当前任务/);
});

test('queue cards render waiting task controls and summary', () => {
  const task = {
    id: 'task-queued',
    chatId: 'chat',
    senderOpenId: 'user',
    sessionKey: 'chat:user',
    sourceMessageId: 'msg-queued',
    userText: '排队任务',
    createdAt: 1,
    targetMessageId: null,
  };
  const currentTask = { ...task, id: 'task-current', userText: '当前任务' };
  const queuedCard = buildQueuedTaskCard({ task, position: 1, queueLength: 1, currentTask });
  const summaryCard = buildQueueSummaryCard({ sessionKey: 'chat:user', currentTask, queue: [task] });
  const buttons = cardElements(queuedCard).filter((item) => item.tag === 'button');

  assert.equal(queuedCard.header.title.content, 'Codex 已加入队列');
  assert.equal(queuedCard.schema, '2.0');
  assert.equal(buttons[0].behaviors[0].value.action, 'interrupt_with_task');
  assert.equal(buttons[1].behaviors[0].value.action, 'cancel_queued_task');
  assert.match(JSON.stringify(summaryCard), /task-queued/);
  assert.doesNotThrow(() => JSON.stringify(queuedCard));
  assert.doesNotThrow(() => JSON.stringify(summaryCard));
});

test('card response renders inline code as Feishu neutral text tags and keeps fenced code language', () => {
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
  const responseContent = markdownText(card);
  assert.doesNotMatch(responseContent, /\*\*回复\*\*/);
  assert.match(responseContent, /Jenkins <text_tag color='neutral'>eks-autotest<\/text_tag> 当前命令/);
  assert.match(responseContent, /```text\ncodex exec --experimental-json/);
  assert.match(responseContent, /<text_tag color='neutral'>inline<\/text_tag>/);
  assert.doesNotMatch(responseContent, /color='grey'|`eks-autotest`|`inline`/);
});

test('card response converts markdown tables to Feishu table components', () => {
  let state = createStreamState('对比');
  state = updateStreamState(state, {
    type: 'item.completed',
    item: {
      id: 'msg',
      type: 'agent_message',
      text: [
        '总体差异',
        '',
        '| 项 | 结果 |',
        '|---|---|',
        '| 当前分支 | `feature/clb-api` |',
        '| 文件统计 | 31 files changed |',
        '',
        '后续说明',
      ].join('\n'),
    },
  });

  const card = buildAgentCard(state);
  const elements = cardElements(card);
  const table = elements.find((item) => item.tag === 'table');
  const markdownText = elements.filter((item) => item.tag === 'markdown').map((item) => item.content).join('\n');

  assert.equal(card.schema, '2.0');
  assert.equal(table.columns[0].display_name, '项');
  assert.equal(table.columns[1].display_name, '结果');
  assert.equal(table.rows[0].col_1, "<text_tag color='neutral'>feature/clb-api</text_tag>");
  assert.doesNotMatch(markdownText, /\|---\|---\||\| 当前分支 \|/);
});

test('redacts sensitive content', () => {
  const text = redact('Authorization: Bearer abc token=secret password=hunter2 FEISHU_APP_SECRET=abc');
  assert.doesNotMatch(text, /hunter2|Bearer abc|token=secret|FEISHU_APP_SECRET=abc/);
});
