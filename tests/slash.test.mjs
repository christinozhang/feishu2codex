import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatSkills,
  listSkills,
  parseSlashCommand,
  rewriteSkillPrompt,
  slashHelpText,
} from '../dist/slash.js';

test('parses slash commands', () => {
  assert.deepEqual(parseSlashCommand(' /skill systematic-debugging 看下问题 '), {
    name: 'skill',
    args: 'systematic-debugging 看下问题',
  });
  assert.equal(parseSlashCommand('hi'), null);
});

test('help text includes supported commands', () => {
  const help = slashHelpText();
  assert.match(help, /\/skills/);
  assert.match(help, /\/approval/);
});

test('lists skills with SKILL.md and filters by keyword', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  fs.mkdirSync(path.join(root, 'systematic-debugging'), { recursive: true });
  fs.writeFileSync(path.join(root, 'systematic-debugging', 'SKILL.md'), '# skill');
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });

  assert.equal(listSkills('', [root]).length, 1);
  assert.equal(listSkills('debug', [root])[0].name, 'systematic-debugging');
  assert.match(formatSkills('debug', [root]), /systematic-debugging/);
});

test('rewrites existing skill prompt and rejects missing skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  fs.mkdirSync(path.join(root, 'systematic-debugging'), { recursive: true });
  fs.writeFileSync(path.join(root, 'systematic-debugging', 'SKILL.md'), '# skill');

  const ok = rewriteSkillPrompt('systematic-debugging 看下卡片为什么卡住', [root]);
  assert.equal(ok.text, 'Use the systematic-debugging skill. User task: 看下卡片为什么卡住');

  const missing = rewriteSkillPrompt('missing task', [root]);
  assert.match(missing.error, /不存在/);
});
