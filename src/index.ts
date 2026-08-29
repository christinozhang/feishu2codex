import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getRunPolicy, requiresFeishuApproval } from './approval.js';
import { applyCodexResourceEnv, buildRuntimePolicy, buildRuntimeRetryParams, CodexRuntime, CodexRuntimeKind, CodexThreadHandle, createCodexRuntime, isRetryableThreadError, isRuntimeConnectionClosedEvent, loadCodexResourceLimits, runtimeDisplayNameForKind, selectCodexRuntimeKind, shouldFlushFinalStreamState } from './runtime.js';
import { bindSessionThreadRecord, buildSessionRecord, clearRuntimeSessionId, listClaudeProjectThreads, listRuntimeSessionThreads, makeSessionKey, mergeRuntimeThreads, normalizeSessionMap, runtimeSessionIdField, SessionRecord } from './session.js';
import { startWebServer, updateStats, addLog } from './server.js';
import {
    buildAgentCard,
    buildQueueSummaryCard,
    buildQueuedTaskCard,
    buildThreadPickerCard,
    createApprovalState,
    createStreamState,
    formatThreadPickerText,
    formatStreamState,
    hasCommandGroupCompletionChange,
    markStreamInterrupted,
    RuntimeCardOptions,
    shouldUpdateCard,
    updateStreamState,
} from './streaming.js';
import {
    canOperateTask,
    clearQueuedTasks,
    createQueuedTask,
    getOrCreateRunner,
    moveQueuedTaskToFront,
    QueuedTask,
    removeQueuedTask,
    SessionRunner,
    snapshotRunner,
} from './queue.js';
import { createTaskLimiter } from './taskLimiter.js';
import {
    approvalSummaryText,
    formatModelStatus,
    formatSkills,
    parseModelSelection,
    parseSlashCommand,
    rewriteSkillPrompt,
    runMcpList,
    slashHelpText,
} from './slash.js';
import { getUptime } from './utils.js';
import { expandPathVariables, resolveWorkingDirectorySelection } from './workdir.js';

const envFile = process.env.FEISHU_ENV_FILE?.trim();
dotenv.config(envFile ? { path: expandPathVariables(envFile) } : undefined);

type Mention = {
    id?: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
        app_id?: string;
    };
};

type ThreadCache = {
    thread: CodexThreadHandle;
    runtimeKind: string;
    sandboxMode: string;
    approvalPolicy: string;
    workingDirectory: string;
    desktopListDirectory: string;
    model?: string;
    reasoningEffort?: string;
};

type ApprovalRequest = {
    approvalId: string;
    requesterOpenId: string;
    resolve: (approved: boolean) => void;
    timer: NodeJS.Timeout;
};

const IS_WINDOWS = process.platform === 'win32';
const SESSION_FILE = path.resolve(expandPathVariables(process.env.BOT_SESSION_FILE || path.join(process.cwd(), 'bot_sessions.json')));
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

const codexResourceLimits = loadCodexResourceLimits(process.env);
const codexEnv = applyCodexResourceEnv({ ...process.env }, codexResourceLimits);
if (process.env.CODEX_CONFIG_DIR_OVERRIDE?.trim()) {
    codexEnv.CODEX_CONFIG_DIR = process.env.CODEX_CONFIG_DIR_OVERRIDE.trim();
} else {
    delete codexEnv.CODEX_CONFIG_DIR;
}

const codexPathOverride = expandOptionalPath(process.env.CODEX_PATH_OVERRIDE || process.env.CODEX_BIN);
const runtimeKind = selectCodexRuntimeKind(process.env);
console.log(`正在初始化 ${runtimeDisplayName(runtimeKind)}...`);
const codexRuntime: CodexRuntime = createCodexRuntime({
    kind: runtimeKind,
    env: codexEnv,
    codexPathOverride,
    resourceLimits: codexResourceLimits,
});
console.log(`[Runtime] name=${runtimeDisplayName(codexRuntime.kind)} kind=${codexRuntime.kind}`);
console.log(`[ResourceLimits] max_active_tasks=${codexResourceLimits.maxActiveTasks} task_timeout_ms=${codexResourceLimits.taskTimeoutMs} process_nice=${codexResourceLimits.processNice} cpu_time_seconds=${codexResourceLimits.cpuTimeSeconds} gomaxprocs=${codexResourceLimits.goMaxProcs} goflags=${codexResourceLimits.goFlags || '(empty)'} app_server_idle_shutdown_ms=${codexResourceLimits.appServerIdleShutdownMs}`);
const threadMap = new Map<string, ThreadCache>();
const sessionRunners = new Map<string, SessionRunner>();
const codexTaskLimiter = createTaskLimiter(codexResourceLimits.maxActiveTasks);
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

console.log(`飞书 + ${runtimeDisplayName(codexRuntime.kind)} 集成机器人正在启动...`);

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

        const slashResult = await handleSlashCommand(userText, {
            messageId: message_id,
            sessionKey,
            senderOpenId,
        });
        if (slashResult.handled) {
            recordHandledMessage();
            return;
        }

        await enqueueUserTask({
            chatId: chat_id,
            senderOpenId,
            sessionKey,
            sourceMessageId: message_id,
            userText: slashResult.userText || userText,
            mode: slashResult.interrupt ? 'interrupt' : 'normal',
        });
        recordHandledMessage();
    } catch (err) {
        console.error('处理消息出错:', err);
        addLog('error', `处理消息出错: ${err instanceof Error ? err.message : String(err)}`);
        await replyText(message_id, `发生错误: ${err instanceof Error ? err.message : String(err)}`);
        recordHandledMessage();
    }
}

async function handleSlashCommand(userText: string, params: {
    messageId: string;
    sessionKey: string;
    senderOpenId: string;
}) {
    const command = parseSlashCommand(userText);
    if (!command) return { handled: false };

    if (command.name === 'skill') {
        const result = rewriteSkillPrompt(command.args);
        if (result.error) {
            await replyText(params.messageId, result.error);
            return { handled: true };
        }
        return { handled: false, userText: result.text };
    }

    if (command.name === 'help') {
        await replyText(params.messageId, slashHelpText());
        return { handled: true };
    }
    if (command.name === 'skills') {
        await replyText(params.messageId, formatSkills(command.args));
        return { handled: true };
    }
    if (command.name === 'mcp') {
        await replyText(params.messageId, runMcpList());
        return { handled: true };
    }
    if (command.name === 'approval') {
        await replyText(params.messageId, approvalSummaryText());
        return { handled: true };
    }
    if (command.name === 'model') {
        const selection = parseModelSelection(command.args);
        if (selection.model === null && selection.reasoningEffort === null) {
            await replyText(params.messageId, formatModelStatus(
                getSessionModel(params.sessionKey),
                getDefaultModel(),
                getSessionReasoningEffort(params.sessionKey),
                getDefaultReasoningEffort(),
            ));
            return { handled: true };
        }
        setSessionModelConfig(params.sessionKey, selection.model, selection.reasoningEffort);
        await replyText(params.messageId, [
            '当前会话模型配置已更新:',
            `模型: ${getSessionModel(params.sessionKey) || runtimeDefaultModelName()}`,
            `Reasoning effort: ${getSessionReasoningEffort(params.sessionKey) || runtimeDefaultReasoningName()}`,
        ].join('\n'));
        return { handled: true };
    }
    if (command.name === 'queue') {
        const runner = getOrCreateRunner(sessionRunners, params.sessionKey);
        const snapshot = snapshotRunner(runner);
        await replyInteractiveCard(params.messageId, buildQueueSummaryCard({
            sessionKey: params.sessionKey,
            currentTask: snapshot.current,
            queue: snapshot.queue,
        }), formatQueueAsText(snapshot.current, snapshot.queue));
        return { handled: true };
    }
    if (command.name === 'threads') {
        if (codexRuntime.kind === 'claude-code' && !codexRuntime.listThreads) {
            const storedThreads = listRuntimeSessionThreads(sessionMap, codexRuntime.kind, { searchTerm: command.args, limit: 20 });
            const nativeThreads = listClaudeProjectThreads(undefined, { searchTerm: command.args, limit: 20 });
            const threads = mergeRuntimeThreads([storedThreads, nativeThreads], 10);
            await replyInteractiveCard(params.messageId, buildThreadPickerCard({
                sessionKey: params.sessionKey,
                requesterOpenId: params.senderOpenId,
                sourceMessageId: params.messageId,
                searchTerm: command.args,
                runtimeKind: codexRuntime.kind,
                runtimeLabel: runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey)),
                threads,
            }), formatThreadPickerText(threads, command.args, codexRuntime.kind));
            return { handled: true };
        }
        if (!codexRuntime.listThreads) {
            await replyText(params.messageId, '当前 runtime 不支持 Desktop 对话检索。请使用 CODEX_RUNTIME=app-server。');
            return { handled: true };
        }
        try {
            const threads = await codexRuntime.listThreads({ searchTerm: command.args, limit: 10 });
            await replyInteractiveCard(params.messageId, buildThreadPickerCard({
                sessionKey: params.sessionKey,
                requesterOpenId: params.senderOpenId,
                sourceMessageId: params.messageId,
                searchTerm: command.args,
                runtimeKind: codexRuntime.kind,
                runtimeLabel: runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey)),
                threads,
            }), formatThreadPickerText(threads, command.args, codexRuntime.kind));
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await replyText(params.messageId, `检索 Codex Desktop 对话失败: ${message}`);
        }
        return { handled: true };
    }
    if (command.name === 'cancel') {
        const runner = getOrCreateRunner(sessionRunners, params.sessionKey);
        const removed = removeQueuedTask(runner, command.args.trim(), params.senderOpenId);
        await replyText(params.messageId, removed ? `已取消排队任务: ${removed.id}` : '未找到可取消的等待任务。');
        return { handled: true };
    }
    if (command.name === 'clear-queue') {
        const runner = getOrCreateRunner(sessionRunners, params.sessionKey);
        const count = clearQueuedTasks(runner, params.senderOpenId);
        await replyText(params.messageId, `已清空 ${count} 条等待任务。`);
        return { handled: true };
    }
    if (command.name === 'interrupt') {
        const taskText = rewriteExecutableSlash(command.args);
        if (taskText.error) {
            await replyText(params.messageId, taskText.error);
            return { handled: true };
        }
        return { handled: false, userText: taskText.text, interrupt: true };
    }
    if (command.name === 'reset' || command.name === 'clear') {
        resetSessionThread(params.sessionKey);
        updateStats({ sessions: Object.keys(sessionMap).length });
        await replyText(params.messageId, '已开启新对话。当前 runtime 会话绑定已移除，本机历史文件不会删除。');
        return { handled: true };
    }
    if (command.name === 'status') {
        const runtimeName = runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey));
        const runtimeSessionId = getRuntimeSessionId(sessionMap[params.sessionKey], codexRuntime.kind);
        await replyText(params.messageId, [
            '机器人状态',
            '',
            '状态: 运行中',
            `活跃会话: ${Object.keys(sessionMap).length}`,
            `处理消息: ${messageCount}`,
            `运行时间: ${getUptime()}`,
            `Runtime: ${runtimeName}`,
            `Runtime kind: ${codexRuntime.kind}`,
            `会话字段: ${runtimeSessionIdField(codexRuntime.kind)}`,
            `当前会话绑定: ${runtimeSessionId ? '已绑定' : '无'}`,
            '飞书 WebSocket: 已连接',
        ].join('\n'));
        return { handled: true };
    }

    await replyText(params.messageId, slashHelpText());
    return { handled: true };
}

function rewriteExecutableSlash(text: string): { text?: string; error?: string } {
    const trimmed = text.trim();
    if (!trimmed) return { error: '用法: /interrupt <task>' };
    const nested = parseSlashCommand(trimmed);
    if (!nested) return { text: trimmed };
    if (nested.name === 'skill') {
        return rewriteSkillPrompt(nested.args);
    }
    return { error: '只有 /skill 可以作为 /interrupt 的嵌套命令。' };
}

function formatQueueAsText(current: QueuedTask | null, queue: QueuedTask[]) {
    const lines = [
        'Agent 队列',
        '',
        `当前运行: ${current ? current.userText : '无'}`,
        '',
        '等待队列:',
    ];
    if (queue.length === 0) {
        lines.push('无等待任务');
    } else {
        lines.push(...queue.slice(0, 10).map((task, index) => `${index + 1}. ${task.id} ${task.userText}`));
    }
    if (queue.length > 10) lines.push(`还有 ${queue.length - 10} 条未展示。`);
    return lines.join('\n');
}

async function enqueueUserTask(params: {
    chatId: string;
    senderOpenId: string;
    sessionKey: string;
    sourceMessageId: string;
    userText: string;
    mode: 'normal' | 'interrupt';
}) {
    const runner = getOrCreateRunner(sessionRunners, params.sessionKey);
    const task = createQueuedTask(params);

    if (params.mode === 'interrupt') {
        enqueueTaskFront(runner, task);
        const interrupted = interruptRunner(runner, params.senderOpenId);
        if (!interrupted && !runner.draining) void drainSessionQueue(runner);
        await replyInteractiveCard(params.sourceMessageId, buildQueuedTaskCard({
            task,
            position: 1,
            queueLength: runner.queue.length,
            currentTask: runner.current,
        }), `已加入队列: ${task.id}`);
        return;
    }

    const idle = !runner.current && !runner.draining;
    const position = enqueueTaskBack(runner, task);
    if (!idle) {
        await replyInteractiveCard(params.sourceMessageId, buildQueuedTaskCard({
            task,
            position,
            queueLength: runner.queue.length,
            currentTask: runner.current,
        }), `已加入队列: ${task.id}`);
        return;
    }

    void drainSessionQueue(runner);
}

async function drainSessionQueue(runner: SessionRunner) {
    if (runner.draining) return;
    runner.draining = true;
    try {
        while (runner.queue.length > 0) {
            const task = runner.queue.shift();
            if (!task) continue;
            runner.current = task;
            runner.abortController = new AbortController();
            runner.interrupted = false;
            let releaseTaskSlot: (() => void) | null = null;
            let taskTimeout: NodeJS.Timeout | null = null;
            try {
                releaseTaskSlot = await codexTaskLimiter.acquire(runner.abortController.signal);
                taskTimeout = armTaskTimeout(runner, task);
                await runUserTaskNow(runner, task);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (runner.interrupted) {
                    addLog('info', `任务已停止: ${task.id}`);
                } else {
                    console.error('执行队列任务出错:', err);
                    addLog('error', `执行队列任务出错: ${message}`);
                }
            } finally {
                if (taskTimeout) clearTimeout(taskTimeout);
                releaseTaskSlot?.();
                runner.current = null;
                runner.abortController = null;
                runner.interrupted = false;
            }
        }
    } finally {
        runner.draining = false;
        if (!runner.current && runner.queue.length === 0) {
            sessionRunners.delete(runner.sessionKey);
        }
    }
}

function armTaskTimeout(runner: SessionRunner, task: QueuedTask): NodeJS.Timeout | null {
    if (codexResourceLimits.taskTimeoutMs <= 0) return null;
    return setTimeout(() => {
        if (!runner.current || runner.current.id !== task.id) return;
        runner.interrupted = true;
        runner.abortController?.abort();
        const seconds = Math.round(codexResourceLimits.taskTimeoutMs / 1000);
        console.warn(`[ResourceLimits] task timeout after ${seconds}s: ${task.id}`);
        addLog('warn', `任务超过 ${seconds}s，已请求停止 ${runtimeDisplayName(codexRuntime.kind)}: ${task.id}`);
    }, codexResourceLimits.taskTimeoutMs);
}

async function runUserTaskNow(runner: SessionRunner, task: QueuedTask) {
    try {
        const needsApproval = FEISHU_APPROVAL_ENABLED && requiresFeishuApproval(task.userText);
        let privileged = false;
        let targetMessageId: string | null = null;

        if (needsApproval) {
            const approvalId = createApprovalId();
            task.approvalId = approvalId;
            const approvalRuntimeName = runtimeDisplayName(codexRuntime.kind, getSessionModel(task.sessionKey));
            const approvalState = createApprovalState(task.userText, approvalId, [
                `Sandbox: ${getRunPolicy(true).sandboxMode}`,
                `Approval policy: ${getRunPolicy(true).approvalPolicy}`,
                `Workdir: ${resolveTaskDirectories(task.userText).workingDirectory}`,
                `文本审批: approve ${approvalId} / deny ${approvalId}`,
            ].join('\n'), approvalRuntimeName);
            targetMessageId = await replyInteractive(task.sourceMessageId, approvalState);
            task.targetMessageId = targetMessageId;
            const approved = await waitForApproval(approvalId, task.senderOpenId);
            task.approvalId = undefined;
            if (!approved) {
                const failedState = runner.interrupted
                    ? markStreamInterrupted(approvalState, `审批等待期间任务已被打断，${approvalRuntimeName} 未启动。`)
                    : updateStreamState(approvalState, {
                        type: 'error',
                        message: `飞书审批未通过或超时，${approvalRuntimeName} 未启动。`,
                    });
                await updateInteractiveOrText(task.sourceMessageId, targetMessageId, failedState);
                return;
            }
            privileged = true;
        }

        await runCodexStreamToFeishu({
            ...task,
            targetMessageId,
            privileged,
            signal: runner.abortController?.signal,
            isInterrupted: () => runner.interrupted,
        });
    } catch (err) {
        console.error('执行队列任务出错:', err);
        addLog('error', `执行队列任务出错: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function enqueueTaskBack(runner: SessionRunner, task: QueuedTask) {
    runner.queue.push(task);
    return runner.queue.length;
}

function enqueueTaskFront(runner: SessionRunner, task: QueuedTask) {
    runner.queue.unshift(task);
}

function interruptRunner(runner: SessionRunner, requesterOpenId: string) {
    if (!runner.current || !canOperateTask(runner.current, requesterOpenId)) return false;
    runner.interrupted = true;
    if (runner.current.approvalId) {
        const approval = pendingApprovals.get(runner.current.approvalId);
        if (approval) finishApproval(approval, false, requesterOpenId);
    }
    runner.abortController?.abort();
    return true;
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
    console.log('[卡片] received Feishu card action');
    const value = data.action?.value || data.event?.action?.value || data.value || {};
    const approvalId = value.approval_id || value.approvalId;
    const action = value.action;
    const senderOpenId = data.operator?.open_id || data.operator?.user_id || data.event?.operator?.open_id || 'unknown';

    if (action === 'approve' || action === 'deny') {
        const approval = pendingApprovals.get(approvalId);
        if (!approval) return undefined;
        finishApproval(approval, action === 'approve', senderOpenId);
        return undefined;
    }

    if (action === 'bind_thread') {
        await handleBindThreadCardAction(value, senderOpenId);
        return undefined;
    }

    await handleQueueCardAction(action, value, senderOpenId);
    return undefined;
}

async function handleBindThreadCardAction(value: any, senderOpenId: string) {
    const sessionKey = value.session_key || value.sessionKey;
    const threadId = value.thread_id || value.threadId;
    const requesterOpenId = value.requester_open_id || value.requesterOpenId || senderOpenId;
    const sourceMessageId = value.source_message_id || value.sourceMessageId;
    const title = value.thread_title || value.threadTitle;
    const runtimeKind = value.runtime_kind || value.runtimeKind || codexRuntime.kind;
    if (!sessionKey || !threadId) return;
    if (requesterOpenId !== 'unknown' && senderOpenId !== 'unknown' && requesterOpenId !== senderOpenId) {
        if (sourceMessageId) await replyText(sourceMessageId, '只有检索发起人可以绑定此对话。');
        return;
    }

    sessionMap[sessionKey] = bindSessionThreadRecord({
        sessionKey,
        threadId,
        previous: sessionMap[sessionKey],
        title,
        runtimeKind,
    });
    threadMap.delete(sessionKey);
    saveSessions();
    updateStats({ sessions: Object.keys(sessionMap).length });
    addLog('info', `会话绑定 ${runtimeKind}: ${sessionKey} -> ${threadId}`);
    const label = runtimeKind === 'claude-code' ? 'Claude Code 会话' : 'Codex Desktop 对话';
    if (sourceMessageId) await replyText(sourceMessageId, `已绑定 ${label}: ${threadId}`);
}

async function handleQueueCardAction(action: string, value: any, senderOpenId: string) {
    const sessionKey = value.session_key || value.sessionKey;
    const taskId = value.task_id || value.taskId;
    const requesterOpenId = value.requester_open_id || value.requesterOpenId || senderOpenId;
    const sourceMessageId = value.source_message_id || value.sourceMessageId;
    if (!sessionKey) return;

    const runner = getOrCreateRunner(sessionRunners, sessionKey);
    if (requesterOpenId !== 'unknown' && senderOpenId !== 'unknown' && requesterOpenId !== senderOpenId) {
        if (sourceMessageId) await replyText(sourceMessageId, '只有任务发起人可以操作此队列任务。');
        return;
    }

    if (action === 'interrupt_current') {
        const interrupted = interruptRunner(runner, senderOpenId);
        if (sourceMessageId) await replyText(sourceMessageId, interrupted ? '已请求打断当前任务。' : '没有可打断的当前任务。');
        return;
    }

    if (action === 'interrupt_with_task') {
        const moved = moveQueuedTaskToFront(runner, taskId, senderOpenId);
        if (!moved) {
            if (sourceMessageId) await replyText(sourceMessageId, '未找到可插队的等待任务。');
            return;
        }
        const interrupted = interruptRunner(runner, senderOpenId);
        if (!interrupted && !runner.draining) void drainSessionQueue(runner);
        if (sourceMessageId) await replyText(sourceMessageId, `任务已移到队首: ${moved.id}`);
        return;
    }

    if (action === 'cancel_queued_task') {
        const removed = removeQueuedTask(runner, taskId, senderOpenId);
        if (sourceMessageId) await replyText(sourceMessageId, removed ? `已取消排队任务: ${removed.id}` : '未找到可取消的等待任务。');
        return;
    }

    if (action === 'show_queue') {
        const snapshot = snapshotRunner(runner);
        if (sourceMessageId) {
            await replyInteractiveCard(sourceMessageId, buildQueueSummaryCard({
                sessionKey,
                currentTask: snapshot.current,
                queue: snapshot.queue,
            }), formatQueueAsText(snapshot.current, snapshot.queue));
        }
    }
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
    id: string;
    privileged: boolean;
    targetMessageId: string | null;
    signal?: AbortSignal;
    retried?: boolean;
    isInterrupted: () => boolean;
}) {
    const policy = getRunPolicy(params.privileged);
    let state = createStreamState(params.userText, 'running', runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey)));
    const cardOptions = runtimeCardOptions(params);
    const targetMessageId = params.targetMessageId || await replyInteractive(params.sourceMessageId, state, cardOptions);
    if (params.targetMessageId) {
        await updateInteractiveOrText(params.sourceMessageId, targetMessageId, state, cardOptions);
    }
    let lastState = state;
    let lastResponseLength = 0;
    let lastUpdateAt = Date.now();
    let delegatedRetry = false;
    let runtimeConnectionClosed = false;

    try {
        const thread = await getOrCreateThread(params.sessionKey, policy, params.userText);
        console.log(`[Runtime] requesting ${runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey))} kind=${codexRuntime.kind}`);
        const { events } = await thread.runStreamed(params.userText, { signal: params.signal });

        for await (const event of events) {
            const nextState = updateStreamState(state, event);
            if (isRuntimeConnectionClosedEvent(event)) {
                runtimeConnectionClosed = true;
                clearRuntimeSessionIdentity(params.sessionKey);
            } else if (!runtimeConnectionClosed) {
                await rememberThread(params, thread);
            }

            const now = Date.now();
            const shouldPatch = shouldUpdateCard(state, nextState, lastResponseLength);
            const shouldPatchImmediately = hasCommandGroupCompletionChange(state, nextState);
            if (shouldPatch && (shouldPatchImmediately || now - lastUpdateAt >= 1500)) {
                await updateInteractiveOrText(params.sourceMessageId, targetMessageId, nextState, runtimeCardOptions(params));
                lastState = nextState;
                lastResponseLength = nextState.responseText.length;
                lastUpdateAt = now;
            }
            state = nextState;
        }

        if (!runtimeConnectionClosed) {
            await rememberThread(params, thread);
        }
        if (params.isInterrupted()) {
            state = markStreamInterrupted(state);
        }
    } catch (err) {
        if (params.isInterrupted()) {
            state = markStreamInterrupted(state);
            addLog('info', `任务已被打断: ${params.id}`);
        } else {
            const message = err instanceof Error ? err.message : String(err);
            if (isRetryableThreadError(message, params.retried)) {
                console.warn(`[会话 ${params.sessionKey}] 线程/app-server 失效，清理状态并重试: ${message}`);
                clearRuntimeSessionIdentity(params.sessionKey);
                delegatedRetry = true;
                await runCodexStreamToFeishu(buildRuntimeRetryParams(params, targetMessageId));
                return;
            }
            state = updateStreamState(state, { type: 'error', message });
            console.error(`${runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey))} 流式处理出错:`, err);
            addLog('error', `${runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey))} 流式处理出错: ${message}`);
        }
    } finally {
        if (shouldFlushFinalStreamState(state, lastState, delegatedRetry)) {
            await updateInteractiveOrText(params.sourceMessageId, targetMessageId, state, runtimeCardOptions(params));
        }
    }

    console.log(`[${runtimeDisplayName(codexRuntime.kind, getSessionModel(params.sessionKey))} 回复] ${state.responseText.substring(0, 50)}...`);
}

function runtimeDisplayName(kind: CodexRuntimeKind, sessionModel?: string) {
    return runtimeDisplayNameForKind(kind, process.env, sessionModel);
}

function runtimeCardOptions(params: {
    id: string;
    sessionKey: string;
    senderOpenId: string;
    sourceMessageId: string;
}): RuntimeCardOptions {
    return {
        includeApprovalButtons: FEISHU_APPROVAL_BUTTONS_ENABLED,
        includeRuntimeButtons: true,
        sessionKey: params.sessionKey,
        taskId: params.id,
        requesterOpenId: params.senderOpenId,
        sourceMessageId: params.sourceMessageId,
    };
}

async function getOrCreateThread(sessionKey: string, policy: { sandboxMode: string; approvalPolicy: string }, userText: string): Promise<CodexThreadHandle> {
    const cached = threadMap.get(sessionKey);
    const model = getSessionModel(sessionKey);
    const reasoningEffort = getSessionReasoningEffort(sessionKey);
    const directories = resolveTaskDirectories(userText);
    if (
        cached &&
        cached.runtimeKind === codexRuntime.kind &&
        cached.sandboxMode === policy.sandboxMode &&
        cached.approvalPolicy === policy.approvalPolicy &&
        cached.workingDirectory === directories.workingDirectory &&
        cached.desktopListDirectory === directories.desktopListDirectory &&
        cached.model === model &&
        cached.reasoningEffort === reasoningEffort
    ) {
        return cached.thread;
    }

    const existingThreadId = getRuntimeSessionId(sessionMap[sessionKey], codexRuntime.kind);
    const runtimePolicy = buildRuntimePolicy({
        workingDirectory: directories.workingDirectory,
        desktopListDirectory: directories.desktopListDirectory,
        sandboxMode: policy.sandboxMode,
        approvalPolicy: policy.approvalPolicy,
        model,
        reasoningEffort,
    });

    let thread: CodexThreadHandle;
    if (existingThreadId) {
        try {
            console.log(`[会话 ${sessionKey}] 恢复历史线程: ${existingThreadId}`);
            thread = await codexRuntime.resumeThread(existingThreadId, runtimePolicy);
        } catch (e) {
            console.warn(`[会话 ${sessionKey}] 恢复失败，将创建新线程: ${e}`);
            thread = await codexRuntime.startThread(runtimePolicy);
        }
    } else {
        console.log(`[会话 ${sessionKey}] 创建全新线程`);
        thread = await codexRuntime.startThread(runtimePolicy);
    }

    threadMap.set(sessionKey, {
        thread,
        runtimeKind: codexRuntime.kind,
        sandboxMode: policy.sandboxMode,
        approvalPolicy: policy.approvalPolicy,
        workingDirectory: directories.workingDirectory,
        desktopListDirectory: directories.desktopListDirectory,
        model,
        reasoningEffort,
    });
    return thread;
}

async function rememberThread(params: {
    chatId: string;
    senderOpenId: string;
    sessionKey: string;
    sourceMessageId: string;
    userText: string;
}, thread: CodexThreadHandle) {
    if (!thread.id) return;
    const previous = sessionMap[params.sessionKey];
    if (getRuntimeSessionId(previous, codexRuntime.kind) === thread.id && previous?.last_message_id === params.sourceMessageId) return;

    sessionMap[params.sessionKey] = buildSessionRecord({
        sessionKey: params.sessionKey,
        chatId: params.chatId,
        senderOpenId: params.senderOpenId,
        threadId: thread.id,
        runtimeKind: codexRuntime.kind,
        model: getSessionModel(params.sessionKey),
        reasoningEffort: getSessionReasoningEffort(params.sessionKey),
        previous,
        messageId: params.sourceMessageId,
        userText: params.userText,
    });
    saveSessions();
    addLog('info', `会话绑定: ${params.sessionKey}`);
    updateStats({ sessions: Object.keys(sessionMap).length });
}

function getRuntimeSessionId(record: SessionRecord | undefined, kind: CodexRuntimeKind) {
    if (!record) return undefined;
    return record[runtimeSessionIdField(kind)];
}

function clearRuntimeSessionIdentity(sessionKey: string) {
    const previous = sessionMap[sessionKey];
    if (!previous) return;
    sessionMap[sessionKey] = clearRuntimeSessionId(previous, codexRuntime.kind);
    threadMap.delete(sessionKey);
    saveSessions();
}

function getWorkingDirectory() {
    return path.resolve(expandPathVariables(process.env.CODEX_WORKING_DIRECTORY || process.env.HOME || DEFAULT_WORKDIR));
}

function resolveTaskDirectories(userText: string) {
    const defaultWorkingDirectory = getWorkingDirectory();
    const selection = resolveWorkingDirectorySelection(userText, { defaultDirectory: defaultWorkingDirectory });
    const desktopListDirectory = selection.explicit
        ? selection.directory
        : path.resolve(expandPathVariables(process.env.CODEX_DESKTOP_LIST_DIRECTORY || defaultWorkingDirectory));
    return {
        workingDirectory: selection.directory,
        desktopListDirectory,
    };
}

function expandOptionalPath(value: string | undefined) {
    const trimmed = value?.trim();
    return trimmed ? expandPathVariables(trimmed) : undefined;
}

function getDefaultModel() {
    return process.env.CODEX_MODEL?.trim() || undefined;
}

function getDefaultReasoningEffort() {
    return process.env.CODEX_REASONING_EFFORT?.trim() || 'medium';
}

function runtimeDefaultModelName() {
    return codexRuntime.kind === 'claude-code' ? 'Claude Code 默认模型' : 'Codex CLI 默认模型';
}

function runtimeDefaultReasoningName() {
    return codexRuntime.kind === 'claude-code' ? 'runtime 默认值' : 'Codex CLI 默认值';
}

function getSessionModel(sessionKey: string) {
    return sessionMap[sessionKey]?.model || getDefaultModel();
}

function getSessionReasoningEffort(sessionKey: string) {
    return sessionMap[sessionKey]?.reasoning_effort || getDefaultReasoningEffort();
}

function setSessionModelConfig(sessionKey: string, model: string | null, reasoningEffort: string | null) {
    const previous = sessionMap[sessionKey];
    sessionMap[sessionKey] = {
        session_key: sessionKey,
        chat_id: previous?.chat_id || sessionKey.split(':')[0] || sessionKey,
        sender_open_id: previous?.sender_open_id || sessionKey.split(':')[1] || 'unknown',
        codex_thread_id: previous?.codex_thread_id,
        claude_session_id: previous?.claude_session_id,
        model: model || previous?.model,
        reasoning_effort: reasoningEffort || previous?.reasoning_effort,
        first_message_id: previous?.first_message_id,
        last_message_id: previous?.last_message_id,
        title: previous?.title,
        updated_at: new Date().toISOString(),
    };
    threadMap.delete(sessionKey);
    saveSessions();
    updateStats({ sessions: Object.keys(sessionMap).length });
}

function resetSessionThread(sessionKey: string) {
    const previous = sessionMap[sessionKey];
    threadMap.delete(sessionKey);
    if (!previous?.model && !previous?.reasoning_effort) {
        delete sessionMap[sessionKey];
        saveSessions();
        return;
    }
    sessionMap[sessionKey] = {
        session_key: sessionKey,
        chat_id: previous.chat_id,
        sender_open_id: previous.sender_open_id,
        model: previous.model,
        reasoning_effort: previous.reasoning_effort,
        updated_at: new Date().toISOString(),
    };
    saveSessions();
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

async function replyInteractive(
    messageId: string,
    state: ReturnType<typeof createStreamState>,
    options: RuntimeCardOptions = { includeApprovalButtons: FEISHU_APPROVAL_BUTTONS_ENABLED },
): Promise<string | null> {
    return replyInteractiveCard(messageId, buildAgentCard(state, options), formatStreamState(state));
}

async function replyInteractiveCard(messageId: string, card: any, fallbackText: string): Promise<string | null> {
    try {
        const result = await client.im.message.reply({
            path: { message_id: messageId },
            data: {
                content: JSON.stringify(card),
                msg_type: 'interactive',
            },
        });
        return result.data?.message_id || null;
    } catch (e) {
        console.error('发送飞书卡片失败:', e);
        return replyText(messageId, fallbackText);
    }
}

async function patchInteractive(
    messageId: string,
    state: ReturnType<typeof createStreamState>,
    options: RuntimeCardOptions = { includeApprovalButtons: FEISHU_APPROVAL_BUTTONS_ENABLED },
) {
    await client.im.message.patch({
        path: { message_id: messageId },
        data: {
            content: JSON.stringify(buildAgentCard(state, options)),
        },
    });
}

async function updateInteractiveOrText(
    sourceMessageId: string,
    targetMessageId: string | null,
    state: ReturnType<typeof createStreamState>,
    options: RuntimeCardOptions = { includeApprovalButtons: FEISHU_APPROVAL_BUTTONS_ENABLED },
) {
    if (!targetMessageId) {
        await replyInteractive(sourceMessageId, state, options);
        return;
    }
    try {
        await patchInteractive(targetMessageId, state, options);
    } catch (e) {
        console.error('更新飞书卡片失败:', e);
        await replyText(sourceMessageId, formatStreamState(state));
    }
}
