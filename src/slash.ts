import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { approvalSummaryText } from './approval.js';
import { redact } from './streaming.js';

export type SlashCommand = {
    name: string;
    args: string;
};

export function parseSlashCommand(userText: string): SlashCommand | null {
    const text = userText.trim();
    if (!text.startsWith('/')) return null;
    const [rawName, ...rest] = text.slice(1).split(/\s+/);
    return {
        name: (rawName || '').toLowerCase(),
        args: rest.join(' ').trim(),
    };
}

export function slashHelpText() {
    return [
        'Slash 命令',
        '',
        '/help 查看命令说明',
        '/skills [keyword] 列出本机 skills',
        '/skill <name> <task> 使用指定 skill 处理任务',
        '/mcp 查看 Codex CLI 可见 MCP',
        '/approval 查看审批策略',
        '/queue 查看当前会话队列',
        '/threads [keyword] 检索 Codex Desktop 对话并绑定到当前飞书会话',
        '/interrupt <task> 打断当前任务并执行新任务',
        '/cancel <task_id> 取消等待任务',
        '/clear-queue 清空当前会话等待队列',
        '/model [model_name] [reasoning_effort] 查看或切换当前会话模型',
        '/reset 开启新对话，不删除本机历史文件',
        '/status 查看机器人状态',
    ].join('\n');
}

export function parseModelSelection(args: string) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { model: null, reasoningEffort: null };

    let reasoningEffort: string | null = null;
    const last = parts[parts.length - 1].toLowerCase();
    if (isReasoningEffort(last)) {
        reasoningEffort = last;
        parts.pop();
    }

    const model = parts.length > 0 ? parts.join('-') : null;
    return { model, reasoningEffort };
}

export function formatModelStatus(
    currentModel: string | null | undefined,
    defaultModel: string | null | undefined,
    currentReasoningEffort: string | null | undefined,
    defaultReasoningEffort: string | null | undefined,
) {
    return [
        'Codex 模型',
        '',
        `当前模型: ${currentModel || defaultModel || 'Codex CLI 默认模型'}`,
        `默认模型: ${defaultModel || 'Codex CLI 默认模型'}`,
        `当前 Reasoning effort: ${currentReasoningEffort || defaultReasoningEffort || 'Codex CLI 默认值'}`,
        `默认 Reasoning effort: ${defaultReasoningEffort || 'Codex CLI 默认值'}`,
        '',
        '切换用法: /model <model_name> [minimal|low|medium|high|xhigh]',
    ].join('\n');
}

function isReasoningEffort(value: string) {
    return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value);
}

export function defaultSkillRoots() {
    return [
        path.join(os.homedir(), '.agents', 'skills'),
        path.join(os.homedir(), '.codex', 'skills'),
    ];
}

export function listSkills(filter = '', roots = defaultSkillRoots()) {
    const keyword = filter.trim().toLowerCase();
    const skills = new Map<string, string>();

    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root)) {
            const skillDir = path.join(root, name);
            const skillFile = path.join(skillDir, 'SKILL.md');
            try {
                if (!fs.statSync(skillDir).isDirectory()) continue;
                if (!fs.existsSync(skillFile)) continue;
                if (keyword && !name.toLowerCase().includes(keyword)) continue;
                if (!skills.has(name)) skills.set(name, skillDir);
            } catch {
                continue;
            }
        }
    }

    return [...skills.entries()].map(([name, dir]) => ({ name, dir })).sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkills(filter = '', roots = defaultSkillRoots()) {
    const skills = listSkills(filter, roots);
    if (skills.length === 0) {
        return filter ? `未找到匹配 skill: ${filter}` : '未找到本机 skill';
    }
    const visible = skills.slice(0, 40);
    const lines = [
        filter ? `Skills: ${filter}` : 'Skills',
        '',
        ...visible.map((skill) => `- ${skill.name}`),
    ];
    if (skills.length > visible.length) {
        lines.push('', `还有 ${skills.length - visible.length} 个，使用 /skills keyword 过滤。`);
    }
    return lines.join('\n');
}

export function rewriteSkillPrompt(args: string, roots = defaultSkillRoots()) {
    const [name, ...taskParts] = args.trim().split(/\s+/);
    const task = taskParts.join(' ').trim();
    if (!name || !task) {
        return { error: '用法: /skill <name> <task>' };
    }
    const exists = listSkills(name, roots).some((skill) => skill.name === name);
    if (!exists) {
        return { error: `skill 不存在: ${name}` };
    }
    return { text: `Use the ${name} skill. User task: ${task}`, skillName: name };
}

export function runMcpList(codexBin = process.env.CODEX_BIN || 'codex') {
    const result = spawnSync(codexBin, ['mcp', 'list'], { encoding: 'utf-8', timeout: 15000 });
    const output = [result.stdout || '', result.stderr || ''].join('\n').trim();
    if (result.error) {
        return `MCP 查询失败: ${result.error.message}`;
    }
    return redact(output || `codex mcp list exit_code=${result.status}`);
}

export { approvalSummaryText };
