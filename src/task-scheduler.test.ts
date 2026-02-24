import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';
import { runContainerAgent } from './container-runner.js';

// Resolve function stored here so the test can control when runContainerAgent returns.
let resolveContainer: (() => void) | null = null;

// Default onOutput payload; tests can override via mockContainerOutput.
let containerOutput = { status: 'success' as const, result: 'test result' as string | null, newSessionId: 'sess-1' };

/** Override what the mock runContainerAgent passes to its onOutput callback. */
function mockContainerOutput(output: { status: string; result: string | null; newSessionId?: string }) {
  containerOutput = { status: output.status as 'success', result: output.result, newSessionId: output.newSessionId ?? 'sess-1' };
}

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(async (_group, _input, onProcess, onOutput) => {
    onProcess({} as any, 'test-container');
    if (onOutput) {
      await onOutput(containerOutput);
    }
    // Wait until the test explicitly resolves — this keeps runContainerAgent
    // "running" so the scheduler's closeTimer isn't cleared prematurely.
    await new Promise<void>((resolve) => {
      resolveContainer = resolve;
    });
    return containerOutput;
  }),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
    },
  };
});

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    containerOutput = { status: 'success', result: 'test result', newSessionId: 'sess-1' };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('calls closeTaskStdin and notifyTaskIdle (not closeStdin/notifyIdle) when a task runs', async () => {
    const chatJid = 'group@g.us';

    createTask({
      id: 'task-valid',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const closeTaskStdin = vi.fn();
    const notifyTaskIdle = vi.fn();
    const closeStdin = vi.fn();
    const notifyIdle = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: { jid: chatJid, folder: 'main', name: 'Main Group' },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        closeTaskStdin,
        notifyTaskIdle,
        closeStdin,
        notifyIdle,
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // Let the scheduler pick up and run the task
    await vi.advanceTimersByTimeAsync(10);

    // notifyTaskIdle should be called on success
    expect(notifyTaskIdle).toHaveBeenCalledWith(chatJid);

    // Advance past the 10s close delay to trigger closeTaskStdin
    await vi.advanceTimersByTimeAsync(10_000);

    expect(closeTaskStdin).toHaveBeenCalledWith(chatJid);

    // Let runContainerAgent finish so the scheduler completes cleanly
    resolveContainer?.();
    await vi.advanceTimersByTimeAsync(0);

    // The old message-lane methods should NOT have been called
    expect(closeStdin).not.toHaveBeenCalled();
    expect(notifyIdle).not.toHaveBeenCalled();
  });

  it('calls scheduleClose when result is null but status is success', async () => {
    const chatJid = 'group-null@g.us';

    // Simulate agent that sends messages via MCP tool — result is null
    mockContainerOutput({ status: 'success', result: null });

    createTask({
      id: 'task-null-result',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'aggregate tweets',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const closeTaskStdin = vi.fn();
    const notifyTaskIdle = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: { folder: 'main', name: 'Main Group' } as any,
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        closeTaskStdin,
        notifyTaskIdle,
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // Let the scheduler pick up and run the task
    await vi.advanceTimersByTimeAsync(10);

    // notifyTaskIdle should be called even with null result
    expect(notifyTaskIdle).toHaveBeenCalledWith(chatJid);

    // Advance past the 10s close delay to trigger closeTaskStdin
    await vi.advanceTimersByTimeAsync(10_000);

    // scheduleClose should have been called even though result was null
    expect(closeTaskStdin).toHaveBeenCalledWith(chatJid);

    // Clean up
    resolveContainer?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('advances next_run before running a cron task to prevent re-pickup on restart', async () => {
    const chatJid = 'group-cron@g.us';
    const now = Date.now();

    createTask({
      id: 'task-cron-advance',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'cron job',
      schedule_type: 'cron',
      schedule_value: '0 * * * *', // every hour
      context_mode: 'isolated',
      next_run: new Date(now - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: { folder: 'main', name: 'Main Group' } as any,
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        closeTaskStdin: vi.fn(),
        notifyTaskIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // Let the scheduler pick up and run the task
    await vi.advanceTimersByTimeAsync(10);

    // Before the container finishes, next_run should already be in the future
    const task = getTaskById('task-cron-advance');
    expect(task).toBeDefined();
    expect(task!.next_run).toBeDefined();
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(now);

    // Clean up
    resolveContainer?.();
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('advances next_run to far future for once tasks before running', async () => {
    const chatJid = 'group-once@g.us';

    createTask({
      id: 'task-once-advance',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'one time job',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: { folder: 'main', name: 'Main Group' } as any,
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        closeTaskStdin: vi.fn(),
        notifyTaskIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    // Let the scheduler pick up and run the task
    await vi.advanceTimersByTimeAsync(10);

    // Before the container finishes, next_run should be set to far future sentinel
    const task = getTaskById('task-once-advance');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe('9999-01-01T00:00:00.000Z');

    // Clean up
    resolveContainer?.();
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
