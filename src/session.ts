export type SessionRecord = {
    session_key: string;
    chat_id: string;
    sender_open_id: string;
    codex_thread_id?: string;
    model?: string;
    reasoning_effort?: string;
    first_message_id?: string;
    last_message_id?: string;
    title?: string;
    updated_at: string;
};

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
        if (!item.codex_thread_id && !item.model && !item.reasoning_effort) {
            continue;
        }
        records[item.session_key || key] = {
            session_key: item.session_key || key,
            chat_id: item.chat_id || key.split(':')[0] || key,
            sender_open_id: item.sender_open_id || key.split(':')[1] || 'unknown',
            codex_thread_id: item.codex_thread_id,
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
    model?: string;
    reasoningEffort?: string;
    previous?: SessionRecord;
    messageId?: string;
    userText?: string;
}): SessionRecord {
    return {
        session_key: params.sessionKey,
        chat_id: params.chatId,
        sender_open_id: params.senderOpenId,
        codex_thread_id: params.threadId,
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
}): SessionRecord {
    const [chatId, senderOpenId] = params.sessionKey.split(':');
    return {
        session_key: params.sessionKey,
        chat_id: params.previous?.chat_id || chatId || params.sessionKey,
        sender_open_id: params.previous?.sender_open_id || senderOpenId || 'unknown',
        codex_thread_id: params.threadId,
        model: params.previous?.model,
        reasoning_effort: params.previous?.reasoning_effort,
        first_message_id: params.previous?.first_message_id,
        last_message_id: params.previous?.last_message_id,
        title: params.title || params.previous?.title,
        updated_at: new Date().toISOString(),
    };
}

function titleFromText(text: string) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;
    return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}
