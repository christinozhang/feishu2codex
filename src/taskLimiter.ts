type Waiter = {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
};

export function createTaskLimiter(maxActive: number) {
    const limit = Math.max(1, Math.floor(maxActive));
    const waiters: Waiter[] = [];
    let active = 0;

    const acquire = (signal?: AbortSignal): Promise<() => void> => {
        if (signal?.aborted) return Promise.reject(new Error('task slot wait aborted'));
        if (active < limit) {
            active += 1;
            return Promise.resolve(makeRelease());
        }
        return new Promise((resolve, reject) => {
            const waiter: Waiter = { resolve, reject, signal };
            waiter.abort = () => {
                const index = waiters.indexOf(waiter);
                if (index !== -1) waiters.splice(index, 1);
                reject(new Error('task slot wait aborted'));
            };
            signal?.addEventListener('abort', waiter.abort, { once: true });
            waiters.push(waiter);
        });
    };

    const releaseSlot = () => {
        if (active > 0) active -= 1;
        while (waiters.length > 0 && active < limit) {
            const waiter = waiters.shift();
            if (!waiter) continue;
            waiter.signal?.removeEventListener('abort', waiter.abort as () => void);
            if (waiter.signal?.aborted) {
                waiter.reject(new Error('task slot wait aborted'));
                continue;
            }
            active += 1;
            waiter.resolve(makeRelease());
            return;
        }
    };

    const makeRelease = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            releaseSlot();
        };
    };

    return {
        acquire,
        snapshot() {
            return { active, waiting: waiters.length, maxActive: limit };
        },
    };
}
