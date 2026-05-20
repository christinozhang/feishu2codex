import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';
import type { CodexRuntime, CodexThreadHandle, RuntimePolicy } from './runtime.js';
import { expandPathVariables } from './workdir.js';

type ClaudeMapperState = {
    sessionId?: string;
    assistantText: string;
    textBlockIndex?: number;
    toolBlocks: Map<number, {
        id: string;
        name: string;
        inputJson: string;
    }>;
};

type SpawnFn = typeof spawn;

export class ClaudeCodeRuntime implements CodexRuntime {
    readonly kind = 'claude-code' as const;
    private readonly claudeBin: string;
    private readonly env: Record<string, string | undefined>;
    private readonly spawnFn: SpawnFn;

    constructor(params: { env: Record<string, string | undefined>; claudeBin?: string; spawnFn?: SpawnFn }) {
        this.env = params.env;
        this.claudeBin = expandPathVariables(params.claudeBin || params.env.CLAUDE_CODE_BIN?.trim() || 'claude');
        this.spawnFn = params.spawnFn || spawn;
    }

    startThread(policy: RuntimePolicy): CodexThreadHandle {
        return new ClaudeCodeThread(this, policy);
    }

    resumeThread(sessionId: string, policy: RuntimePolicy): CodexThreadHandle {
        return new ClaudeCodeThread(this, policy, sessionId);
    }

    async *runTurnStream(
        thread: ClaudeCodeThread,
        input: string,
        policy: RuntimePolicy,
        signal?: AbortSignal,
    ): AsyncIterable<any> {
        const mapper = createClaudeCodeEventMapper(thread.id);
        const args = [
            '--print',
            '--verbose',
            '--output-format',
            'stream-json',
            '--include-partial-messages',
            '--permission-mode',
            claudePermissionMode(policy, this.env),
            ...claudeExtraArgs(this.env),
        ];
        if (thread.id) {
            args.push('--resume', thread.id);
        }
        const model = this.env.CLAUDE_CODE_MODEL?.trim() || policy.model;
        if (model) {
            args.push('--model', model);
        }

        const child = this.spawnFn(this.claudeBin, args, {
            cwd: policy.workingDirectory,
            env: this.env as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams;
        console.log([
            '[ClaudeCode] start',
            `bin=${this.claudeBin}`,
            `cwd=${policy.workingDirectory}`,
            `permission=${claudePermissionMode(policy, this.env)}`,
            `model=${model || 'default'}`,
            `resume=${thread.id ? 'true' : 'false'}`,
        ].join(' '));

        let stderrText = '';
        child.stderr.on('data', (chunk) => {
            stderrText = `${stderrText}${String(chunk)}`;
        });

        const abort = () => {
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL');
            }, 2000).unref();
        };
        signal?.addEventListener('abort', abort, { once: true });

        child.stdin.write(`${input}\n`);
        child.stdin.end();

        try {
            const lines = readline.createInterface({ input: child.stdout });
            let hasTerminalEvent = false;
            for await (const line of lines) {
                const message = parseJsonLine(line);
                if (!message) continue;
                if ((message.type === 'system' || message.type === 'result') && message.session_id) {
                    thread.id = String(message.session_id);
                }
                if (message.type === 'system' && message.subtype === 'init') {
                    console.log([
                        '[ClaudeCode] init',
                        `session=${message.session_id || 'unknown'}`,
                        `model=${message.model || 'unknown'}`,
                        `version=${message.claude_code_version || 'unknown'}`,
                    ].join(' '));
                }
                if (message.type === 'result') {
                    const usage = message.modelUsage ? ` modelUsage=${Object.keys(message.modelUsage).join(',')}` : '';
                    console.log([
                        '[ClaudeCode] result',
                        `session=${message.session_id || thread.id || 'unknown'}`,
                        `status=${message.is_error ? 'error' : 'success'}`,
                        `duration_ms=${message.duration_ms ?? 'unknown'}`,
                        usage.trim(),
                    ].filter(Boolean).join(' '));
                }
                const event = mapper(message);
                if (!event) continue;
                if (event.type === 'session.updated') {
                    thread.id = event.id;
                    continue;
                }
                if (event.type === 'turn.completed' || event.type === 'turn.failed') {
                    hasTerminalEvent = true;
                }
                yield event;
            }
            const exitCode = await waitForExit(child);
            if (exitCode !== 0 && !hasTerminalEvent) {
                yield {
                    type: 'turn.failed',
                    error: { message: stderrText.trim() || `Claude Code exited with code ${exitCode}` },
                };
            } else if (exitCode === 0 && !hasTerminalEvent) {
                yield { type: 'turn.completed' };
            }
        } finally {
            signal?.removeEventListener('abort', abort);
        }
    }
}

class ClaudeCodeThread implements CodexThreadHandle {
    constructor(
        private readonly runtime: ClaudeCodeRuntime,
        private readonly policy: RuntimePolicy,
        public id?: string,
    ) {}

    async runStreamed(input: string, options: { signal?: AbortSignal } = {}) {
        return {
            events: this.runtime.runTurnStream(this, input, this.policy, options.signal),
        };
    }
}

export function createClaudeCodeEventMapper(initialSessionId?: string) {
    const state: ClaudeMapperState = {
        sessionId: initialSessionId,
        assistantText: '',
        toolBlocks: new Map(),
    };
    return (message: any) => mapClaudeCodeMessage(message, state);
}

export function mapClaudeCodeMessage(message: any, state: ClaudeMapperState): any | null {
    if (!message || typeof message !== 'object') return null;

    if (message.type === 'system' && message.session_id) {
        state.sessionId = String(message.session_id);
        return { type: 'session.updated', id: state.sessionId };
    }

    if (message.type === 'stream_event') {
        return mapClaudeStreamEvent(message.event || {}, state);
    }

    if (message.type === 'result') {
        if (message.session_id) state.sessionId = String(message.session_id);
        if (message.is_error) {
            return {
                type: 'turn.failed',
                error: { message: resultText(message.result) || 'Claude Code turn failed' },
            };
        }
        return { type: 'turn.completed' };
    }

    return null;
}

function mapClaudeStreamEvent(event: any, state: ClaudeMapperState) {
    if (event.type === 'content_block_start') {
        const block = event.content_block || {};
        if (block.type === 'text') {
            state.textBlockIndex = event.index;
            return null;
        }
        if (block.type === 'tool_use') {
            const id = String(block.id || `claude-tool-${event.index}`);
            const name = String(block.name || 'tool');
            state.toolBlocks.set(event.index, {
                id,
                name,
                inputJson: hasObjectFields(block.input) ? JSON.stringify(block.input) : '',
            });
            return {
                type: 'item.started',
                item: toolItem(id, name, block.input || {}, 'running'),
            };
        }
        return null;
    }

    if (event.type === 'content_block_delta') {
        const delta = event.delta || {};
        if (delta.type === 'text_delta') {
            state.assistantText = `${state.assistantText}${delta.text || ''}`;
            return {
                type: 'item.updated',
                item: {
                    type: 'agent_message',
                    id: 'claude-message-1',
                    text: state.assistantText,
                },
            };
        }
        if (delta.type === 'input_json_delta') {
            const tool = state.toolBlocks.get(event.index);
            if (tool) {
                tool.inputJson = `${tool.inputJson}${delta.partial_json || ''}`;
            }
        }
        return null;
    }

    if (event.type === 'content_block_stop') {
        const tool = state.toolBlocks.get(event.index);
        if (!tool) return null;
        state.toolBlocks.delete(event.index);
        return {
            type: 'item.completed',
            item: toolItem(tool.id, tool.name, parseToolInput(tool.inputJson), 'completed'),
        };
    }

    return null;
}

function toolItem(id: string, name: string, input: any, status: 'running' | 'completed') {
    if (name.toLowerCase() === 'bash') {
        return {
            type: 'command_execution',
            id,
            command: input?.command || name,
            status,
            aggregated_output: '',
        };
    }
    return {
        type: 'mcp_tool_call',
        id,
        server: 'claude-code',
        tool: name,
        status,
        arguments: input || {},
    };
}

function hasObjectFields(value: unknown) {
    return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function parseToolInput(inputJson: string) {
    if (!inputJson) return {};
    try {
        return JSON.parse(inputJson);
    } catch {
        return {};
    }
}

function resultText(value: unknown) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value
        .filter((item) => item && typeof item === 'object' && (item as any).type === 'text')
        .map((item) => String((item as any).text || ''))
        .join('');
}

function parseJsonLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise<number>((resolve) => {
        child.on('exit', (code) => resolve(code ?? 0));
    });
}

function claudePermissionMode(policy: RuntimePolicy, env: Record<string, string | undefined>) {
    const configured = env.CLAUDE_CODE_PERMISSION_MODE?.trim();
    if (configured) return configured;
    if (policy.approvalPolicy === 'never' && policy.sandboxMode === 'danger-full-access') return 'bypassPermissions';
    if (policy.approvalPolicy === 'never') return 'acceptEdits';
    return 'default';
}

function claudeExtraArgs(env: Record<string, string | undefined>) {
    const raw = env.CLAUDE_CODE_EXTRA_ARGS?.trim();
    if (!raw) return [];
    return raw.split(/\s+/).filter(Boolean);
}
