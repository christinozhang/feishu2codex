export type CodexResourceLimits = {
    maxActiveTasks: number;
    taskTimeoutMs: number;
    processNice: number;
    cpuTimeSeconds: number;
    goMaxProcs: number;
    goFlags: string;
    goMemoryLimit: string;
    appServerIdleShutdownMs: number;
    interruptKillGraceMs: number;
    processGroupKill: boolean;
};

export function loadCodexResourceLimits(
    env: Record<string, string | undefined> = process.env,
    platform = process.platform,
): CodexResourceLimits {
    return {
        maxActiveTasks: positiveInt(env.CODEX_MAX_ACTIVE_TASKS, 1),
        taskTimeoutMs: positiveInt(env.CODEX_TASK_TIMEOUT_MS, 20 * 60 * 1000),
        processNice: clampInt(positiveInt(env.CODEX_PROCESS_NICE, platform === 'win32' ? 0 : 10), 0, 20),
        cpuTimeSeconds: positiveInt(env.CODEX_CPU_TIME_SECONDS, 0),
        goMaxProcs: positiveInt(env.CODEX_CHILD_GOMAXPROCS, 2),
        goFlags: textValue(env.CODEX_CHILD_GOFLAGS, '-p=1'),
        goMemoryLimit: textValue(env.CODEX_CHILD_GOMEMLIMIT, ''),
        appServerIdleShutdownMs: positiveInt(env.CODEX_APP_SERVER_IDLE_SHUTDOWN_MS, 60 * 1000),
        interruptKillGraceMs: positiveInt(env.CODEX_INTERRUPT_KILL_GRACE_MS, 5000),
        processGroupKill: env.CODEX_PROCESS_GROUP_KILL?.toLowerCase() !== 'false',
    };
}

export function applyCodexResourceEnv(
    env: Record<string, string | undefined>,
    limits: CodexResourceLimits,
): Record<string, string | undefined> {
    return {
        ...env,
        ...(limits.goMaxProcs > 0 ? { GOMAXPROCS: String(limits.goMaxProcs) } : {}),
        ...(limits.goFlags ? { GOFLAGS: limits.goFlags } : {}),
        ...(limits.goMemoryLimit ? { GOMEMLIMIT: limits.goMemoryLimit } : {}),
    };
}

function positiveInt(value: string | undefined, fallback: number) {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
}

function clampInt(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function textValue(value: string | undefined, fallback: string) {
    const text = value?.trim();
    return text === undefined || text === '' ? fallback : text;
}
