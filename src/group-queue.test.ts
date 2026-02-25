import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one message container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Dual-lane: messages and tasks run independently ---

  it('runs tasks immediately even while message container is active', async () => {
    const executionOrder: string[] = [];
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      executionOrder.push('message-start');
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      executionOrder.push('message-end');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a task while message container is active — task runs immediately
    // in its own lane (not queued behind the message)
    const taskFn = vi.fn(async () => {
      executionOrder.push('task-start');
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      executionOrder.push('task-end');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task should have started while message is still running
    expect(executionOrder).toEqual(['message-start', 'task-start']);

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Idle preemption ---

  it('does NOT preempt active message container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    // Enqueue a task while message container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle message container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false when only a task container is running', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (runs in task lane, no message container)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    // sendMessage should return false — no active message container
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle message container to free global slot for queued task', async () => {
    const fs = await import('fs');
    let resolveProcess1: () => void;
    let resolveProcess2: () => void;

    let callCount = 0;
    const processMessages = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          resolveProcess1 = resolve;
        });
      } else {
        await new Promise<void>((resolve) => {
          resolveProcess2 = resolve;
        });
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both global slots with message containers from different groups
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process for group1
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Enqueue a task for group1 — should be queued (global limit reached)
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // No preemption yet (container not idle)
    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now group1's container becomes idle — should preempt to free a slot
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess1!();
    resolveProcess2!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Dual-lane concurrency ---

  it('message and task containers run concurrently for the same group', async () => {
    let messageRunning = false;
    let taskRunning = false;
    let bothRunningSimultaneously = false;
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      messageRunning = true;
      if (taskRunning) bothRunningSimultaneously = true;
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      messageRunning = false;
      return true;
    });

    const taskFn = vi.fn(async () => {
      taskRunning = true;
      if (messageRunning) bothRunningSimultaneously = true;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      taskRunning = false;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a task first
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Now enqueue a message — should NOT be blocked by the task
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Both should be running at the same time
    expect(bothRunningSimultaneously).toBe(true);

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('task container does not block new messages from spawning', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    // Start a long-running task
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // User sends a message — should spawn immediately, not queue
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(1);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('isBusy returns false when only a task container is running', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // isBusy should be false — only task running, no message container
    expect(queue.isBusy('group1@g.us')).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Bug fix regression tests ---

  it('activeCount is incremented synchronously — no overshoot on rapid enqueues', async () => {
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups synchronously (no await between them)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // IMMEDIATELY verify state before any timer advance
    expect(queue.isBusy('group1@g.us')).toBe(true);
    expect(queue.isBusy('group2@g.us')).toBe(true);
    expect(queue.isBusy('group3@g.us')).toBe(false); // waiting, not started

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 processMessages calls should have happened
    expect(processMessages).toHaveBeenCalledTimes(2);

    // activeCount should never exceed 2
    expect(queue['activeCount']).toBe(2);

    // Complete both — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
    expect(processMessages).toHaveBeenCalledTimes(3);

    completionCallbacks[1]();
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('drainGroup starts both message and task when both are pending', async () => {
    const executionOrder: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      executionOrder.push(`message-${groupJid}`);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots with group1 (message) and group2 (message)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(2);

    // Enqueue a task for group1 (queued — at capacity)
    const taskFn = vi.fn(async () => {
      executionOrder.push('task-group1@g.us');
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // Enqueue another message for group1 (queued — message lane active)
    queue.enqueueMessageCheck('group1@g.us');

    // Complete group1's message container
    completionCallbacks[0](); // group1 message done
    await vi.advanceTimersByTimeAsync(10);

    // Complete group2's message container
    completionCallbacks[1](); // group2 message done
    await vi.advanceTimersByTimeAsync(10);

    // Both group1's pending message AND pending task should have started
    expect(executionOrder).toContain('message-group1@g.us');
    expect(executionOrder).toContain('task-group1@g.us');

    // Clean up remaining callbacks
    for (const cb of completionCallbacks.slice(2)) cb();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('drainWaiting starts waiting groups one at a time up to concurrency limit', async () => {
    const started: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      started.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill 2 slots with group1 and group2
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(['group1@g.us', 'group2@g.us']);

    // Enqueue group3, group4, group5 — all go to waiting list
    queue.enqueueMessageCheck('group3@g.us');
    queue.enqueueMessageCheck('group4@g.us');
    queue.enqueueMessageCheck('group5@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(['group1@g.us', 'group2@g.us']);

    // Complete both group1 and group2
    completionCallbacks[0]();
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    // Exactly 2 of the 3 waiting groups should have started (not all 3)
    expect(started.length).toBe(4);
    expect(queue['activeCount']).toBe(2);

    // Complete one more — the last waiting group should start
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);

    expect(started.length).toBe(5);
    expect(started).toContain('group3@g.us');
    expect(started).toContain('group4@g.us');
    expect(started).toContain('group5@g.us');

    // Clean up
    for (const cb of completionCallbacks.slice(3)) cb();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('registerProcess with lane parameter assigns to correct lane', async () => {
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Start a task for the same group
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Register process with lane='message'
    const msgProc = { pid: 1 } as any;
    queue.registerProcess('group1@g.us', msgProc, 'msg-container', 'msg-folder', 'message');

    // Register process with lane='task'
    const taskProc = { pid: 2 } as any;
    queue.registerProcess('group1@g.us', taskProc, 'task-container', 'task-folder', 'task');

    // Verify they are different objects (not clobbered)
    const groupState = queue['groups'].get('group1@g.us')!;
    expect(groupState.messageProcess).toBe(msgProc);
    expect(groupState.taskProcess).toBe(taskProc);
    expect(groupState.messageProcess).not.toBe(groupState.taskProcess);
    expect(groupState.messageGroupFolder).toBe('msg-folder');
    expect(groupState.taskGroupFolder).toBe('task-folder');

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('closeTaskStdin writes _close to task lane IPC directory, not message lane', async () => {
    const fs = await import('fs');
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Start a task container
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Register message process with groupFolder='msg-folder'
    queue.registerProcess('group1@g.us', {} as any, 'msg-container', 'msg-folder', 'message');
    // Register task process with groupFolder='task-folder'
    queue.registerProcess('group1@g.us', {} as any, 'task-container', 'task-folder', 'task');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Close task stdin
    queue.closeTaskStdin('group1@g.us');

    // Verify _close was written to task-folder, not msg-folder
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    expect(closeWrites[0][0]).toContain('task-folder/input/_close');

    // Verify NO call with msg-folder/_close
    const msgCloseWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('msg-folder') && (call[0] as string).endsWith('_close'),
    );
    expect(msgCloseWrites).toHaveLength(0);

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('notifyTaskIdle does not set idleWaiting on message lane', async () => {
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Start a task for the same group
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Verify message container is busy (active and not idle)
    expect(queue.isBusy('group1@g.us')).toBe(true);

    // Notify task idle — should NOT affect message lane
    queue.notifyTaskIdle('group1@g.us');

    // isBusy should STILL be true (idleWaiting should still be false)
    expect(queue.isBusy('group1@g.us')).toBe(true);

    // Now notify message idle
    queue.notifyIdle('group1@g.us');

    // NOW isBusy should be false
    expect(queue.isBusy('group1@g.us')).toBe(false);

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('isBusy returns true when message container is active and not idle', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue a message for group1
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Verify isBusy returns true
    expect(queue.isBusy('group1@g.us')).toBe(true);

    // Mark idle
    queue.notifyIdle('group1@g.us');
    expect(queue.isBusy('group1@g.us')).toBe(false);

    // Complete the container
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);

    // Still false after completion
    expect(queue.isBusy('group1@g.us')).toBe(false);
  });

  it('prevents task enqueues after shutdown', async () => {
    const taskFn = vi.fn(async () => {});

    await queue.shutdown(1000);

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(100);

    expect(taskFn).not.toHaveBeenCalled();
  });

  it('frees slot when task throws an error', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    // Enqueue a task that throws
    const failingTask = vi.fn(async () => {
      throw new Error('task exploded');
    });
    queue.enqueueTask('group1@g.us', 'task-1', failingTask);
    await vi.advanceTimersByTimeAsync(10);

    // Task should have been called and thrown
    expect(failingTask).toHaveBeenCalledTimes(1);

    // Enqueue a message — slot should have been freed
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(1);
  });
});
