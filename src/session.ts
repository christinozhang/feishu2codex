import type { CodexThreadSummary } from './runtime.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SessionRecord = {
    session_key: string;
    chat_id: string;
    sender_open_id: string;
    codex_thread_id?: string;
    claude_session_id?: string;
    model?: string;
    reasoning_effort?: string;
    first_message_id?: string;
    last_message_id?: string;
    title?: string;
    updated_at: string;
};

export function runtimeSessionIdField(runtimeKind: string): 'codex_thread_id' | 'claude_session_id' {
    return runtimeKind === 'claude-code' ? 'claude_session_id' : 'codex_thread_id';
}

export function clearRuntimeSessionId(record: SessionRecord, runtimeKind: string): SessionRecord {
    const next = { ...record };
    delete next[runtimeSessionIdField(runtimeKind)];
    return next;
}

export function makeSessionKey(chatId: string, senderOpenId: string) {
    return `${chatId}:${senderOpenId || 'unknown'}`;
}

export function normalizeSessionMap(raw: unknown): Record<string, SessionRecord> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    const records: Record<string, SessionRecord> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') {
            records[key] = {
                session_key: key,
                chat_id: key,
                sender_open_id: 'unknown',
                codex_thread_id: value,
                updated_at: new Date(0).toISOString(),
            };
            continue;
        }
        if (!value || typeof value !== 'object') {
            continue;
        }
        const item = value as Partial<SessionRecord>;
        if (!item.codex_thread_id && !item.claude_session_id && !item.model && !item.reasoning_effort) {
            continue;
        }
        records[item.session_key || key] = {
            session_key: item.session_key || key,
            chat_id: item.chat_id || key.split(':')[0] || key,
            sender_open_id: item.sender_open_id || key.split(':')[1] || 'unknown',
            codex_thread_id: item.codex_thread_id,
            claude_session_id: item.claude_session_id,
            model: item.model,
            reasoning_effort: item.reasoning_effort,
            first_message_id: item.first_message_id,
            last_message_id: item.last_message_id,
            title: item.title,
            updated_at: item.updated_at || new Date().toISOString(),
        };
    }
    return records;
}

export function buildSessionRecord(params: {
    sessionKey: string;
    chatId: string;
    senderOpenId: string;
    threadId: string;
    runtimeKind?: string;
    model?: string;
    reasoningEffort?: string;
    previous?: SessionRecord;
    messageId?: string;
    userText?: string;
}): SessionRecord {
    const isClaude = params.runtimeKind === 'claude-code';
    return {
        session_key: params.sessionKey,
        chat_id: params.chatId,
        sender_open_id: params.senderOpenId,
        codex_thread_id: isClaude ? params.previous?.codex_thread_id : params.threadId,
        claude_session_id: isClaude ? params.threadId : params.previous?.claude_session_id,
        model: params.model || params.previous?.model,
        reasoning_effort: params.reasoningEffort || params.previous?.reasoning_effort,
        first_message_id: params.previous?.first_message_id || params.messageId,
        last_message_id: params.messageId || params.previous?.last_message_id,
        title: params.previous?.title || titleFromText(params.userText || ''),
        updated_at: new Date().toISOString(),
    };
}

export function bindSessionThreadRecord(params: {
    sessionKey: string;
    threadId: string;
    previous?: SessionRecord;
    title?: string;
    runtimeKind?: string;
}): SessionRecord {
    const [chatId, senderOpenId] = params.sessionKey.split(':');
    const isClaude = params.runtimeKind === 'claude-code';
    return {
        session_key: params.sessionKey,
        chat_id: params.previous?.chat_id || chatId || params.sessionKey,
        sender_open_id: params.previous?.sender_open_id || senderOpenId || 'unknown',
        codex_thread_id: isClaude ? params.previous?.codex_thread_id : params.threadId,
        claude_session_id: isClaude ? params.threadId : params.previous?.claude_session_id,
        model: params.previous?.model,
        reasoning_effort: params.previous?.reasoning_effort,
        first_message_id: params.previous?.first_message_id,
        last_message_id: params.previous?.last_message_id,
        title: params.title || params.previous?.title,
        updated_at: new Date().toISOString(),
    };
}

export function listRuntimeSessionThreads(
    sessions: Record<string, SessionRecord>,
    runtimeKind: string,
    params: { searchTerm?: string; limit?: number } = {},
): CodexThreadSummary[] {
    const field = runtimeSessionIdField(runtimeKind);
    const searchTerm = params.searchTerm?.trim().toLowerCase() || '';
    const limit = params.limit ?? 10;
    return Object.values(sessions)
        .map((record) => {
            const id = record[field];
            if (!id) return null;
            const title = record.title || id;
            const preview = record.session_key;
            const item: CodexThreadSummary = {
                id,
                title,
                preview,
                cwd: '',
                source: runtimeKind === 'claude-code' ? 'claude-code' : 'bot-session',
                status: 'idle',
                updatedAt: Date.parse(record.updated_at) || 0,
            };
            return item;
        })
        .filter((item): item is CodexThreadSummary => Boolean(item))
        .filter((item) => {
            if (!searchTerm) return true;
            return [
                item.id,
                item.title,
                item.preview,
            ].some((value) => value.toLowerCase().includes(searchTerm));
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.max(0, limit));
}

export function listClaudeProjectThreads(
    projectsRoot = path.join(os.homedir(), '.claude', 'projects'),
    params: { searchTerm?: string; limit?: number } = {},
): CodexThreadSummary[] {
    if (!fs.existsSync(projectsRoot)) return [];
    const searchTerm = params.searchTerm?.trim().toLowerCase() || '';
    const limit = params.limit ?? 10;
    const threads: CodexThreadSummary[] = [];

    for (const projectName of safeReadDir(projectsRoot)) {
        const projectDir = path.join(projectsRoot, projectName);
        if (!safeIsDirectory(projectDir)) continue;
        for (const fileName of safeReadDir(projectDir)) {
            if (!fileName.endsWith('.jsonl')) continue;
            const thread = readClaudeProjectThread(path.join(projectDir, fileName));
            if (!thread) continue;
            if (searchTerm && !threadMatchesSearch(thread, searchTerm)) continue;
            threads.push(thread);
        }
    }

    return dedupeRuntimeThreads(threads)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.max(0, limit));
}

export function mergeRuntimeThreads(
    threadGroups: CodexThreadSummary[][],
    limit = 10,
): CodexThreadSummary[] {
    return dedupeRuntimeThreads(threadGroups.flat())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.max(0, limit));
}

function readClaudeProjectThread(filePath: string): CodexThreadSummary | null {
    let sessionId = path.basename(filePath, '.jsonl');
    let title = '';
    let preview = '';
    let cwd = '';
    let updatedAt = 0;

    for (const line of safeReadLines(filePath)) {
        const item = parseJsonLine(line);
        if (!item) continue;
        if (typeof item.sessionId === 'string' && item.sessionId.trim()) {
            sessionId = item.sessionId.trim();
        }
        if (typeof item.cwd === 'string' && item.cwd.trim()) {
            cwd = item.cwd.trim();
        }
        if (typeof item.timestamp === 'string') {
            updatedAt = Math.max(updatedAt, Date.parse(item.timestamp) || 0);
        }
        if (typeof item.lastPrompt === 'string' && item.lastPrompt.trim()) {
            title = item.lastPrompt.trim();
            preview = item.lastPrompt.trim();
            continue;
        }
        const text = messageText(item.message);
        if (text && !title) title = text;
        if (text) preview = text;
    }

    const stat = safeStat(filePath);
    if (!updatedAt && stat) updatedAt = stat.mtimeMs;
    if (!sessionId) return null;
    return {
        id: sessionId,
        title: cleanSummaryText(title || sessionId, 80),
        preview: cleanSummaryText(preview || title || '', 160),
        cwd: cleanSummaryText(cwd, 220),
        source: 'claude-code',
        status: 'idle',
        updatedAt,
    };
}

function dedupeRuntimeThreads(threads: CodexThreadSummary[]) {
    const byId = new Map<string, CodexThreadSummary>();
    for (const thread of threads) {
        const previous = byId.get(thread.id);
        if (!previous || thread.updatedAt >= previous.updatedAt) {
            byId.set(thread.id, thread);
        }
    }
    return [...byId.values()];
}

function threadMatchesSearch(thread: CodexThreadSummary, searchTerm: string) {
    return [
        thread.id,
        thread.title,
        thread.preview,
        thread.cwd,
    ].some((value) => value.toLowerCase().includes(searchTerm));
}

function safeReadDir(dir: string) {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

function safeIsDirectory(targetPath: string) {
    try {
        return fs.statSync(targetPath).isDirectory();
    } catch {
        return false;
    }
}

function safeReadLines(filePath: string) {
    try {
        return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

function safeStat(filePath: string) {
    try {
        return fs.statSync(filePath);
    } catch {
        return null;
    }
}

function parseJsonLine(line: string) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

function messageText(message: unknown) {
    if (!message || typeof message !== 'object') return '';
    const content = (message as any).content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
        .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
                return (item as any).text;
            }
            return '';
        })
        .join('')
        .trim();
}

function cleanSummaryText(value: string, limit: number) {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function titleFromText(text: string) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;
    return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}
