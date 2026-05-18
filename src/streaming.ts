import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';

export type StreamPhase = 'approval' | 'running' | 'completed' | 'failed';
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

export type StreamState = {
    phase: StreamPhase;
    task: string;
    responseText: string;
    timeline: TimelineItem[];
    approvalId?: string;
};

const MAX_TASK_CHARS = 300;
const MAX_TIMELINE_ITEMS = 8;
const MAX_OUTPUT_SUMMARY_CHARS = 500;
const MAX_TEXT_CHARS = 3800;
const MAX_MARKDOWN_ELEMENT_CHARS = 3200;

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
    };
}

export function createApprovalState(task: string, approvalId: string, detail: string): StreamState {
    return addTimelineItem({
        ...createStreamState(task, 'approval'),
        approvalId,
    }, {
        id: approvalId,
        kind: 'approval',
        title: '等待飞书审批',
        detail,
        status: 'running',
    });
}

export function updateStreamState(state: StreamState, event: ThreadEvent | any): StreamState {
    if (event.type === 'turn.completed') {
        return { ...state, phase: 'completed' };
    }

    if (event.type === 'turn.failed') {
        return addTimelineItem({ ...state, phase: 'failed' }, {
            id: 'turn.failed',
            kind: 'error',
            title: '处理失败',
            detail: event.error?.message || 'Codex turn failed',
            status: 'failed',
        });
    }

    if (event.type === 'error') {
        return addTimelineItem({ ...state, phase: 'failed' }, {
            id: 'error',
            kind: 'error',
            title: '处理失败',
            detail: event.message || String(event),
            status: 'failed',
        });
    }

    if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') {
        return state;
    }

    return applyItem(state, event.item);
}

export function shouldUpdateCard(previous: StreamState, next: StreamState, lastResponseLength: number): boolean {
    if (previous.phase !== next.phase) return true;
    if (next.responseText.length - lastResponseLength >= 80) return true;

    const previousTools = previous.timeline.map((item) => `${item.id}:${item.status}:${item.detail}`).join('|');
    const nextTools = next.timeline.map((item) => `${item.id}:${item.status}:${item.detail}`).join('|');
    return previousTools !== nextTools;
}

export function buildAgentCard(state: StreamState, options: { includeApprovalButtons?: boolean } = {}) {
    const header = headerForPhase(state.phase);
    const elements: any[] = [
        {
            tag: 'div',
            text: { tag: 'lark_md', content: `**任务**\n${formatCardMarkdown(state.task || '未命名任务', MAX_TASK_CHARS)}` },
        },
    ];

    if (state.responseText.trim()) {
        elements.push(...buildMarkdownSection('回复', state.responseText, 8000));
    }

    const timeline = state.timeline.slice(-MAX_TIMELINE_ITEMS);
    if (timeline.length > 0) {
        elements.push({
            tag: 'collapsible_panel',
            expanded: state.phase !== 'completed',
            header: {
                title: {
                    tag: 'plain_text',
                    content: `执行过程 · ${state.timeline.length} 条`,
                },
            },
            elements: timeline.map((item) => ({
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: formatTimelineItem(item),
                },
            })),
        });
    }

    if (state.phase === 'approval' && state.approvalId && options.includeApprovalButtons !== false) {
        elements.push({
            tag: 'action',
            actions: [
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: 'Approve' },
                    type: 'primary',
                    value: { action: 'approve', approval_id: state.approvalId },
                },
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: 'Deny' },
                    type: 'danger',
                    value: { action: 'deny', approval_id: state.approvalId },
                },
            ],
        });
    }

    return {
        config: { wide_screen_mode: true, update_multi: true },
        header,
        elements,
    };
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
            return { ...state, responseText: redact(item.text || '') };
        case 'reasoning':
            return addTimelineItem(state, {
                id: item.id,
                kind: 'reasoning',
                title: '分析中',
                detail: 'Codex 正在整理可见步骤。',
                status: statusFromItem(item.status),
            });
        case 'command_execution':
            return addTimelineItem(state, {
                id: item.id,
                kind: 'command',
                title: commandTitle(item.status),
                detail: formatCommandDetail(item),
                status: statusFromItem(item.status),
            });
        case 'mcp_tool_call':
            return addTimelineItem(state, {
                id: item.id,
                kind: 'mcp',
                title: `MCP ${item.server || 'unknown'}.${item.tool || 'unknown'}`,
                detail: `${item.status || 'running'} ${safeText(redact(item.arguments ?? ''), 240)}`.trim(),
                status: statusFromItem(item.status),
            });
        case 'file_change':
            return addTimelineItem(state, {
                id: item.id,
                kind: 'file_change',
                title: `文件变更 ${item.status || ''}`.trim(),
                detail: safeText((item.changes || []).map((change: any) => `${change.kind} ${change.path}`).join('\n'), 500),
                status: statusFromItem(item.status),
            });
        case 'web_search':
            return addTimelineItem(state, {
                id: item.id,
                kind: 'web_search',
                title: 'Web 搜索',
                detail: safeText(item.query || '', 240),
                status: statusFromItem(item.status || 'completed'),
            });
        case 'todo_list':
            return addTimelineItem(state, {
                id: item.id,
                kind: 'todo',
                title: '任务列表',
                detail: formatTodoStatus(item.items || []),
                status: statusFromItem(item.status || 'completed'),
            });
        case 'error':
            return addTimelineItem({ ...state, phase: 'failed' }, {
                id: item.id,
                kind: 'error',
                title: '处理失败',
                detail: item.message || 'unknown error',
                status: 'failed',
            });
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

function buildMarkdownSection(title: string, text: unknown, limit: number) {
    const content = normalizeMarkdownForCardView(safeText(text, limit));
    return [
        {
            tag: 'markdown',
            content: `**${title}**`,
        },
        ...splitMarkdownContent(content).map((chunk) => ({
            tag: 'markdown',
            content: chunk,
        })),
    ];
}

function normalizeMarkdownForCardView(text: string) {
    return normalizeMarkdownForLark(text);
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
        .replace(/```[ \t]*[A-Za-z0-9_+.#-]+[ \t]*\n/g, '```\n')
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
