import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskLimiter } from '../dist/taskLimiter.js';

test('task limiter allows only the configured active task count', async () => {
  const limiter = createTaskLimiter(1);

  const releaseFirst = await limiter.acquire();
  let secondAcquired = false;
  const second = limiter.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondAcquired, false);
  assert.deepEqual(limiter.snapshot(), { active: 1, waiting: 1, maxActive: 1 });

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  assert.deepEqual(limiter.snapshot(), { active: 1, waiting: 0, maxActive: 1 });

  releaseSecond();
  assert.deepEqual(limiter.snapshot(), { active: 0, waiting: 0, maxActive: 1 });
});

test('task limiter rejects an aborted waiter', async () => {
  const limiter = createTaskLimiter(1);
  const release = await limiter.acquire();
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal);

  controller.abort();

  await assert.rejects(waiting, /task slot wait aborted/);
  assert.deepEqual(limiter.snapshot(), { active: 1, waiting: 0, maxActive: 1 });

  release();
});
