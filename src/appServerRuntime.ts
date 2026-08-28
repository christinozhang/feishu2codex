import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import readline from 'readline';
import type { CodexRuntime, CodexThreadHandle, CodexThreadSummary, RuntimePolicy } from './runtime.js';
import { loadCodexResourceLimits, type CodexResourceLimits } from './resourceLimits.js';

type JsonRpcIo = {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    stderr?: NodeJS.ReadableStream;
};

type PendingRequest = {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    abort?: () => void;
    cleanup?: () => void;
};

type SpawnFn = typeof spawn;

type MapperState = {
    assistantTexts: Map<string, string>;
    commandItems: Map<string, any>;
};

export class AppServerJsonRpcClient {
    private readonly io: JsonRpcIo;
    private readonly emitter = new EventEmitter();
    private readonly pending = new Map<number, PendingRequest>();
    private requestId = 1;
    private closed = false;

    constructor(io: JsonRpcIo) {
        this.io = io;
        const lines = readline.createInterface({ input: io.stdout });
        lines.on('line', (line) => this.handleLine(line));
        lines.on('close', () => this.close());
    }

    request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
        if (this.closed) {
            return Promise.reject(new Error('app-server JSON-RPC client is closed'));
        }
        const id = this.requestId++;
        const payload = params === undefined ? { id, method } : { id, method, params };
        return new Promise((resolve, reject) => {
            const pending: PendingRequest = { resolve, reject };
            if (signal) {
                if (signal.aborted) {
                    reject(new Error('request aborted'));
                    return;
                }
                pending.abort = () => {
                    this.pending.delete(id);
                    pending.cleanup?.();
                    reject(new Error('request aborted'));
                };
                pending.cleanup = () => signal.removeEventListener('abort', pending.abort as () => void);
                signal.addEventListener('abort', pending.abort, { once: true });
            }
            this.pending.set(id, pending);
            this.io.stdin.write(`${JSON.stringify(payload)}\n`);
        });
    }

    sendNotification(method: string, params?: unknown) {
        const payload = params === undefined ? { method } : { method, params };
        this.io.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    onNotification(handler: (notification: any) => void) {
        this.emitter.on('notification', handler);
        return () => this.emitter.off('notification', handler);
    }

    onClose(handler: () => void) {
        this.emitter.on('close', handler);
        return () => this.emitter.off('close', handler);
    }

    isClosed() {
        return this.closed;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        for (const [id, pending] of this.pending.entries()) {
            this.pending.delete(id);
            pending.cleanup?.();
            pending.reject(new Error('app-server JSON-RPC client closed'));
        }
        this.emitter.emit('close');
    }

    private handleLine(line: string) {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message: any;
        try {
            message = JSON.parse(trimmed);
        } catch {
            return;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (!pending) return;
            pending.cleanup?.();
            if (message.error) {
                pending.reject(new Error(formatRpcError(message.error)));
            } else {
                pending.resolve(message.result);
            }
            return;
        }
        if (message.method) {
            this.emitter.emit('notification', message);
        }
    }
}

export class CodexAppServerRuntime implements CodexRuntime {
    readonly kind = 'app-server' as const;
    private readonly codexBin: string;
    private readonly env: Record<string, string | undefined>;
    private readonly resourceLimits: CodexResourceLimits;
    private readonly spawnFn: SpawnFn;
    private child: ChildProcessWithoutNullStreams | null = null;
    private client: AppServerJsonRpcClient | null = null;
    private initializePromise: Promise<AppServerJsonRpcClient> | null = null;
    private idleShutdownTimer: NodeJS.Timeout | null = null;
    private activeTurns = 0;

    constructor(params: {
        codexBin?: string;
        env: Record<string, string | undefined>;
        client?: AppServerJsonRpcClient;
        resourceLimits?: CodexResourceLimits;
        spawnFn?: SpawnFn;
    }) {
        this.codexBin = params.codexBin || 'codex';
        this.env = params.env;
        this.resourceLimits = params.resourceLimits || loadCodexResourceLimits(params.env);
        this.spawnFn = params.spawnFn || spawn;
        if (params.client) {
            this.client = params.client;
            this.initializePromise = Promise.resolve(params.client);
        }
    }

    async startThread(policy: RuntimePolicy): Promise<CodexThreadHandle> {
        const client = await this.ensureClient();
        const result = await client.request('thread/start', {
            ...threadConfig(policy),
            serviceName: 'feishu2codex',
            threadSource: 'user',
            experimentalRawEvents: false,
            persistExtendedHistory: false,
        });
        return new AppServerThread(this, result.thread.id, policy);
    }

    async resumeThread(threadId: string, policy: RuntimePolicy): Promise<CodexThreadHandle> {
        const client = await this.ensureClient();
        await client.request('thread/resume', {
            threadId,
            ...threadConfig(policy),
            excludeTurns: true,
            persistExtendedHistory: false,
        });
        return new AppServerThread(this, threadId, policy);
    }

    async listThreads(params: { searchTerm?: string; limit?: number } = {}): Promise<CodexThreadSummary[]> {
        const client = await this.ensureClient();
        const result = await client.request('thread/list', {
            limit: params.limit || 10,
            archived: false,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            sourceKinds: ['vscode'],
            searchTerm: params.searchTerm?.trim() || undefined,
        });
        return (result?.data || []).map(threadSummaryFromAppServer);
    }

    async *runTurnStream(threadId: string, input: string, policy: RuntimePolicy, signal?: AbortSignal): AsyncIterable<any> {
        const client = await this.ensureClient();
        const mapper = createAppServerEventMapper();
        const queue = createAsyncQueue<any>();
        let turnId: string | null = null;
        let removed = false;
        let finished = false;
        this.activeTurns += 1;

        const removeListener = client.onNotification((notification) => {
            const params = notification.params || {};
            if (params.threadId && params.threadId !== threadId) return;
            if (turnId && params.turnId && params.turnId !== turnId) return;
            if (!turnId && notification.method === 'turn/started') {
                turnId = params.turn?.id || null;
            }
            const event = mapper(notification);
            if (!event) return;
            queue.push(event);
            if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') {
                finished = true;
                queue.end();
            }
        });
        const removeCloseListener = client.onClose(() => {
            if (finished) return;
            finished = true;
            queue.fail(new Error('app-server JSON-RPC client closed'));
        });

        const abort = () => {
            if (turnId) client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
            finished = true;
            this.scheduleAppServerStop();
            queue.end();
        };
        signal?.addEventListener('abort', abort, { once: true });

        try {
            const result = await client.request('turn/start', {
                threadId,
                input: [{ type: 'text', text: input, text_elements: [] }],
                cwd: policy.workingDirectory,
                approvalPolicy: policy.approvalPolicy,
                sandboxPolicy: sandboxPolicy(policy.sandboxMode),
                model: policy.model || null,
                effort: policy.reasoningEffort || null,
            }, signal);
            turnId = result.turn?.id || turnId;
            for await (const event of queue) {
                yield event;
            }
        } finally {
            if (!removed) {
                removed = true;
                removeListener();
                removeCloseListener();
            }
            signal?.removeEventListener('abort', abort);
            this.activeTurns = Math.max(0, this.activeTurns - 1);
            this.scheduleIdleShutdown();
        }
    }

    private async ensureClient() {
        this.clearIdleShutdown();
        if (this.initializePromise && this.client && !this.client.isClosed()) return this.initializePromise;
        if (this.client?.isClosed()) {
            this.client = null;
            this.initializePromise = null;
        }
        this.initializePromise = this.startAppServer();
        return this.initializePromise;
    }

    private async startAppServer() {
        const spawnConfig = buildCodexAppServerSpawn(this.codexBin, this.resourceLimits);
        const child = this.spawnFn(spawnConfig.command, spawnConfig.args, {
            env: this.env as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: spawnConfig.detached,
        });
        this.child = child;
        const client = new AppServerJsonRpcClient({
            stdin: child.stdin,
            stdout: child.stdout,
            stderr: child.stderr,
        });
        this.client = client;
        let initPromise: Promise<AppServerJsonRpcClient> | null = null;
        const clearCachedClient = () => {
            if (this.client === client) this.client = null;
            if (this.initializePromise === initPromise) this.initializePromise = null;
        };
        const removeCloseListener = client.onClose(() => {
            clearCachedClient();
            terminateChildProcess(child, this.resourceLimits);
        });
        const cleanup = () => {
            removeCloseListener();
            client.close();
            clearCachedClient();
            if (this.child === child) this.child = null;
        };
        child.on('exit', cleanup);
        child.stderr.on('data', (chunk) => {
            const text = String(chunk).trim();
            if (text) console.warn(`[app-server] ${text}`);
        });
        initPromise = (async () => {
            await client.request('initialize', {
                clientInfo: {
                    name: 'feishu2codex',
                    title: 'Feishu Codex Bot',
                    version: '1.0.0',
                },
                capabilities: {
                    experimentalApi: true,
                },
            });
            client.sendNotification('initialized');
            return client;
        })();
        this.initializePromise = initPromise;
        return initPromise;
    }

    private scheduleAppServerStop() {
        const child = this.child;
        if (!child?.pid) return;
        setTimeout(() => {
            if (!shouldTerminateAppServerChild(this.child, child, this.activeTurns)) return;
            terminateChildProcess(child, this.resourceLimits);
        }, this.resourceLimits.interruptKillGraceMs);
    }

    private scheduleIdleShutdown() {
        if (this.resourceLimits.appServerIdleShutdownMs <= 0 || this.activeTurns > 0) return;
        this.clearIdleShutdown();
        const child = this.child;
        if (!child?.pid) return;
        this.idleShutdownTimer = setTimeout(() => {
            if (!shouldTerminateAppServerChild(this.child, child, this.activeTurns)) return;
            terminateChildProcess(child, this.resourceLimits);
        }, this.resourceLimits.appServerIdleShutdownMs);
    }

    private clearIdleShutdown() {
        if (!this.idleShutdownTimer) return;
        clearTimeout(this.idleShutdownTimer);
        this.idleShutdownTimer = null;
    }
}

export type AppServerSpawnConfig = {
    command: string;
    args: string[];
    detached: boolean;
};

type AppServerChildState = Pick<ChildProcessWithoutNullStreams, 'pid' | 'exitCode'> | null;

export function shouldTerminateAppServerChild(
    currentChild: AppServerChildState,
    expectedChild: AppServerChildState,
    activeTurns: number,
) {
    return Boolean(
        expectedChild?.pid &&
        expectedChild.exitCode === null &&
        currentChild === expectedChild &&
        activeTurns === 0,
    );
}

export function buildCodexAppServerSpawn(
    codexBin: string,
    limits: CodexResourceLimits,
    platform = process.platform,
): AppServerSpawnConfig {
    const appServerArgs = ['app-server', '--listen', 'stdio://'];
    if (platform === 'win32' || (limits.processNice === 0 && limits.cpuTimeSeconds === 0)) {
        return {
            command: codexBin,
            args: appServerArgs,
            detached: platform !== 'win32' && limits.processGroupKill,
        };
    }

    const script = [
        limits.cpuTimeSeconds > 0 ? `ulimit -t ${limits.cpuTimeSeconds}` : '',
        limits.processNice > 0 ? `exec nice -n ${limits.processNice} "$0" "$@"` : 'exec "$0" "$@"',
    ].filter(Boolean).join('\n');

    return {
        command: '/bin/bash',
        args: ['-lc', script, codexBin, ...appServerArgs],
        detached: limits.processGroupKill,
    };
}

function terminateChildProcess(child: ChildProcessWithoutNullStreams, limits: CodexResourceLimits) {
    if (!child.pid || child.exitCode !== null) return;
    const targetPid = process.platform !== 'win32' && limits.processGroupKill ? -child.pid : child.pid;
    try {
        process.kill(targetPid, 'SIGTERM');
    } catch {
        return;
    }
    setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
            process.kill(targetPid, 'SIGKILL');
        } catch {
            // Process already exited.
        }
    }, Math.max(1000, limits.interruptKillGraceMs));
}

function threadSummaryFromAppServer(thread: any): CodexThreadSummary {
    return {
        id: String(thread.id || ''),
        title: safeSummaryText(thread.name || thread.preview || thread.id || '未命名对话', 80),
        preview: safeSummaryText(thread.preview || '', 160),
        cwd: safeSummaryText(String(thread.cwd || ''), 220),
        source: formatThreadSource(thread.source),
        status: thread.status?.type || 'unknown',
        updatedAt: Number(thread.updatedAt || 0),
    };
}

function formatThreadSource(source: unknown) {
    if (!source) return 'unknown';
    if (typeof source === 'string') return source;
    if (typeof source === 'object' && source && 'custom' in source) return String((source as any).custom || 'custom');
    if (typeof source === 'object' && source && 'subAgent' in source) return 'subAgent';
    return 'unknown';
}

function safeSummaryText(value: unknown, limit: number) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

class AppServerThread implements CodexThreadHandle {
    constructor(
        private readonly runtime: CodexAppServerRuntime,
        readonly id: string,
        private readonly policy: RuntimePolicy,
    ) {}

    async runStreamed(input: string, options: { signal?: AbortSignal } = {}) {
        return {
            events: this.runtime.runTurnStream(this.id, input, this.policy, options.signal),
        };
    }
}

export function createAppServerEventMapper() {
    const state: MapperState = {
        assistantTexts: new Map(),
        commandItems: new Map(),
    };
    return (notification: any) => mapAppServerNotification(notification, state);
}

const defaultMapperState: MapperState = {
    assistantTexts: new Map(),
    commandItems: new Map(),
};

export function mapAppServerNotification(notification: any, state: MapperState = defaultMapperState): any | null {
    const method = notification.method;
    const params = notification.params || {};

    if (method === 'item/agentMessage/delta') {
        const id = params.itemId;
        const text = `${state.assistantTexts.get(id) || ''}${params.delta || ''}`;
        state.assistantTexts.set(id, text);
        return {
            type: 'item.updated',
            item: { type: 'agent_message', id, text },
        };
    }

    if (method === 'item/commandExecution/outputDelta') {
        const item = state.commandItems.get(params.itemId) || {
            type: 'command_execution',
            id: params.itemId,
            command: '',
            status: 'running',
            aggregated_output: '',
        };
        const nextItem = {
            ...item,
            aggregated_output: `${item.aggregated_output || ''}${params.delta || ''}`,
        };
        state.commandItems.set(params.itemId, nextItem);
        return { type: 'item.updated', item: nextItem };
    }

    if (method === 'item/started' || method === 'item/completed') {
        const item = mapThreadItem(params.item, state);
        if (!item) return null;
        return {
            type: method === 'item/started' ? 'item.started' : 'item.completed',
            item,
        };
    }

    if (method === 'turn/completed') {
        const turn = params.turn || {};
        if (turn.status === 'failed' || turn.error) {
            return { type: 'turn.failed', error: turn.error || { message: 'Codex turn failed' } };
        }
        return { type: 'turn.completed' };
    }

    if (method === 'error') {
        return { type: 'error', message: params.error?.message || 'Codex app-server error' };
    }

    return null;
}

function mapThreadItem(item: any, state: MapperState): any | null {
    if (!item) return null;
    if (item.type === 'agentMessage') {
        const text = item.text || state.assistantTexts.get(item.id) || '';
        state.assistantTexts.set(item.id, text);
        return { type: 'agent_message', id: item.id, text };
    }
    if (item.type === 'commandExecution') {
        const mapped = {
            type: 'command_execution',
            id: item.id,
            command: item.command || '',
            status: normalizeItemStatus(item.status),
            aggregated_output: item.aggregatedOutput || state.commandItems.get(item.id)?.aggregated_output || '',
            exit_code: item.exitCode,
        };
        state.commandItems.set(item.id, mapped);
        return mapped;
    }
    if (item.type === 'mcpToolCall') {
        return {
            type: 'mcp_tool_call',
            id: item.id,
            server: item.server,
            tool: item.tool,
            status: normalizeItemStatus(item.status),
            arguments: item.arguments,
            result: item.result,
            error: item.error,
        };
    }
    if (item.type === 'fileChange') {
        return {
            type: 'file_change',
            id: item.id,
            changes: item.changes || [],
            status: normalizeItemStatus(item.status),
        };
    }
    if (item.type === 'webSearch') {
        return {
            type: 'web_search',
            id: item.id,
            query: item.query,
            action: item.action,
            status: 'completed',
        };
    }
    if (item.type === 'reasoning') {
        return { type: 'reasoning', id: item.id, status: 'running' };
    }
    return null;
}

function normalizeItemStatus(status: string | undefined) {
    if (status === 'completed') return 'completed';
    if (status === 'failed' || status === 'declined' || status === 'cancelled') return 'failed';
    return 'running';
}

function threadConfig(policy: RuntimePolicy) {
    return {
        model: policy.model || null,
        cwd: policy.desktopListDirectory,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandboxMode,
        config: {
            model_reasoning_effort: policy.reasoningEffort,
            web_search: policy.webSearchEnabled ? 'live' : 'off',
        },
    };
}

function sandboxPolicy(mode: string) {
    if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: true };
    return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
    };
}

function createAsyncQueue<T>() {
    const items: T[] = [];
    const waiters: Array<{
        resolve: (value: IteratorResult<T>) => void;
        reject: (error: Error) => void;
    }> = [];
    let done = false;
    let failure: Error | null = null;

    return {
        push(item: T) {
            if (done) return;
            const waiter = waiters.shift();
            if (waiter) {
                waiter.resolve({ value: item, done: false });
                return;
            }
            items.push(item);
        },
        end() {
            if (done) return;
            done = true;
            while (waiters.length > 0) {
                waiters.shift()?.resolve({ value: undefined as T, done: true });
            }
        },
        fail(error: Error) {
            if (done) return;
            failure = error;
            done = true;
            while (waiters.length > 0) {
                waiters.shift()?.reject(error);
            }
        },
        async *[Symbol.asyncIterator]() {
            while (true) {
                if (items.length > 0) {
                    yield items.shift() as T;
                    continue;
                }
                if (failure) throw failure;
                if (done) return;
                const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
                    waiters.push({ resolve, reject });
                });
                if (next.done) return;
                yield next.value;
            }
        },
    };
}

function formatRpcError(error: any) {
    if (!error) return 'app-server request failed';
    if (typeof error === 'string') return error;
    return error.message || JSON.stringify(error);
}
