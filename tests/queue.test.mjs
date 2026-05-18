import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canOperateTask,
  clearQueuedTasks,
  createQueuedTask,
  createSessionRunner,
  enqueueTask,
  moveQueuedTaskToFront,
  removeQueuedTask,
  snapshotRunner,
  summarizeTask,
} from '../dist/queue.js';

function task(id, userText, senderOpenId = 'user-a') {
  return createQueuedTask({
    id,
    chatId: 'chat',
    senderOpenId,
    sessionKey: `chat:${senderOpenId}`,
    sourceMessageId: `msg-${id}`,
    userText,
    createdAt: 1,
  });
}

test('queues tasks in FIFO order and supports front insertion', () => {
  const runner = createSessionRunner('chat:user-a');
  enqueueTask(runner, task('one', 'first'));
  enqueueTask(runner, task('two', 'second'));
  enqueueTask(runner, task('urgent', 'urgent'), 'front');

  assert.deepEqual(runner.queue.map((item) => item.id), ['urgent', 'one', 'two']);
  assert.equal(snapshotRunner(runner).queue.length, 3);
});

test('moves a waiting task to the front for the requester', () => {
  const runner = createSessionRunner('chat:user-a');
  enqueueTask(runner, task('one', 'first'));
  enqueueTask(runner, task('two', 'second'));

  const moved = moveQueuedTaskToFront(runner, 'two', 'user-a');

  assert.equal(moved?.id, 'two');
  assert.deepEqual(runner.queue.map((item) => item.id), ['two', 'one']);
});

test('does not let another sender cancel or move a queued task', () => {
  const runner = createSessionRunner('chat:user-a');
  enqueueTask(runner, task('one', 'first', 'user-a'));

  assert.equal(removeQueuedTask(runner, 'one', 'user-b'), null);
  assert.equal(moveQueuedTaskToFront(runner, 'one', 'user-b'), null);
  assert.equal(runner.queue.length, 1);
  assert.equal(canOperateTask(runner.queue[0], 'user-b'), false);
});

test('cancels only waiting tasks owned by the requester', () => {
  const runner = createSessionRunner('chat:user-a');
  enqueueTask(runner, task('one', 'first', 'user-a'));
  enqueueTask(runner, task('two', 'second', 'user-b'));

  assert.equal(removeQueuedTask(runner, 'one', 'user-a')?.id, 'one');
  assert.deepEqual(runner.queue.map((item) => item.id), ['two']);
  assert.equal(clearQueuedTasks(runner, 'user-a'), 0);
  assert.equal(clearQueuedTasks(runner, 'user-b'), 1);
});

test('summarizes long queued task text', () => {
  const summary = summarizeTask(task('long', 'x'.repeat(120)), 30);
  assert.match(summary, /truncated/);
  assert.ok(summary.length <= 30);
});
