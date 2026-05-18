export type QueuedTask = {
    id: string;
    chatId: string;
    senderOpenId: string;
    sessionKey: string;
    sourceMessageId: string;
    userText: string;
    createdAt: number;
    approvalId?: string;
    targetMessageId?: string | null;
};

export type SessionRunner = {
    sessionKey: string;
    current: QueuedTask | null;
    queue: QueuedTask[];
    abortController: AbortController | null;
    interrupted: boolean;
    draining: boolean;
};

export type QueueSnapshot = {
    current: QueuedTask | null;
    queue: QueuedTask[];
};

export function createSessionRunner(sessionKey: string): SessionRunner {
    return {
        sessionKey,
        current: null,
        queue: [],
        abortController: null,
        interrupted: false,
        draining: false,
    };
}

export function getOrCreateRunner(runners: Map<string, SessionRunner>, sessionKey: string): SessionRunner {
    const existing = runners.get(sessionKey);
    if (existing) return existing;
    const runner = createSessionRunner(sessionKey);
    runners.set(sessionKey, runner);
    return runner;
}

export function createQueuedTask(params: Omit<QueuedTask, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): QueuedTask {
    return {
        ...params,
        id: params.id || createTaskId(),
        createdAt: params.createdAt || Date.now(),
        targetMessageId: params.targetMessageId ?? null,
    };
}

export function enqueueTask(runner: SessionRunner, task: QueuedTask, mode: 'back' | 'front' = 'back'): number {
    if (mode === 'front') {
        runner.queue.unshift(task);
        return 1;
    }
    runner.queue.push(task);
    return runner.queue.length;
}

export function removeQueuedTask(runner: SessionRunner, taskId: string, requesterOpenId?: string): QueuedTask | null {
    const index = runner.queue.findIndex((task) => task.id === taskId && canOperateTask(task, requesterOpenId));
    if (index === -1) return null;
    const [removed] = runner.queue.splice(index, 1);
    return removed || null;
}

export function moveQueuedTaskToFront(runner: SessionRunner, taskId: string, requesterOpenId?: string): QueuedTask | null {
    const task = removeQueuedTask(runner, taskId, requesterOpenId);
    if (!task) return null;
    runner.queue.unshift(task);
    return task;
}

export function clearQueuedTasks(runner: SessionRunner, requesterOpenId?: string): number {
    const before = runner.queue.length;
    runner.queue = runner.queue.filter((task) => !canOperateTask(task, requesterOpenId));
    return before - runner.queue.length;
}

export function snapshotRunner(runner: SessionRunner): QueueSnapshot {
    return {
        current: runner.current,
        queue: [...runner.queue],
    };
}

export function canOperateTask(task: QueuedTask | null | undefined, requesterOpenId?: string) {
    if (!task) return false;
    if (!requesterOpenId || requesterOpenId === 'unknown') return true;
    return task.senderOpenId === 'unknown' || task.senderOpenId === requesterOpenId;
}

export function summarizeTask(task: Pick<QueuedTask, 'userText'> | null | undefined, limit = 80) {
    if (!task) return '无';
    const text = task.userText.replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    const marker = '...[truncated]';
    return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function createTaskId() {
    return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
