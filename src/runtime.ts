import { Codex } from '@openai/codex-sdk';
import { CodexAppServerRuntime } from './appServerRuntime.js';
import { ClaudeCodeRuntime } from './claudeCodeRuntime.js';
import { applyCodexResourceEnv, loadCodexResourceLimits, type CodexResourceLimits } from './resourceLimits.js';

export { applyCodexResourceEnv, loadCodexResourceLimits };
export type { CodexResourceLimits };

export type CodexRuntimeKind = 'exec-sdk' | 'app-server' | 'claude-code';

export type RuntimePolicy = {
    sandboxMode: string;
    approvalPolicy: string;
    model?: string;
    reasoningEffort?: string;
    workingDirectory: string;
    desktopListDirectory: string;
    skipGitRepoCheck: boolean;
    webSearchEnabled: boolean;
};

export type CodexThreadHandle = {
    id?: string;
    runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<any> }>;
};

export type CodexThreadSummary = {
    id: string;
    title: string;
    preview: string;
    cwd: string;
    source: string;
    status: string;
    updatedAt: number;
};

export type CodexRuntime = {
    kind: CodexRuntimeKind;
    startThread(policy: RuntimePolicy): Promise<CodexThreadHandle> | CodexThreadHandle;
    resumeThread(threadId: string, policy: RuntimePolicy): Promise<CodexThreadHandle> | CodexThreadHandle;
    listThreads?(params: { searchTerm?: string; limit?: number }): Promise<CodexThreadSummary[]>;
};

export function selectCodexRuntimeKind(env: Record<string, string | undefined> = process.env): CodexRuntimeKind {
    const runtime = env.CODEX_RUNTIME?.trim().toLowerCase();
    if (runtime === 'app-server') return 'app-server';
    if (runtime === 'claude-code') return 'claude-code';
    return 'exec-sdk';
}

export function buildRuntimePolicy(params: {
    env?: Record<string, string | undefined>;
    workingDirectory: string;
    desktopListDirectory?: string;
    sandboxMode: string;
    approvalPolicy: string;
    model?: string;
    reasoningEffort?: string;
}): RuntimePolicy {
    const env = params.env || process.env;
    return {
        sandboxMode: params.sandboxMode,
        approvalPolicy: params.approvalPolicy,
        model: params.model || env.CODEX_MODEL?.trim() || undefined,
        reasoningEffort: params.reasoningEffort || env.CODEX_REASONING_EFFORT?.trim() || 'medium',
        workingDirectory: params.workingDirectory,
        desktopListDirectory: params.desktopListDirectory || env.CODEX_DESKTOP_LIST_DIRECTORY?.trim() || params.workingDirectory,
        skipGitRepoCheck: env.CODEX_SKIP_GIT_CHECK?.toLowerCase() !== 'false',
        webSearchEnabled: env.CODEX_WEB_SEARCH_ENABLED?.toLowerCase() !== 'false',
    };
}

export function createCodexRuntime(params: {
    kind: CodexRuntimeKind;
    env: Record<string, string | undefined>;
    codexPathOverride?: string;
    resourceLimits?: CodexResourceLimits;
}): CodexRuntime {
    if (params.kind === 'app-server') {
        return new CodexAppServerRuntime({
            codexBin: params.codexPathOverride,
            env: params.env,
            resourceLimits: params.resourceLimits || loadCodexResourceLimits(params.env),
        });
    }
    if (params.kind === 'claude-code') {
        return new ClaudeCodeRuntime({
            claudeBin: params.env.CLAUDE_CODE_BIN?.trim(),
            env: params.env,
        });
    }
    return new CodexSdkRuntime(params);
}

class CodexSdkRuntime implements CodexRuntime {
    readonly kind = 'exec-sdk' as const;
    private readonly codex: Codex;

    constructor(params: { env: Record<string, string | undefined>; codexPathOverride?: string }) {
        this.codex = new Codex({
            env: params.env,
            codexPathOverride: params.codexPathOverride,
        });
    }

    startThread(policy: RuntimePolicy) {
        return this.codex.startThread(this.toSdkThreadOptions(policy));
    }

    resumeThread(threadId: string, policy: RuntimePolicy) {
        return this.codex.resumeThread(threadId, this.toSdkThreadOptions(policy));
    }

    private toSdkThreadOptions(policy: RuntimePolicy) {
        return {
            model: policy.model,
            skipGitRepoCheck: policy.skipGitRepoCheck,
            sandboxMode: policy.sandboxMode as any,
            approvalPolicy: policy.approvalPolicy as any,
            modelReasoningEffort: policy.reasoningEffort as any,
            webSearchEnabled: policy.webSearchEnabled,
            workingDirectory: policy.workingDirectory,
        };
    }
}
