import * as lark from '@larksuiteoapi/node-sdk';
import { Codex, Thread } from '@openai/codex-sdk';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getRunPolicy, requiresFeishuApproval } from './approval.js';
import { buildSessionRecord, makeSessionKey, normalizeSessionMap, SessionRecord } from './session.js';
import { startWebServer, updateStats, addLog } from './server.js';
import {
    buildAgentCard,
    createApprovalState,
    createStreamState,
    formatStreamState,
    shouldUpdateCard,
    updateStreamState,
} from './streaming.js';
import {
    approvalSummaryText,
    formatSkills,
    parseSlashCommand,
    rewriteSkillPrompt,
    runMcpList,
    slashHelpText,
} from './slash.js';
import { getUptime } from './utils.js';

dotenv.config();

type Mention = {
    id?: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
        app_id?: string;
    };
};

type ThreadCache = {
    thread: Thread;
    sandboxMode: string;
    approvalPolicy: string;
};

type ApprovalRequest = {
    approvalId: string;
    requesterOpenId: string;
    resolve: (approved: boolean) => void;
    timer: NodeJS.Timeout;
};

const IS_WINDOWS = process.platform === 'win32';
const SESSION_FILE = path.join(process.cwd(), 'bot_sessions.json');
const APPROVAL_TIMEOUT_MS = Number(process.env.FEISHU_APPROVAL_TIMEOUT_MS || 60_000);
const FEISHU_APPROVAL_ENABLED = getBool('FEISHU_APPROVAL_ENABLED', true);
const FEISHU_APPROVAL_BUTTONS_ENABLED = getBool('FEISHU_APPROVAL_BUTTONS_ENABLED', true);
const DEFAULT_WORKDIR = process.cwd();

ensureAdminPrivileges();
startWebServer();

const BOT_IDENTIFIERS = {
    openId: process.env.FEISHU_BOT_OPEN_ID?.trim(),
    userId: process.env.FEISHU_BOT_USER_ID?.trim(),
    unionId: process.env.FEISHU_BOT_UNION_ID?.trim(),
    appId: process.env.FEISHU_APP_ID?.trim(),
};

let sessionMap: Record<string, SessionRecord> = loadSessions();
let messageCount = 0;
let hasWarnedMissingBotIds = false;

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    console.error('错误: 请在 .env 文件中填写正确的 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
    process.exit(1);
}

const client = new lark.Client({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
});

console.log('正在初始化 Codex...');
const codexEnv = { ...process.env };
if (process.env.CODEX_CONFIG_DIR_OVERRIDE?.trim()) {
    codexEnv.CODEX_CONFIG_DIR = process.env.CODEX_CONFIG_DIR_OVERRIDE.trim();
} else {
    delete codexEnv.CODEX_CONFIG_DIR;
}

const codexPathOverride = process.env.CODEX_PATH_OVERRIDE || process.env.CODEX_BIN || undefined;
const codex = new Codex({ env: codexEnv, codexPathOverride });
const threadMap = new Map<string, ThreadCache>();
const activeSessions = new Set<string>();
const pendingApprovals = new Map<string, ApprovalRequest>();
const processedMessages = new Set<string>();
const MAX_PROCESSED_MESSAGES = 1000;
const loggerLevel = resolveLoggerLevel(process.env.FEISHU_LOGGER_LEVEL);

const wsClient = new lark.WSClient({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    loggerLevel,
});

wsClient.start({
    eventDispatcher: new lark.EventDispatcher({})
        .register({
            'im.message.receive_v1': handleMessageEvent,
            'card.action.trigger': handleCardAction as any,
        }),
});

console.log('飞书 + Codex 集成机器人正在启动...');

function isRunningAsAdmin() {
    if (!IS_WINDOWS) return true;
    try {
        return spawnSync('fltmc', [], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
}

function ensureAdminPrivileges() {
    if (isRunningAsAdmin()) return;
    console.error('[权限] 当前程序需要在 Windows 管理员权限下运行。');
    console.error('请以管理员身份运行方式重新打开终端后再启动项目。');
    process.exit(1);
}

function loadSessions() {
    try {
        if (!fs.existsSync(SESSION_FILE)) return {};
        const sessions = normalizeSessionMap(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')));
        const sessionCount = Object.keys(sessions).length;
        console.log(`[系统] 已加载 ${sessionCount} 个历史会话记录`);
        addLog('info', `已加载 ${sessionCount} 个历史会话记录`);
        updateStats({ sessions: sessionCount });
        return sessions;
    } catch (e) {
        console.error('[系统] 加载会话记录失败:', e);
        addLog('error', `加载会话记录失败: ${e}`);
        return {};
    }
}

function saveSessions() {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionMap, null, 2));
    } catch (e) {
        console.error('[系统] 保存会话记录失败:', e);
    }
}

function getBool(key: string, defaultVal: boolean) {
    const val = process.env[key];
    if (!val) return defaultVal;
    return val.toLowerCase() === 'true';
}

function resolveLoggerLevel(level?: string) {
    const normalized = (level || 'info').toLowerCase();
    switch (normalized) {
        case 'debug':
            return lark.LoggerLevel.debug;
        case 'info':
            return lark.LoggerLevel.info;
        case 'warn':
        case 'warning':
            return lark.LoggerLevel.warn;
        case 'error':
            return lark.LoggerLevel.error;
        default:
            if (level) console.warn(`[系统] 未知的 FEISHU_LOGGER_LEVEL=${level}，已使用 info`);
            return lark.LoggerLevel.info;
    }
}

function isBotMentioned(mentions?: Mention[]) {
    if (!mentions || mentions.length === 0) return false;
    const { openId, userId, unionId, appId } = BOT_IDENTIFIERS;
    if (!openId && !userId && !unionId && !appId) {
        if (!hasWarnedMissingBotIds) {
            console.warn('[系统] 未设置 FEISHU_BOT_OPEN_ID/USER_ID/UNION_ID，群聊中使用 mentions 非空判断');
            hasWarnedMissingBotIds = true;
        }
        return mentions.length > 0;
    }

    return mentions.some((mention) => {
        const id = mention.id;
        if (!id) return false;
        if (openId && id.open_id === openId) return true;
        if (userId && id.user_id === userId) return true;
        if (unionId && id.union_id === unionId) return true;
        if (appId && id.app_id === appId) return true;
        return false;
    });
}

function recordHandledMessage() {
    messageCount++;
    updateStats({ messages: messageCount });
}

async function handleMessageEvent(data: any) {
    const { message_id, chat_id, content, message_type, create_time, mentions, chat_type } = data.message;
    const senderOpenId = data.sender?.sender_id?.open_id || data.sender?.sender_id?.user_id || 'unknown';
    const sessionKey = makeSessionKey(chat_id, senderOpenId);

    if (processedMessages.has(message_id)) {
        console.warn(`[忽略重复消息] ID: ${message_id}`);
        return;
    }

    const msgTime = parseInt(create_time, 10);
    if (!isNaN(msgTime) && (Date.now() - msgTime) > 60 * 1000) {
        console.warn(`[忽略过期消息] ID: ${message_id}`);
        return;
    }

    processedMessages.add(message_id);
    if (processedMessages.size > MAX_PROCESSED_MESSAGES) {
        const firstItem = processedMessages.values().next().value;
        processedMessages.delete(firstItem);
    }

    if (message_type !== 'text') return;

    try {
        const userText = JSON.parse(content).text.trim();
        console.log(`[收到消息] ${userText}`);
        addLog('info', `收到消息: ${userText.substring(0, 50)}...`);

        if (chat_type === 'group' && !isBotMentioned(mentions)) {
            console.log('[忽略群聊消息] 未 @ 机器人');
            return;
        }

        if (await handleTextApproval(userText, message_id, senderOpenId)) {
            recordHandledMessage();
            return;
        }

        const slashResult = await handleSlashCommand(userText, message_id, sessionKey);
        if (slashResult.handled) {
            recordHandledMessage();
            return;
        }

        await executeUserTask({
            chatId: chat_id,
            senderOpenId,
            sessionKey,
            sourceMessageId: message_id,
            userText: slashResult.userText || userText,
        });
        recordHandledMessage();
    } catch (err) {
        console.error('处理消息出错:', err);
        addLog('error', `处理消息出错: ${err instanceof Error ? err.message : String(err)}`);
        await replyText(message_id, `发生错误: ${err instanceof Error ? err.message : String(err)}`);
        recordHandledMessage();
    }
}

async function handleSlashCommand(userText: string, messageId: string, sessionKey: string) {
    const command = parseSlashCommand(userText);
    if (!command) return { handled: false };

    if (command.name === 'skill') {
        const result = rewriteSkillPrompt(command.args);
        if (result.error) {
            await replyText(messageId, result.error);
            return { handled: true };
        }
        return { handled: false, userText: result.text };
    }

    if (command.name === 'help') {
        await replyText(messageId, slashHelpText());
        return { handled: true };
    }
    if (command.name === 'skills') {
        await replyText(messageId, formatSkills(command.args));
        return { handled: true };
    }
    if (command.name === 'mcp') {
        await replyText(messageId, runMcpList());
        return { handled: true };
    }
    if (command.name === 'approval') {
        await replyText(messageId, approvalSummaryText());
        return { handled: true };
    }
    if (command.name === 'reset' || command.name === 'clear') {
        delete sessionMap[sessionKey];
        threadMap.delete(sessionKey);
        saveSessions();
        updateStats({ sessions: Object.keys(sessionMap).length });
        await replyText(messageId, '已清空当前会话记忆。');
        return { handled: true };
    }
    if (command.name === 'status') {
        await replyText(messageId, [
            '机器人状态',
            '',
            '状态: 运行中',
            `活跃会话: ${Object.keys(sessionMap).length}`,
            `处理消息: ${messageCount}`,
            `运行时间: ${getUptime()}`,
            'Codex SDK: 已连接',
            '飞书 WebSocket: 已连接',
        ].join('\n'));
        return { handled: true };
    }

    await replyText(messageId, slashHelpText());
    return { handled: true };
}

async function executeUserTask(params: {
    chatId: string;
    senderOpenId: string;
    sessionKey: string;
    sourceMessageId: string;
    userText: string;
}) {
    if (activeSessions.has(params.sessionKey)) {
        await replyText(params.sourceMessageId, '当前会话已有任务在执行。');
        return;
    }

    activeSessions.add(params.sessionKey);
    try {
        const needsApproval = FEISHU_APPROVAL_ENABLED && requiresFeishuApproval(params.userText);
        let privileged = false;
        let targetMessageId: string | null = null;

        if (needsApproval) {
            const approvalId = createApprovalId();
            const approvalState = createApprovalState(params.userText, approvalId, [
                `Sandbox: ${getRunPolicy(true).sandboxMode}`,
                `Approval policy: ${getRunPolicy(true).approvalPolicy}`,
                `Workdir: ${getWorkingDirectory()}`,
                `文本审批: approve ${approvalId} / deny ${approvalId}`,
            ].join('\n'));
            targetMessageId = await replyInteractive(params.sourceMessageId, approvalState);
            const approved = await waitForApproval(approvalId, params.senderOpenId);
            if (!approved) {
                const failedState = updateStreamState(approvalState, {
                    type: 'error',
                    message: '飞书审批未通过或超时，Codex 未启动。',
                });
                await updateInteractiveOrText(params.sourceMessageId, targetMessageId, failedState);
                return;
            }
            privileged = true;
        }

        await runCodexStreamToFeishu({
            ...params,
            targetMessageId,
            privileged,
        });
    } finally {
        activeSessions.delete(params.sessionKey);
    }
}

async function waitForApproval(approvalId: string, requesterOpenId: string) {
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            pendingApprovals.delete(approvalId);
            resolve(false);
        }, APPROVAL_TIMEOUT_MS);
        pendingApprovals.set(approvalId, { approvalId, requesterOpenId, resolve, timer });
    });
}

async function handleTextApproval(userText: string, messageId: string, senderOpenId: string) {
    const match = userText.trim().match(/^(approve|deny)\s+([A-Za-z0-9_-]+)$/i);
    if (!match) return false;
    const approval = pendingApprovals.get(match[2]);
    if (!approval) {
        await replyText(messageId, '审批请求不存在或已过期。');
        return true;
    }
    finishApproval(approval, match[1].toLowerCase() === 'approve', senderOpenId);
    await replyText(messageId, match[1].toLowerCase() === 'approve' ? '审批已通过。' : '审批已拒绝。');
    return true;
}

async function handleCardAction(data: any) {
    console.log('[审批] received Feishu card action');
    const value = data.action?.value || data.event?.action?.value || data.value || {};
    const approvalId = value.approval_id || value.approvalId;
    const action = value.action;
    const senderOpenId = data.operator?.open_id || data.operator?.user_id || data.event?.operator?.open_id || 'unknown';
    const approval = pendingApprovals.get(approvalId);
    if (!approval) return undefined;

    finishApproval(approval, action === 'approve', senderOpenId);
    return undefined;
}

function finishApproval(approval: ApprovalRequest, approved: boolean, senderOpenId: string) {
    if (approval.requesterOpenId !== 'unknown' && senderOpenId !== 'unknown' && approval.requesterOpenId !== senderOpenId) {
        console.warn(`[审批] 忽略非请求者操作: ${senderOpenId}`);
        return;
    }
    clearTimeout(approval.timer);
    pendingApprovals.delete(approval.approvalId);
    approval.resolve(approved);
}

async function runCodexStreamToFeishu(params: {
    chatId: string;
    senderOpenId: string;
    sessionKey: string;
    sourceMessageId: string;
    userText: string;
    privileged: boolean;
    targetMessageId: string | null;
}) {
    const policy = getRunPolicy(params.privileged);
    const thread = await getOrCreateThread(params.sessionKey, policy);
    let state = createStreamState(params.userText);
    const targetMessageId = params.targetMessageId || await replyInteractive(params.sourceMessageId, state);
    if (params.targetMessageId) {
        await updateInteractiveOrText(params.sourceMessageId, targetMessageId, state);
    }
    let lastState = state;
    let lastResponseLength = 0;
    let lastUpdateAt = Date.now();

    try {
        console.log('[Codex] 正在请求 Codex...');
        const { events } = await thread.runStreamed(params.userText);

        for await (const event of events) {
            const nextState = updateStreamState(state, event);
            await rememberThread(params, thread);

            const now = Date.now();
            if (shouldUpdateCard(state, nextState, lastResponseLength) && now - lastUpdateAt >= 1500) {
                await updateInteractiveOrText(params.sourceMessageId, targetMessageId, nextState);
                lastState = nextState;
                lastResponseLength = nextState.responseText.length;
                lastUpdateAt = now;
            }
            state = nextState;
        }

        await rememberThread(params, thread);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state = updateStreamState(state, { type: 'error', message });
        console.error('Codex 流式处理出错:', err);
        addLog('error', `Codex 流式处理出错: ${message}`);
    } finally {
        if (JSON.stringify(state) !== JSON.stringify(lastState)) {
            await updateInteractiveOrText(params.sourceMessageId, targetMessageId, state);
        }
    }

    console.log(`[Codex 回复] ${state.responseText.substring(0, 50)}...`);
}

async function getOrCreateThread(sessionKey: string, policy: { sandboxMode: string; approvalPolicy: string }): Promise<Thread> {
    const cached = threadMap.get(sessionKey);
    if (cached && cached.sandboxMode === policy.sandboxMode && cached.approvalPolicy === policy.approvalPolicy) {
        return cached.thread;
    }

    const existingThreadId = sessionMap[sessionKey]?.codex_thread_id;
    const threadOptions = {
        skipGitRepoCheck: getBool('CODEX_SKIP_GIT_CHECK', true),
        sandboxMode: policy.sandboxMode as any,
        approvalPolicy: policy.approvalPolicy as any,
        modelReasoningEffort: (process.env.CODEX_REASONING_EFFORT || 'medium') as any,
        webSearchEnabled: getBool('CODEX_WEB_SEARCH_ENABLED', true),
        workingDirectory: getWorkingDirectory(),
    };

    let thread: Thread;
    if (existingThreadId) {
        try {
            console.log(`[会话 ${sessionKey}] 恢复历史线程: ${existingThreadId}`);
            thread = codex.resumeThread(existingThreadId, threadOptions);
        } catch (e) {
            console.warn(`[会话 ${sessionKey}] 恢复失败，将创建新线程: ${e}`);
            thread = codex.startThread(threadOptions);
        }
    } else {
        console.log(`[会话 ${sessionKey}] 创建全新线程`);
        thread = codex.startThread(threadOptions);
    }

    threadMap.set(sessionKey, { thread, sandboxMode: policy.sandboxMode, approvalPolicy: policy.approvalPolicy });
    return thread;
}

async function rememberThread(params: {
    chatId: string;
    senderOpenId: string;
    sessionKey: string;
    sourceMessageId: string;
    userText: string;
}, thread: Thread) {
    if (!thread.id) return;
    const previous = sessionMap[params.sessionKey];
    if (previous?.codex_thread_id === thread.id && previous?.last_message_id === params.sourceMessageId) return;

    sessionMap[params.sessionKey] = buildSessionRecord({
        sessionKey: params.sessionKey,
        chatId: params.chatId,
        senderOpenId: params.senderOpenId,
        threadId: thread.id,
        previous,
        messageId: params.sourceMessageId,
        userText: params.userText,
    });
    saveSessions();
    addLog('info', `会话绑定: ${params.sessionKey}`);
    updateStats({ sessions: Object.keys(sessionMap).length });
}

function getWorkingDirectory() {
    return path.resolve(process.env.CODEX_WORKING_DIRECTORY || DEFAULT_WORKDIR);
}

function createApprovalId() {
    return `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function replyText(messageId: string, text: string): Promise<string | null> {
    try {
        const result = await client.im.message.reply({
            path: { message_id: messageId },
            data: {
                content: JSON.stringify({ text }),
                msg_type: 'text',
            },
        });
        return result.data?.message_id || null;
    } catch (e) {
        console.error('回复飞书失败:', e);
        return null;
    }
}

async function replyInteractive(messageId: string, state: ReturnType<typeof createStreamState>): Promise<string | null> {
    try {
        const result = await client.im.message.reply({
            path: { message_id: messageId },
            data: {
                content: JSON.stringify(buildAgentCard(state, { includeApprovalButtons: FEISHU_APPROVAL_BUTTONS_ENABLED })),
                msg_type: 'interactive',
            },
        });
        return result.data?.message_id || null;
    } catch (e) {
        console.error('发送飞书卡片失败:', e);
        return replyText(messageId, formatStreamState(state));
    }
}

async function patchInteractive(messageId: string, state: ReturnType<typeof createStreamState>) {
    await client.im.message.patch({
        path: { message_id: messageId },
        data: {
            content: JSON.stringify(buildAgentCard(state, { includeApprovalButtons: FEISHU_APPROVAL_BUTTONS_ENABLED })),
        },
    });
}

async function updateInteractiveOrText(sourceMessageId: string, targetMessageId: string | null, state: ReturnType<typeof createStreamState>) {
    if (!targetMessageId) {
        await replyInteractive(sourceMessageId, state);
        return;
    }
    try {
        await patchInteractive(targetMessageId, state);
    } catch (e) {
        console.error('更新飞书卡片失败:', e);
        await replyText(sourceMessageId, formatStreamState(state));
    }
}
