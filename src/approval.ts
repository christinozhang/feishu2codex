export type RunPolicy = {
    sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
};

const HIGH_RISK_PATTERNS = [
    /删除|移除|清空|覆盖|写入|修改|改一下|编辑|创建|新增|保存|提交|commit|push|merge|rebase/i,
    /重启|启动|停止|kill|部署|发布|上线|回滚|restart|deploy|rollout/i,
    /安装|升级|卸载|npm\s+install|pnpm\s+add|bun\s+add|pip\s+install|brew\s+install/i,
    /执行脚本|运行脚本|跑脚本|chmod|sudo|launchctl|crontab/i,
    /jenkins|jira|confluence|eks|k8s|kubernetes|mcp|kubectl|helm|terraform/i,
    /secret|token|password|cookie|凭证|密钥/i,
];

const READONLY_PATTERNS = [
    /^(hi|hello|你好|在吗)\??$/i,
    /解释|说明|为什么|是什么|什么时候|怎么配置|怎么看|列出|查看|看下|查询|读一下|总结|分析/i,
];

export function requiresFeishuApproval(userText: string): boolean {
    const text = userText.trim();
    if (!text) return false;
    if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text))) {
        return true;
    }
    if (READONLY_PATTERNS.some((pattern) => pattern.test(text))) {
        return false;
    }
    return false;
}

export function getRunPolicy(privileged: boolean, env: NodeJS.ProcessEnv = process.env): RunPolicy {
    if (privileged) {
        return {
            sandboxMode: (env.CODEX_PRIVILEGED_SANDBOX_MODE || 'danger-full-access') as RunPolicy['sandboxMode'],
            approvalPolicy: (env.CODEX_PRIVILEGED_APPROVAL_POLICY || 'never') as RunPolicy['approvalPolicy'],
        };
    }

    return {
        sandboxMode: (env.CODEX_DEFAULT_SANDBOX_MODE || env.CODEX_SANDBOX_MODE || 'workspace-write') as RunPolicy['sandboxMode'],
        approvalPolicy: (env.CODEX_DEFAULT_APPROVAL_POLICY || env.CODEX_APPROVAL_POLICY || 'never') as RunPolicy['approvalPolicy'],
    };
}

export function approvalSummaryText(env: NodeJS.ProcessEnv = process.env) {
    const normal = getRunPolicy(false, env);
    const privileged = getRunPolicy(true, env);
    return [
        '审批策略',
        '',
        `普通任务: ${normal.sandboxMode} + ${normal.approvalPolicy}`,
        `高风险任务: 飞书审批通过后使用 ${privileged.sandboxMode} + ${privileged.approvalPolicy}`,
        '',
        '需要审批的任务包含写文件、删除、重启、部署、安装、提交、推送、配置修改、外部系统和 MCP 操作。',
        '普通问答、解释和只读查看不需要审批。',
    ].join('\n');
}
