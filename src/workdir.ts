import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type WorkdirSelection = {
    directory: string;
    explicit: boolean;
};

export function resolveWorkingDirectoryForText(text: string, params: { defaultDirectory: string }): string {
    return resolveWorkingDirectorySelection(text, params).directory;
}

export function resolveWorkingDirectorySelection(text: string, params: { defaultDirectory: string }): WorkdirSelection {
    const defaultDirectory = path.resolve(expandHome(params.defaultDirectory));
    for (const candidate of extractPathCandidates(text)) {
        const resolved = existingDirectoryForPath(candidate);
        if (resolved) {
            return { directory: resolved, explicit: true };
        }
    }
    return { directory: defaultDirectory, explicit: false };
}

function extractPathCandidates(text: string): string[] {
    const matches = text.matchAll(/(?:^|[\s"'`(（])((?:~|\/)[^\s"'`，。；;、)）\]}】>]+)/g);
    return [...matches].map((match) => stripPathBoundary(match[1])).filter(Boolean);
}

function existingDirectoryForPath(candidate: string): string | null {
    const resolved = path.resolve(expandHome(candidate));
    try {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) return resolved;
        if (stat.isFile()) return path.dirname(resolved);
    } catch {
        return null;
    }
    return null;
}

function expandHome(value: string): string {
    if (value === '~') return os.homedir();
    if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
    return value;
}

function stripPathBoundary(value: string): string {
    return value.replace(/^[`'"]+/, '').replace(/[，。；;、:：,.`'"]+$/g, '');
}
