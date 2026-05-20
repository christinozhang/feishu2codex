import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveWorkingDirectoryForText,
} from '../dist/workdir.js';

test('uses the home directory when the message has no explicit path', () => {
  assert.equal(resolveWorkingDirectoryForText('看下最新状态', {
    defaultDirectory: '/Users/christino.zhang',
  }), '/Users/christino.zhang');
});

test('uses an explicit absolute directory from the message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-workdir-'));
  assert.equal(resolveWorkingDirectoryForText(`在 ${dir} 看下状态`, {
    defaultDirectory: '/Users/christino.zhang',
  }), dir);
});

test('uses parent directory when the explicit path is a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-workdir-'));
  const file = path.join(dir, 'README.md');
  fs.writeFileSync(file, '# test\n');
  assert.equal(resolveWorkingDirectoryForText(`看一下 ${file}`, {
    defaultDirectory: '/Users/christino.zhang',
  }), dir);
});

test('expands tilde paths and strips markdown wrappers', () => {
  const home = os.homedir();
  const dir = path.join(home, 'code');
  const result = resolveWorkingDirectoryForText(`在 \`${dir.replace(home, '~')}\` 里看一下`, {
    defaultDirectory: '/Users/christino.zhang',
  });

  assert.equal(result, fs.existsSync(dir) ? dir : '/Users/christino.zhang');
});

test('ignores missing explicit paths and keeps the default directory', () => {
  assert.equal(resolveWorkingDirectoryForText('看下 /Users/christino.zhang/path-that-does-not-exist-123456', {
    defaultDirectory: '/Users/christino.zhang',
  }), '/Users/christino.zhang');
});
