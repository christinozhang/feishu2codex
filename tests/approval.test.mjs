import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalSummaryText, getRunPolicy, requiresFeishuApproval } from '../dist/approval.js';

test('low risk messages do not require approval', () => {
  for (const text of ['hi', '解释一下这个配置', '看下本地最新 session 的三次内容']) {
    assert.equal(requiresFeishuApproval(text), false, text);
  }
});

test('high risk messages require approval', () => {
  for (const text of ['改一下配置', '重启 bot', '删除文件', '部署一下', '执行脚本', '看下 Jenkins', '查 EKS 集群']) {
    assert.equal(requiresFeishuApproval(text), true, text);
  }
});

test('run policy separates default and privileged modes', () => {
  const env = {
    CODEX_DEFAULT_SANDBOX_MODE: 'workspace-write',
    CODEX_DEFAULT_APPROVAL_POLICY: 'never',
    CODEX_PRIVILEGED_SANDBOX_MODE: 'danger-full-access',
    CODEX_PRIVILEGED_APPROVAL_POLICY: 'never',
  };
  assert.deepEqual(getRunPolicy(false, env), { sandboxMode: 'workspace-write', approvalPolicy: 'never' });
  assert.deepEqual(getRunPolicy(true, env), { sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
});

test('approval summary describes both execution modes', () => {
  const summary = approvalSummaryText({
    CODEX_DEFAULT_SANDBOX_MODE: 'workspace-write',
    CODEX_PRIVILEGED_SANDBOX_MODE: 'danger-full-access',
  });
  assert.match(summary, /workspace-write/);
  assert.match(summary, /danger-full-access/);
});
