import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin.
// Uses vi.importActual so no external const variables are referenced
// (vitest hoists vi.mock to top of file, making const refs undefined).
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

  const flush = async () => {
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    queue = new GroupQueue();
    const fs = await import('fs');
    vi.mocked(fs.default.writeFileSync).mockClear();
    vi.mocked(fs.default.mkdirSync).mockClear();
    vi.mocked(fs.default.renameSync).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('only runs one message container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const processMessages = vi.fn(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(200);
    expect(maxConcurrent).toBe(1);
  });

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];
    const processMessages = vi.fn(async (_groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await flush();
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);
    completionCallbacks[0]();
    await flush();
    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  it('runs tasks immediately even while message container is active', async () => {
    const executionOrder: string[] = [];
    let resolveMessage: () => void;
    let resolveTask: () => void;
    const processMessages = vi.fn(async () => {
      executionOrder.push('message-start');
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      executionOrder.push('message-end');
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    const taskFn = vi.fn(async () => {
      executionOrder.push('task-start');
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      executionOrder.push('task-end');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    expect(executionOrder).toEqual(['message-start', 'task-start']);
    resolveMessage!();
    resolveTask!();
    await flush();
  });

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;
    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(callCount).toBe(2);
    await vi.advanceTimersByTimeAsync(10000);
    await flush();
    expect(callCount).toBe(3);
  });

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);
    await queue.shutdown();
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    expect(processMessages).not.toHaveBeenCalled();
  });

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;
    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    expect(callCount).toBe(1);
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      await flush();
      expect(callCount).toBe(i + 2);
    }
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000);
    expect(callCount).toBe(countAfterMaxRetries);
  });

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];
    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await flush();
    queue.enqueueMessageCheck('group3@g.us');
    await flush();
    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);
    completionCallbacks[0]();
    await flush();
    expect(processed).toContain('group3@g.us');
  });

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;
    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    expect(taskCallCount).toBe(1);
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await flush();
    expect(dupFn).not.toHaveBeenCalled();
    resolveTask!();
    await flush();
    expect(taskCallCount).toBe(1);
  });

  it('does NOT preempt active message container when not idle', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);
    resolveProcess!();
    await flush();
  });

  it('preempts idle message container when task is enqueued', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');
    writeFileSync.mockClear();
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    resolveProcess!();
    await flush();
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');
    queue.sendMessage('group1@g.us', 'hello');
    writeFileSync.mockClear();
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);
    resolveProcess!();
    await flush();
  });

  it('sendMessage returns false when only a task container is running', async () => {
    let resolveTask: () => void;
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);
    resolveTask!();
    await flush();
  });

  it('preempts idle message container to free global slot for queued task', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
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
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await flush();
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    writeFileSync.mockClear();
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    let closeWrites = writeFileSync.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');
    closeWrites = writeFileSync.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    resolveProcess1!();
    resolveProcess2!();
    await flush();
  });

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
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    expect(bothRunningSimultaneously).toBe(true);
    resolveMessage!();
    resolveTask!();
    await flush();
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
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    expect(processMessages).toHaveBeenCalledTimes(1);
    resolveTask!();
    await flush();
  });

  it('isBusy returns false when only a task container is running', async () => {
    let resolveTask: () => void;
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    expect(queue.isBusy('group1@g.us')).toBe(false);
    resolveTask!();
    await flush();
  });

  it('activeCount is incremented synchronously -- no overshoot on rapid enqueues', async () => {
    const completionCallbacks: Array<() => void> = [];
    const processMessages = vi.fn(async (_groupJid: string) => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    expect(queue.isBusy('group1@g.us')).toBe(true);
    expect(queue.isBusy('group2@g.us')).toBe(true);
    expect(queue.isBusy('group3@g.us')).toBe(false);
    await flush();
    expect(processMessages).toHaveBeenCalledTimes(2);
    expect(queue['activeCount']).toBe(2);
    completionCallbacks[0]();
    await flush();
    expect(processMessages).toHaveBeenCalledTimes(3);
    completionCallbacks[1]();
    completionCallbacks[2]();
    await flush();
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
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await flush();
    expect(processMessages).toHaveBeenCalledTimes(2);
    const taskFn = vi.fn(async () => {
      executionOrder.push('task-group1@g.us');
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');
    completionCallbacks[0]();
    await flush();
    completionCallbacks[1]();
    await flush();
    expect(executionOrder).toContain('message-group1@g.us');
    expect(executionOrder).toContain('task-group1@g.us');
    for (const cb of completionCallbacks.slice(2)) cb();
    await flush();
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
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await flush();
    expect(started).toEqual(['group1@g.us', 'group2@g.us']);
    queue.enqueueMessageCheck('group3@g.us');
    queue.enqueueMessageCheck('group4@g.us');
    queue.enqueueMessageCheck('group5@g.us');
    await flush();
    expect(started).toEqual(['group1@g.us', 'group2@g.us']);
    completionCallbacks[0]();
    completionCallbacks[1]();
    await flush();
    expect(started.length).toBe(4);
    expect(queue['activeCount']).toBe(2);
    completionCallbacks[2]();
    await flush();
    expect(started.length).toBe(5);
    expect(started).toContain('group3@g.us');
    expect(started).toContain('group4@g.us');
    expect(started).toContain('group5@g.us');
    for (const cb of completionCallbacks.slice(3)) cb();
    await flush();
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
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    const msgProc = { pid: 1 } as any;
    queue.registerProcess(
      'group1@g.us',
      msgProc,
      'msg-container',
      'msg-folder',
      'message',
    );
    const taskProc = { pid: 2 } as any;
    queue.registerProcess(
      'group1@g.us',
      taskProc,
      'task-container',
      'task-folder',
      'task',
    );
    const groupState = queue['groups'].get('group1@g.us')!;
    expect(groupState.message.process).toBe(msgProc);
    expect(groupState.task.process).toBe(taskProc);
    expect(groupState.message.process).not.toBe(groupState.task.process);
    expect(groupState.message.groupFolder).toBe('msg-folder');
    expect(groupState.task.groupFolder).toBe('task-folder');
    resolveMessage!();
    resolveTask!();
    await flush();
  });

  it('closeTaskStdin writes _close to task lane IPC directory, not message lane', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    let resolveMessage: () => void;
    let resolveTask: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'msg-container',
      'msg-folder',
      'message',
    );
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'task-container',
      'task-folder',
      'task',
    );
    writeFileSync.mockClear();
    queue.closeTaskStdin('group1@g.us');
    const closeWrites = writeFileSync.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    expect(closeWrites[0][0]).toContain('task-folder/input/_close');
    const msgCloseWrites = writeFileSync.mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('msg-folder') &&
        (call[0] as string).endsWith('_close'),
    );
    expect(msgCloseWrites).toHaveLength(0);
    resolveMessage!();
    resolveTask!();
    await flush();
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
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    expect(queue.isBusy('group1@g.us')).toBe(true);
    queue.notifyIdle('group1@g.us');
    expect(queue.isBusy('group1@g.us')).toBe(false);
    resolveProcess!();
    await flush();
    expect(queue.isBusy('group1@g.us')).toBe(false);
  });

  it('prevents task enqueues after shutdown', async () => {
    const taskFn = vi.fn(async () => {});
    await queue.shutdown();
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await flush();
    expect(taskFn).not.toHaveBeenCalled();
  });

  it('frees slot when task throws an error', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);
    const failingTask = vi.fn(async () => {
      throw new Error('task exploded');
    });
    queue.enqueueTask('group1@g.us', 'task-1', failingTask);
    await flush();
    expect(failingTask).toHaveBeenCalledTimes(1);
    queue.enqueueMessageCheck('group1@g.us');
    await flush();
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('getVersion increments when queue state changes', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);
    const v0 = queue.getVersion();
    queue.enqueueMessageCheck('group1@g.us');
    expect(queue.getVersion()).toBeGreaterThan(v0);
    await flush();
  });

  describe('priority queue', () => {
    it('main group message starts even when non-main slots are full', async () => {
      const completionCallbacks: Array<() => void> = [];
      const started: string[] = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        started.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.setMainGroup('main@g.us');
      queue.enqueueMessageCheck('other@g.us');
      await flush();
      queue.enqueueMessageCheck('main@g.us');
      await flush();
      expect(started).toContain('main@g.us');
      expect(started).toContain('other@g.us');
      for (const cb of completionCallbacks) cb();
      await flush();
    });

    it('non-main group cannot use the reserved slot when main has pending work', async () => {
      const completionCallbacks: Array<() => void> = [];
      const started: string[] = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        started.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.setMainGroup('main@g.us');
      queue.enqueueMessageCheck('other1@g.us');
      await flush();
      queue.enqueueMessageCheck('other2@g.us');
      await flush();
      queue.enqueueMessageCheck('main@g.us');
      queue.enqueueMessageCheck('other3@g.us');
      await flush();
      expect(started).toEqual(['other1@g.us', 'other2@g.us']);
      completionCallbacks[0]();
      await flush();
      expect(started).toContain('main@g.us');
      expect(started).not.toContain('other3@g.us');
      completionCallbacks[1]();
      await flush();
      expect(started).toContain('other3@g.us');
      for (const cb of completionCallbacks.slice(2)) cb();
      await flush();
    });

    it('soft reserve: non-main can use all slots when main has no pending work', async () => {
      const completionCallbacks: Array<() => void> = [];
      const started: string[] = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        started.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.setMainGroup('main@g.us');
      queue.enqueueMessageCheck('other1@g.us');
      queue.enqueueMessageCheck('other2@g.us');
      await flush();
      expect(started).toEqual(['other1@g.us', 'other2@g.us']);
      expect(queue['activeCount']).toBe(2);
      for (const cb of completionCallbacks) cb();
      await flush();
    });

    it('tasks have lowest priority in the waiting queue', async () => {
      const completionCallbacks: Array<() => void> = [];
      const started: string[] = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        started.push(`msg:${groupJid}`);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.setMainGroup('main@g.us');
      queue.enqueueMessageCheck('fill1@g.us');
      queue.enqueueMessageCheck('fill2@g.us');
      await flush();
      const taskFn = vi.fn(async () => {
        started.push('task:other@g.us');
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      });
      queue.enqueueTask('other@g.us', 'task-1', taskFn);
      queue.enqueueMessageCheck('other@g.us');
      queue.enqueueMessageCheck('main@g.us');
      await flush();
      completionCallbacks[0]();
      await flush();
      expect(started).toContain('msg:main@g.us');
      completionCallbacks[1]();
      await flush();
      expect(started).toContain('msg:other@g.us');
      completionCallbacks[2]();
      await flush();
      expect(started).toContain('task:other@g.us');
      for (const cb of completionCallbacks.slice(3)) cb();
      await flush();
    });

    it('preempts non-main idle container when main message arrives at full capacity', async () => {
      const fs = await import('fs');
      const writeFileSync = vi.mocked(fs.default.writeFileSync);
      const completionCallbacks: Array<() => void> = [];
      const started: string[] = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        started.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.setMainGroup('main@g.us');
      queue.enqueueMessageCheck('other1@g.us');
      queue.enqueueMessageCheck('other2@g.us');
      await flush();
      queue.registerProcess(
        'other1@g.us',
        {} as any,
        'container-other1',
        'other1-folder',
      );
      queue.notifyIdle('other1@g.us');
      writeFileSync.mockClear();
      queue.enqueueMessageCheck('main@g.us');
      const closeWrites = writeFileSync.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === 'string' && call[0].endsWith('_close'),
      );
      expect(closeWrites).toHaveLength(1);
      expect(closeWrites[0][0]).toContain('other1-folder');
      for (const cb of completionCallbacks) cb();
      await flush();
    });

    it('getQueueMetrics returns correct priority breakdown', async () => {
      const completionCallbacks: Array<() => void> = [];
      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.setMainGroup('main@g.us');
      queue.enqueueMessageCheck('fill1@g.us');
      queue.enqueueMessageCheck('fill2@g.us');
      await flush();
      queue.enqueueMessageCheck('main@g.us');
      queue.enqueueMessageCheck('other@g.us');
      const taskFn = vi.fn(async () => {});
      queue.enqueueTask('task-group@g.us', 'task-1', taskFn);
      const metrics = queue.getQueueMetrics();
      expect(metrics.activeCount).toBe(2);
      expect(metrics.maxContainers).toBe(2);
      expect(metrics.waitingByPriority.mainMessages).toBe(1);
      expect(metrics.waitingByPriority.messages).toBe(1);
      expect(metrics.waitingByPriority.tasks).toBe(1);
      for (const cb of completionCallbacks) cb();
      await flush();
    });

    it('setMainGroup updates queue priority behavior', async () => {
      const completionCallbacks: Array<() => void> = [];
      const started: string[] = [];
      const processMessages = vi.fn(async (groupJid: string) => {
        started.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      queue.enqueueMessageCheck('group2@g.us');
      await flush();
      queue.setMainGroup('group1@g.us');
      queue.enqueueMessageCheck('group3@g.us');
      queue.enqueueMessageCheck('group1@g.us');
      completionCallbacks[0]();
      await flush();
      const secondMainIdx = started.lastIndexOf('group1@g.us');
      expect(secondMainIdx).toBeGreaterThan(1);
      for (const cb of completionCallbacks.slice(1)) cb();
      await flush();
    });
  });
});
