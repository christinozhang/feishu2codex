import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { QueuedTask } from './queue.js';
import type { CodexThreadSummary } from './runtime.js';

export type StreamPhase = 'approval' | 'running' | 'completed' | 'failed' | 'interrupted';
export type TimelineStatus = 'running' | 'completed' | 'failed';
export type TimelineKind = 'approval' | 'command' | 'mcp' | 'file_change' | 'web_search' | 'todo' | 'error' | 'reasoning';

export type TimelineItem = {
    id: string;
    timestamp: string;
    kind: TimelineKind;
    title: string;
    detail: string;
    status: TimelineStatus;
};

export type DisplayBlockStatus = 'running' | 'completed' | 'failed';

type BlockBase = {
    id: string;
    status: DisplayBlockStatus;
    createdAt: number;
    updatedAt: number;
    collapsed: boolean;
};

export type AssistantBlock = BlockBase & {
    type: 'assistant';
    content: string;
};

export type CommandBlockItem = {
    id: string;
    command: string;
    detail: string;
    status: TimelineStatus;
    exitCode?: string | number;
};

export type CommandGroupBlock = BlockBase & {
    type: 'command_group';
    commands: CommandBlockItem[];
};

export type ToolGroupBlock = BlockBase & {
    type: 'tool_group';
    title: string;
    items: TimelineItem[];
};

export type ErrorBlock = BlockBase & {
    type: 'error';
    title: string;
    detail: string;
};

export type DisplayBlock = AssistantBlock | CommandGroupBlock | ToolGroupBlock | ErrorBlock;

export type StreamState = {
    phase: StreamPhase;
    task: string;
    responseText: string;
    timeline: TimelineItem[];
    blocks: DisplayBlock[];
    approvalId?: string;
};

export type RuntimeCardOptions = {
    includeApprovalButtons?: boolean;
    includeRuntimeButtons?: boolean;
    sessionKey?: string;
    taskId?: string;
    requesterOpenId?: string;
    sourceMessageId?: string;
};

const MAX_TASK_CHARS = 300;
const MAX_TIMELINE_ITEMS = 8;
const MAX_VISIBLE_BLOCKS = 12;
const MAX_OUTPUT_SUMMARY_CHARS = 500;
const MAX_TEXT_CHARS = 3800;
const MAX_MARKDOWN_ELEMENT_CHARS = 3200;
const MAX_TABLES_PER_CARD = 5;
const MAX_TABLE_COLUMNS = 6;
const MAX_TABLE_ROWS = 10;
const MAX_TABLE_CELL_CHARS = 180;

const SECRET_PATTERNS = [
    /(Authorization\s*[:=]\s*)(Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi,
    /(["']?(?:FEISHU_APP_SECRET|secret|token|password|passwd|cookie)["']?\s*:\s*["'])[^"']+/gi,
    /\b(FEISHU_APP_SECRET|secret|token|password|passwd|cookie)\b\s*[:=]\s*['"]?[^'"\s,&}]+/gi,
    /\b(password|token|secret)=([^&\s]+)/gi,
];

export function createStreamState(task = '', phase: StreamPhase = 'running'): StreamState {
    return {
        phase,
        task: safeText(task, MAX_TASK_CHARS),
        responseText: '',
        timeline: [],
        blocks: [],
    };
}

export function createApprovalState(task: string, approvalId: string, detail: string): StreamState {
    const state = addTimelineItem({
        ...createStreamState(task, 'approval'),
        approvalId,
    }, {
        id: approvalId,
        kind: 'approval',
        title: '等待飞书审批',
        detail,
        status: 'running',
    });
    return addToolBlock(state, state.timeline[state.timeline.length - 1]);
}

export function updateStreamState(state: StreamState, event: ThreadEvent | any): StreamState {
    if (event.type === 'turn.completed') {
        return completeRunningWork({ ...state, phase: 'completed' });
    }

    if (event.type === 'turn.failed') {
        return upsertErrorBlock(addTimelineItem({ ...state, phase: 'failed' }, {
            id: 'turn.failed',
            kind: 'error',
            title: '处理失败',
            detail: event.error?.message || 'Codex turn failed',
            status: 'failed',
        }), 'turn.failed', '处理失败', event.error?.message || 'Codex turn failed');
    }

    if (event.type === 'error') {
        return upsertErrorBlock(addTimelineItem({ ...state, phase: 'failed' }, {
            id: 'error',
            kind: 'error',
            title: '处理失败',
            detail: event.message || String(event),
            status: 'failed',
        }), 'error', '处理失败', event.message || String(event));
    }

    if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') {
        return state;
    }

    return applyItem(state, event.item);
}

export function markStreamInterrupted(state: StreamState, detail = '用户已打断当前任务。'): StreamState {
    const next = addTimelineItem({ ...state, phase: 'interrupted' }, {
        id: 'turn.interrupted',
        kind: 'error',
        title: '已被打断',
        detail,
        status: 'failed',
    });
    return upsertErrorBlock(next, 'turn.interrupted', '已被打断', detail);
}

export function shouldUpdateCard(previous: StreamState, next: StreamState, lastResponseLength: number): boolean {
    if (previous.phase !== next.phase) return true;
    if (next.responseText.length - lastResponseLength >= 80) return true;

    const previousTools = previous.timeline.map((item) => `${item.id}:${item.status}:${item.detail}`).join('|');
    const nextTools = next.timeline.map((item) => `${item.id}:${item.status}:${item.detail}`).join('|');
    if (previousTools !== nextTools) return true;

    return summarizeBlocksForDiff(previous.blocks) !== summarizeBlocksForDiff(next.blocks);
}

export function hasCommandGroupCompletionChange(previous: StreamState, next: StreamState): boolean {
    const previousStatuses = new Map(
        previous.blocks
            .filter((block): block is CommandGroupBlock => block.type === 'command_group')
            .map((block) => [block.id, block.status]),
    );
    return next.blocks
        .filter((block): block is CommandGroupBlock => block.type === 'command_group')
        .some((block) => previousStatuses.get(block.id) === 'running' && block.status !== 'running');
}

export function buildAgentCard(state: StreamState, options: RuntimeCardOptions = {}) {
    const header = headerForPhase(state.phase);
    const elements: any[] = [
        {
            tag: 'markdown',
            content: `**任务**\n${formatCardMarkdown(state.task || '未命名任务', MAX_TASK_CHARS)}`,
        },
    ];

    elements.push(...buildBlockElements(state.blocks, state.phase));

    if (state.phase === 'approval' && state.approvalId && options.includeApprovalButtons !== false) {
        elements.push(
            buildCallbackButton('Approve', 'primary', { action: 'approve', approval_id: state.approvalId }),
            buildCallbackButton('Deny', 'danger', { action: 'deny', approval_id: state.approvalId }),
        );
    }

    if (state.phase === 'running' && options.includeRuntimeButtons && options.sessionKey && options.taskId) {
        elements.push(
            buildCallbackButton('打断', 'danger', {
                action: 'interrupt_current',
                session_key: options.sessionKey,
                task_id: options.taskId,
                requester_open_id: options.requesterOpenId,
                source_message_id: options.sourceMessageId,
            }),
            buildCallbackButton('查看队列', 'default', {
                action: 'show_queue',
                session_key: options.sessionKey,
                requester_open_id: options.requesterOpenId,
                source_message_id: options.sourceMessageId,
            }),
        );
    }

    return buildCard(header, elements);
}

export function buildQueuedTaskCard(params: {
    task: QueuedTask;
    position: number;
    queueLength: number;
    currentTask: QueuedTask | null;
}) {
    const task = params.task;
    return buildCard(
        { template: 'blue', title: { tag: 'plain_text', content: 'Codex 已加入队列' } },
        [
            {
                tag: 'markdown',
                content: [
                    `**任务**\n${formatCardMarkdown(task.userText, MAX_TASK_CHARS)}`,
                    `**任务 ID**\n${escapeMd(task.id)}`,
                    `**队列位置**\n第 ${params.position} 位 / 共 ${params.queueLength} 位`,
                    `**当前运行**\n${formatCardMarkdown(params.currentTask?.userText || '无', 120)}`,
                ].join('\n\n'),
            },
            buildCallbackButton('打断并执行', 'danger', {
                action: 'interrupt_with_task',
                session_key: task.sessionKey,
                task_id: task.id,
                requester_open_id: task.senderOpenId,
                source_message_id: task.sourceMessageId,
            }),
            buildCallbackButton('取消排队', 'default', {
                action: 'cancel_queued_task',
                session_key: task.sessionKey,
                task_id: task.id,
                requester_open_id: task.senderOpenId,
                source_message_id: task.sourceMessageId,
            }),
        ],
    );
}

export function buildQueueSummaryCard(params: {
    sessionKey: string;
    currentTask: QueuedTask | null;
    queue: QueuedTask[];
}) {
    const waiting = params.queue.slice(0, 10);
    const waitingText = waiting.length > 0
        ? waiting.map((task, index) => `${index + 1}. ${escapeMd(task.id)} · ${formatCardMarkdown(task.userText, 100)}`).join('\n')
        : '无等待任务';

    return buildCard(
        { template: 'blue', title: { tag: 'plain_text', content: 'Codex 队列' } },
        [
            {
                tag: 'markdown',
                content: [
                    `**当前运行**\n${formatCardMarkdown(params.currentTask?.userText || '无', 140)}`,
                    `**等待队列**\n${waitingText}`,
                    params.queue.length > waiting.length ? `还有 ${params.queue.length - waiting.length} 条未展示。` : '',
                ].filter(Boolean).join('\n\n'),
            },
        ],
    );
}

export function buildThreadPickerCard(params: {
    sessionKey: string;
    requesterOpenId: string;
    sourceMessageId: string;
    searchTerm?: string;
    threads: CodexThreadSummary[];
}) {
    const elements: any[] = [];
    const search = params.searchTerm?.trim();
    elements.push({
        tag: 'markdown',
        content: [
            search ? `**检索词**\n${formatCardMarkdown(search, 120)}` : '',
            params.threads.length === 0 ? '未找到可绑定的 Codex Desktop 对话。' : `共 ${params.threads.length} 条候选。`,
        ].filter(Boolean).join('\n\n'),
    });

    for (const thread of params.threads.slice(0, 10)) {
        const title = thread.title || thread.preview || thread.id;
        elements.push({
            tag: 'markdown',
            content: [
                `**${formatCardMarkdown(title, 100)}**`,
                thread.preview ? formatCardMarkdown(thread.preview, 180) : '',
                `ID: ${escapeMd(thread.id)}`,
                `目录: ${formatCardMarkdown(thread.cwd || '未知', 180)}`,
                `来源: ${escapeMd(thread.source || 'unknown')} · 状态: ${escapeMd(thread.status || 'unknown')} · 更新: ${formatThreadUpdatedAt(thread.updatedAt)}`,
            ].filter(Boolean).join('\n'),
        });
        if (thread.status === 'active') {
            elements.push({
                tag: 'markdown',
                content: '运行中的对话暂不绑定。',
            });
        } else {
            elements.push(buildCallbackButton('继续此对话', 'primary', {
                action: 'bind_thread',
                session_key: params.sessionKey,
                requester_open_id: params.requesterOpenId,
                source_message_id: params.sourceMessageId,
                thread_id: thread.id,
                thread_title: title,
            }));
        }
    }

    return buildCard(
        { template: 'blue', title: { tag: 'plain_text', content: 'Codex Desktop 对话' } },
        elements,
    );
}

export function formatThreadPickerText(threads: CodexThreadSummary[], searchTerm = '') {
    if (threads.length === 0) {
        return searchTerm ? `未找到匹配 Codex Desktop 对话: ${searchTerm}` : '未找到 Codex Desktop 对话';
    }
    return threads.map((thread, index) => [
        `${index + 1}. ${thread.title || thread.preview || thread.id}`,
        `ID: ${thread.id}`,
        `目录: ${thread.cwd || '未知'}`,
        `来源: ${thread.source || 'unknown'} · 状态: ${thread.status || 'unknown'} · 更新: ${formatThreadUpdatedAt(thread.updatedAt)}`,
    ].join('\n')).join('\n\n');
}

function formatThreadUpdatedAt(value: number) {
    if (!value) return '未知';
    return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });
}

function buildCard(header: any, elements: any[]) {
    return {
        schema: '2.0',
        config: { wide_screen_mode: true, update_multi: true },
        header,
        body: {
            direction: 'vertical',
            padding: '12px',
            vertical_spacing: '8px',
            elements,
        },
    };
}

function buildCallbackButton(content: string, type: 'default' | 'primary' | 'danger', value: Record<string, unknown>) {
    return {
        tag: 'button',
        text: { tag: 'plain_text', content },
        type,
        size: 'medium',
        width: 'fill',
        behaviors: [
            {
                type: 'callback',
                value,
            },
        ],
    };
}

function buildBlockElements(blocks: DisplayBlock[], phase: StreamPhase) {
    if (blocks.length === 0) return [];
    const visibleBlocks = blocks.slice(-MAX_VISIBLE_BLOCKS);
    const hiddenCount = blocks.length - visibleBlocks.length;
    const elements: any[] = [];
    if (hiddenCount > 0) {
        elements.push({
            tag: 'markdown',
            content: `较早内容已压缩 · ${hiddenCount} 条`,
        });
    }
    const processBlocks = visibleBlocks.filter(isProcessBlock);
    let processPanelAdded = false;
    for (const block of visibleBlocks) {
        if (isProcessBlock(block)) {
            if (!processPanelAdded) {
                elements.push(buildProcessPanel(processBlocks, phase));
                processPanelAdded = true;
            }
            continue;
        }
        elements.push(...renderBlock(block));
    }
    return elements;
}

function isProcessBlock(block: DisplayBlock) {
    return block.type !== 'assistant' && !isApprovalBlock(block);
}

function isApprovalBlock(block: DisplayBlock) {
    return block.type === 'tool_group' && block.items.every((item) => item.kind === 'approval');
}

function buildProcessPanel(blocks: DisplayBlock[], phase: StreamPhase) {
    return {
        tag: 'collapsible_panel',
        expanded: shouldExpandProcessPanel(blocks, phase),
        header: {
            title: {
                tag: 'plain_text',
                content: processPanelTitle(blocks, phase),
            },
        },
        elements: blocks.flatMap(renderBlock),
    };
}

function shouldExpandProcessPanel(blocks: DisplayBlock[], phase: StreamPhase) {
    if (phase === 'completed') return false;
    if (phase === 'running' || phase === 'approval') return true;
    return blocks.some((block) => block.status === 'failed');
}

function processPanelTitle(blocks: DisplayBlock[], phase: StreamPhase) {
    const elapsed = formatElapsedSeconds(blocks);
    if (phase === 'completed') return `思考处理过程 · 已处理 · ${elapsed}`;
    if (phase === 'failed') return `思考处理过程 · 处理失败 · ${elapsed}`;
    if (phase === 'interrupted') return `思考处理过程 · 已被打断 · ${elapsed}`;
    return `思考处理过程 · 处理中 · ${elapsed}`;
}

function formatElapsedSeconds(blocks: DisplayBlock[]) {
    const first = Math.min(...blocks.map((block) => block.createdAt));
    const last = Math.max(...blocks.map((block) => block.updatedAt));
    const seconds = Math.max(0, (last - first) / 1000);
    if (seconds < 10) return `${Number(seconds.toFixed(1))}s`;
    return `${Math.round(seconds)}s`;
}

function renderBlock(block: DisplayBlock): any[] {
    if (block.type === 'assistant') {
        return buildMarkdownSection(null, block.content, 8000);
    }
    if (block.type === 'command_group') {
        return [buildCommandGroupPanel(block)];
    }
    if (block.type === 'tool_group') {
        return [buildToolGroupPanel(block)];
    }
    return buildMarkdownSection(null, `**${block.title}**\n${block.detail}`, 1600);
}

function buildCommandGroupPanel(block: CommandGroupBlock) {
    return {
        tag: 'collapsible_panel',
        expanded: !block.collapsed,
        header: {
            title: {
                tag: 'plain_text',
                content: commandGroupTitle(block),
            },
        },
        elements: buildCommandGroupElements(block),
    };
}

function buildCommandGroupElements(block: CommandGroupBlock) {
    const commands = block.commands.slice(-MAX_TIMELINE_ITEMS);
    if (block.collapsed) {
        return commands.map((item) => ({
            tag: 'markdown',
            content: formatCollapsedCommand(item),
        }));
    }
    return commands.map((item) => ({
        tag: 'markdown',
        content: formatExpandedCommand(item),
    }));
}

function buildToolGroupPanel(block: ToolGroupBlock) {
    return {
        tag: 'collapsible_panel',
        expanded: !block.collapsed,
        header: {
            title: {
                tag: 'plain_text',
                content: block.title,
            },
        },
        elements: block.items.slice(-MAX_TIMELINE_ITEMS).map((item) => ({
            tag: 'markdown',
            content: formatTimelineItem(item),
        })),
    };
}

function commandGroupTitle(block: CommandGroupBlock) {
    const count = block.commands.length;
    if (block.status === 'failed') return `命令失败 · ${count} 条命令`;
    if (block.status === 'completed') return `已运行 ${count} 条命令`;
    return `正在运行 ${count} 条命令`;
}

function formatCollapsedCommand(item: CommandBlockItem) {
    const exitCode = item.exitCode !== undefined ? ` · exit_code=${item.exitCode}` : '';
    const summary = item.detail ? `\n${formatCardMarkdown(item.detail, MAX_OUTPUT_SUMMARY_CHARS + 120)}` : '';
    return `已运行 ${formatCardMarkdown(item.command || 'unknown command', 300)}${exitCode}${summary}`;
}

function formatExpandedCommand(item: CommandBlockItem) {
    const statusText = item.status === 'running' ? '运行中' : item.status === 'failed' ? '失败' : '已完成';
    return [
        `**${statusText}** ${formatCardMarkdown(item.command || 'unknown command', 300)}`,
        item.detail ? formatCardMarkdown(item.detail, MAX_OUTPUT_SUMMARY_CHARS + 120) : '',
    ].filter(Boolean).join('\n');
}

function toolGroupTitle(items: TimelineItem[]) {
    if (items.length === 0) return '工具事件';
    const status = toolGroupStatus(items);
    const prefix = status === 'running' ? '正在执行' : status === 'failed' ? '工具失败' : '已执行';
    if (items.length === 1) return `${prefix} ${items[0].title}`;
    return `${prefix} ${items.length} 个工具事件`;
}

function summarizeBlocksForDiff(blocks: DisplayBlock[]) {
    return blocks.map((block) => {
        if (block.type === 'assistant') {
            return `${block.id}:assistant:${block.status}:${block.content.length}:${block.content.slice(-80)}`;
        }
        if (block.type === 'command_group') {
            const commands = block.commands.map((item) => `${item.id}:${item.status}:${item.exitCode ?? ''}:${item.detail}`).join(',');
            return `${block.id}:command_group:${block.status}:${block.collapsed}:${commands}`;
        }
        if (block.type === 'tool_group') {
            const items = block.items.map((item) => `${item.id}:${item.status}:${item.detail}`).join(',');
            return `${block.id}:tool_group:${block.status}:${block.collapsed}:${items}`;
        }
        return `${block.id}:error:${block.detail}`;
    }).join('|');
}

export function formatStreamState(state: StreamState): string {
    const title = headerForPhase(state.phase).title.content;
    const parts = [title, `任务:\n${safeText(state.task || '未命名任务', MAX_TEXT_CHARS)}`];

    if (state.responseText.trim()) {
        parts.push(`回复:\n${safeText(state.responseText, MAX_TEXT_CHARS)}`);
    }

    const timeline = state.timeline.slice(-MAX_TIMELINE_ITEMS);
    if (timeline.length > 0) {
        parts.push(`执行过程:\n${timeline.map(formatTimelineText).join('\n')}`);
    }

    return redact(parts.join('\n\n'));
}

export function redact(value: unknown): string {
    let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    for (const pattern of SECRET_PATTERNS) {
        text = text.replace(pattern, (match, prefix) => `${prefix || match.split(/[=:]/)[0]}=[REDACTED]`);
    }
    return text;
}

function applyItem(state: StreamState, item: ThreadItem | any): StreamState {
    switch (item.type) {
        case 'agent_message':
            return upsertAssistantBlock({ ...state, responseText: redact(item.text || '') }, item);
        case 'reasoning':
            return addTimelineAndToolBlock(state, {
                id: item.id,
                kind: 'reasoning',
                title: '分析中',
                detail: 'Codex 正在整理可见步骤。',
                status: statusFromItem(item.status),
            });
        case 'command_execution':
            return upsertCommandBlock(addTimelineItem(state, {
                id: item.id,
                kind: 'command',
                title: commandTitle(item.status),
                detail: formatCommandDetail(item),
                status: statusFromItem(item.status),
            }), item);
        case 'mcp_tool_call':
            return addTimelineAndToolBlock(state, {
                id: item.id,
                kind: 'mcp',
                title: `MCP ${item.server || 'unknown'}.${item.tool || 'unknown'}`,
                detail: `${item.status || 'running'} ${safeText(redact(item.arguments ?? ''), 240)}`.trim(),
                status: statusFromItem(item.status),
            });
        case 'file_change':
            return addTimelineAndToolBlock(state, {
                id: item.id,
                kind: 'file_change',
                title: `文件变更 ${item.status || ''}`.trim(),
                detail: safeText((item.changes || []).map((change: any) => `${change.kind} ${change.path}`).join('\n'), 500),
                status: statusFromItem(item.status),
            });
        case 'web_search':
            return addTimelineAndToolBlock(state, {
                id: item.id,
                kind: 'web_search',
                title: 'Web 搜索',
                detail: safeText(item.query || '', 240),
                status: statusFromItem(item.status || 'completed'),
            });
        case 'todo_list':
            return addTimelineAndToolBlock(state, {
                id: item.id,
                kind: 'todo',
                title: '任务列表',
                detail: formatTodoStatus(item.items || []),
                status: statusFromItem(item.status || 'completed'),
            });
        case 'error':
            return upsertErrorBlock(addTimelineItem({ ...state, phase: 'failed' }, {
                id: item.id,
                kind: 'error',
                title: '处理失败',
                detail: item.message || 'unknown error',
                status: 'failed',
            }), item.id || 'error', '处理失败', item.message || 'unknown error');
        default:
            return state;
    }
}

function addTimelineItem(state: StreamState, item: Omit<TimelineItem, 'timestamp'> & { timestamp?: string }): StreamState {
    const nextItem: TimelineItem = {
        ...item,
        detail: safeText(redact(item.detail), 1000),
        timestamp: item.timestamp || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    const existingIndex = state.timeline.findIndex((entry) => entry.id === nextItem.id);
    if (existingIndex === -1) {
        return { ...state, timeline: [...state.timeline, nextItem] };
    }
    return {
        ...state,
        timeline: state.timeline.map((entry) => entry.id === nextItem.id ? { ...entry, ...nextItem } : entry),
    };
}

function addTimelineAndToolBlock(state: StreamState, item: Omit<TimelineItem, 'timestamp'> & { timestamp?: string }) {
    const next = addTimelineItem(state, item);
    const timelineItem = next.timeline.find((entry) => entry.id === item.id);
    return timelineItem ? addToolBlock(next, timelineItem) : next;
}

function upsertAssistantBlock(state: StreamState, item: any): StreamState {
    const id = item.id || `assistant-${state.blocks.length + 1}`;
    const content = redact(item.text || '');
    const now = Date.now();
    const index = state.blocks.findIndex((block) => block.type === 'assistant' && block.id === id);
    const nextBlock: AssistantBlock = {
        type: 'assistant',
        id,
        content,
        status: 'completed',
        collapsed: false,
        createdAt: index >= 0 ? state.blocks[index].createdAt : now,
        updatedAt: now,
    };
    if (index >= 0) {
        return {
            ...state,
            blocks: state.blocks.map((block, blockIndex) => blockIndex === index ? nextBlock : block),
        };
    }
    return { ...state, blocks: [...state.blocks, nextBlock] };
}

function upsertCommandBlock(state: StreamState, item: any): StreamState {
    const commandItem = commandBlockItemFromThreadItem(item);
    const existingGroupIndex = state.blocks.findIndex((block) => {
        return block.type === 'command_group' && block.commands.some((command) => command.id === commandItem.id);
    });
    if (existingGroupIndex >= 0) {
        const block = state.blocks[existingGroupIndex] as CommandGroupBlock;
        const commands = block.commands.map((command) => command.id === commandItem.id ? commandItem : command);
        const nextBlock = normalizeCommandGroup({ ...block, commands, updatedAt: Date.now() });
        return {
            ...state,
            blocks: state.blocks.map((entry, index) => index === existingGroupIndex ? nextBlock : entry),
        };
    }

    const lastBlock = state.blocks[state.blocks.length - 1];
    if (lastBlock?.type === 'command_group') {
        const nextBlock = normalizeCommandGroup({
            ...lastBlock,
            commands: [...lastBlock.commands, commandItem],
            updatedAt: Date.now(),
        });
        return {
            ...state,
            blocks: state.blocks.map((entry, index) => index === state.blocks.length - 1 ? nextBlock : entry),
        };
    }

    const now = Date.now();
    const nextBlock = normalizeCommandGroup({
        type: 'command_group',
        id: `command-group-${commandItem.id}`,
        commands: [commandItem],
        status: commandItem.status === 'failed' ? 'failed' : commandItem.status === 'completed' ? 'completed' : 'running',
        collapsed: commandItem.status !== 'running',
        createdAt: now,
        updatedAt: now,
    });
    return { ...state, blocks: [...state.blocks, nextBlock] };
}

function commandBlockItemFromThreadItem(item: any): CommandBlockItem {
    return {
        id: item.id,
        command: safeText(item.command || '', 300),
        detail: formatCommandDetail(item),
        status: statusFromItem(item.status),
        exitCode: item.exit_code ?? item.exitCode,
    };
}

function normalizeCommandGroup(block: CommandGroupBlock): CommandGroupBlock {
    const status = commandGroupStatus(block.commands);
    return {
        ...block,
        status,
        collapsed: status !== 'running',
    };
}

function commandGroupStatus(commands: CommandBlockItem[]): DisplayBlockStatus {
    if (commands.some((item) => item.status === 'failed')) return 'failed';
    if (commands.every((item) => item.status === 'completed')) return 'completed';
    return 'running';
}

function addToolBlock(state: StreamState, item: TimelineItem): StreamState {
    const now = Date.now();
    const existingIndex = state.blocks.findIndex((block) => {
        return block.type === 'tool_group' && block.items.some((entry) => entry.id === item.id);
    });
    if (existingIndex >= 0) {
        const block = state.blocks[existingIndex] as ToolGroupBlock;
        const items = block.items.map((entry) => entry.id === item.id ? item : entry);
        const nextBlock = normalizeToolGroup({ ...block, items, updatedAt: now });
        return {
            ...state,
            blocks: state.blocks.map((entry, index) => index === existingIndex ? nextBlock : entry),
        };
    }

    const lastBlock = state.blocks[state.blocks.length - 1];
    if (lastBlock?.type === 'tool_group') {
        const nextBlock = normalizeToolGroup({
            ...lastBlock,
            items: [...lastBlock.items, item],
            title: toolGroupTitle([...lastBlock.items, item]),
            updatedAt: now,
        });
        return {
            ...state,
            blocks: state.blocks.map((entry, index) => index === state.blocks.length - 1 ? nextBlock : entry),
        };
    }

    const nextBlock = normalizeToolGroup({
        type: 'tool_group',
        id: `tool-group-${item.id}`,
        title: toolGroupTitle([item]),
        items: [item],
        status: item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'completed' : 'running',
        collapsed: item.status !== 'running',
        createdAt: now,
        updatedAt: now,
    });
    return { ...state, blocks: [...state.blocks, nextBlock] };
}

function normalizeToolGroup(block: ToolGroupBlock): ToolGroupBlock {
    const status = toolGroupStatus(block.items);
    return {
        ...block,
        title: toolGroupTitle(block.items),
        status,
        collapsed: status !== 'running',
    };
}

function toolGroupStatus(items: TimelineItem[]): DisplayBlockStatus {
    if (items.some((item) => item.status === 'failed')) return 'failed';
    if (items.every((item) => item.status === 'completed')) return 'completed';
    return 'running';
}

function completeRunningWork(state: StreamState): StreamState {
    return {
        ...state,
        timeline: state.timeline.map((item) => item.status === 'running' ? { ...item, status: 'completed' } : item),
        blocks: state.blocks.map((block) => {
            if (block.type === 'command_group') {
                return normalizeCommandGroup({
                    ...block,
                    commands: block.commands.map((item) => item.status === 'running' ? { ...item, status: 'completed' } : item),
                    updatedAt: Date.now(),
                });
            }
            if (block.type === 'tool_group') {
                return normalizeToolGroup({
                    ...block,
                    items: block.items.map((item) => item.status === 'running' ? { ...item, status: 'completed' } : item),
                    updatedAt: Date.now(),
                });
            }
            return block;
        }),
    };
}

function upsertErrorBlock(state: StreamState, id: string, title: string, detail: string): StreamState {
    const now = Date.now();
    const nextBlock: ErrorBlock = {
        type: 'error',
        id,
        title,
        detail: safeText(redact(detail), 1000),
        status: 'failed',
        collapsed: false,
        createdAt: now,
        updatedAt: now,
    };
    const existingIndex = state.blocks.findIndex((block) => block.type === 'error' && block.id === id);
    if (existingIndex >= 0) {
        return {
            ...state,
            blocks: state.blocks.map((block, index) => index === existingIndex ? { ...nextBlock, createdAt: block.createdAt } : block),
        };
    }
    return { ...state, blocks: [...state.blocks, nextBlock] };
}

function headerForPhase(phase: StreamPhase) {
    if (phase === 'completed') {
        return { template: 'green', title: { tag: 'plain_text', content: 'Codex 已完成' } };
    }
    if (phase === 'failed') {
        return { template: 'red', title: { tag: 'plain_text', content: 'Codex 处理失败' } };
    }
    if (phase === 'approval') {
        return { template: 'yellow', title: { tag: 'plain_text', content: 'Codex 等待审批' } };
    }
    if (phase === 'interrupted') {
        return { template: 'grey', title: { tag: 'plain_text', content: 'Codex 已被打断' } };
    }
    return { template: 'blue', title: { tag: 'plain_text', content: 'Codex 正在处理' } };
}

function statusFromItem(status?: string): TimelineStatus {
    if (status === 'completed') return 'completed';
    if (status === 'failed' || status === 'cancelled') return 'failed';
    return 'running';
}

function commandTitle(status?: string) {
    if (status === 'completed') return '命令完成';
    if (status === 'failed') return '命令失败';
    return '命令执行中';
}

function formatCommandDetail(item: any) {
    const lines = [item.command || ''];
    if (item.exit_code !== undefined || item.exitCode !== undefined) {
        lines.push(`exit_code=${item.exit_code ?? item.exitCode}`);
    }
    const output = item.aggregated_output || item.output || '';
    if (output) {
        lines.push(safeText(output, MAX_OUTPUT_SUMMARY_CHARS));
    }
    return lines.join('\n');
}

function formatTodoStatus(items: Array<{ text: string; completed: boolean }>) {
    const completed = items.filter((item) => item.completed).length;
    const preview = items.slice(0, 5).map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text}`).join('\n');
    return safeText(`${completed}/${items.length}\n${preview}`.trim(), 500);
}

function formatTimelineItem(item: TimelineItem) {
    const icon = item.status === 'completed' ? '✅' : item.status === 'failed' ? '❌' : '⏳';
    const detail = item.detail ? `\n${escapeMd(item.detail)}` : '';
    return `${icon} \`${escapeMd(item.timestamp)}\` **${escapeMd(item.title)}**${detail}`;
}

function formatTimelineText(item: TimelineItem) {
    return `- ${item.timestamp} ${item.title}${item.detail ? `\n${item.detail}` : ''}`;
}

function safeText(text: unknown, limit: number) {
    const normalized = redact(text).replace(/\r\n/g, '\n').trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 15))}\n...[truncated]`;
}

function formatCardMarkdown(text: unknown, limit: number) {
    return normalizeMarkdownForLark(safeText(text, limit));
}

function buildMarkdownSection(title: string | null, text: unknown, limit: number) {
    const parsed = parseMarkdownSegments(safeText(text, limit));
    const elements: any[] = [];
    if (title) {
        elements.push({
            tag: 'markdown',
            content: `**${title}**`,
        });
    }
    let renderedTables = 0;
    for (const segment of parsed) {
        if (segment.type === 'table' && renderedTables < MAX_TABLES_PER_CARD) {
            elements.push(buildTableElement(segment.headers, segment.rows));
            renderedTables++;
            continue;
        }
        const content = segment.type === 'table'
            ? normalizeMarkdownForCardView(formatTableAsList(segment.headers, segment.rows))
            : normalizeMarkdownForCardView(segment.content);
        for (const chunk of splitMarkdownContent(content)) {
            elements.push({ tag: 'markdown', content: chunk });
        }
    }
    return elements;
}

type MarkdownSegment =
    | { type: 'markdown'; content: string }
    | { type: 'table'; headers: string[]; rows: string[][] };

function parseMarkdownSegments(text: string): MarkdownSegment[] {
    const lines = text.split('\n');
    const segments: MarkdownSegment[] = [];
    let buffer: string[] = [];
    let index = 0;

    const flushBuffer = () => {
        const content = buffer.join('\n').trim();
        if (content) segments.push({ type: 'markdown', content });
        buffer = [];
    };

    while (index < lines.length) {
        const line = lines[index] || '';
        if (isFenceStart(line)) {
            const fence: string[] = [line];
            index++;
            while (index < lines.length) {
                fence.push(lines[index] || '');
                if (isFenceStart(lines[index] || '')) {
                    index++;
                    break;
                }
                index++;
            }
            buffer.push(fence.join('\n'));
            continue;
        }

        if (index + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[index + 1] || '')) {
            flushBuffer();
            const headers = splitTableRow(line);
            index += 2;
            const rows: string[][] = [];
            while (index < lines.length && isTableRow(lines[index] || '')) {
                rows.push(splitTableRow(lines[index] || ''));
                index++;
            }
            if (headers.length >= 2 && rows.length > 0) {
                segments.push({ type: 'table', headers, rows });
            } else {
                buffer.push([line, lines[index - 1] || ''].join('\n'));
            }
            continue;
        }

        buffer.push(line);
        index++;
    }
    flushBuffer();
    return segments;
}

function buildTableElement(headers: string[], rows: string[][]) {
    const visibleHeaders = headers.slice(0, MAX_TABLE_COLUMNS).map((header, index) => sanitizeTableCell(header) || `列 ${index + 1}`);
    return {
        tag: 'table',
        page_size: Math.min(Math.max(rows.length, 1), 5),
        row_height: 'auto',
        row_max_height: '120px',
        freeze_first_column: visibleHeaders.length > 2,
        header_style: {
            text_align: 'left',
            text_size: 'normal',
            background_style: 'none',
            text_color: 'default',
            bold: true,
            lines: 2,
        },
        columns: visibleHeaders.map((header, index) => ({
            name: `col_${index}`,
            display_name: header,
            data_type: 'lark_md',
            width: 'auto',
            vertical_align: 'top',
            horizontal_align: 'left',
        })),
        rows: rows.slice(0, MAX_TABLE_ROWS).map((row) => {
            const entry: Record<string, string> = {};
            for (let index = 0; index < visibleHeaders.length; index++) {
                entry[`col_${index}`] = sanitizeTableCell(row[index] || '');
            }
            return entry;
        }),
    };
}

function formatTableAsList(headers: string[], rows: string[][]) {
    return rows.map((row) => {
        const fields = headers.map((header, index) => {
            const value = row[index] || '';
            return `${stripMarkdownMarkers(header)}: ${stripMarkdownMarkers(value)}`;
        });
        return `- ${fields.join('；')}`;
    }).join('\n');
}

function sanitizeTableCell(value: string) {
    return safeText(normalizeMarkdownForCardView(stripMarkdownMarkers(value)).replace(/\n+/g, ' '), MAX_TABLE_CELL_CHARS);
}

function stripMarkdownMarkers(value: string) {
    return value
        .trim()
        .replace(/^:+|:+$/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1');
}

function isFenceStart(line: string) {
    return /^\s*```/.test(line);
}

function isTableRow(line: string) {
    const trimmed = line.trim();
    return trimmed.includes('|') && splitTableRow(trimmed).length >= 2;
}

function isTableSeparator(line: string) {
    const cells = splitTableRow(line);
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map((cell) => cell.trim());
}

function normalizeMarkdownForCardView(text: string) {
    return renderInlineCodeTags(normalizeMarkdownForLark(text));
}

function renderInlineCodeTags(text: string) {
    const fencePattern = /```[\s\S]*?```/g;
    let cursor = 0;
    let rendered = '';
    for (const match of text.matchAll(fencePattern)) {
        rendered += renderInlineCodeInText(text.slice(cursor, match.index));
        rendered += match[0];
        cursor = (match.index || 0) + match[0].length;
    }
    rendered += renderInlineCodeInText(text.slice(cursor));
    return rendered;
}

function renderInlineCodeInText(text: string) {
    return text.replace(/`([^`\n]{1,120})`/g, (_match, code) => {
        return `<text_tag color='neutral'>${escapeTextTagContent(String(code))}</text_tag>`;
    });
}

function escapeTextTagContent(text: string) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function splitMarkdownContent(text: string) {
    if (text.length <= MAX_MARKDOWN_ELEMENT_CHARS) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > MAX_MARKDOWN_ELEMENT_CHARS) {
        const candidate = remaining.slice(0, MAX_MARKDOWN_ELEMENT_CHARS);
        const splitAt = Math.max(candidate.lastIndexOf('\n\n'), candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
        const end = splitAt > MAX_MARKDOWN_ELEMENT_CHARS * 0.6 ? splitAt : MAX_MARKDOWN_ELEMENT_CHARS;
        chunks.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function normalizeMarkdownForLark(text: string) {
    let normalized = text
        .replace(/\n{3,}/g, '\n\n');

    const fenceCount = (normalized.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
        normalized = `${normalized}\n\`\`\``;
    }
    return normalized;
}

function escapeMd(text: string) {
    return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}
