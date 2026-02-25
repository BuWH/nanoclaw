import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

/**
 * Per-group state with separate tracking for message and task containers.
 *
 * Messages and tasks run in independent "lanes" so a long-running background
 * task (e.g. tweet aggregation) never blocks the user from getting a quick
 * response.  Both lanes still share the global concurrency limit
 * (MAX_CONCURRENT_CONTAINERS) to prevent resource exhaustion.
 */
interface GroupState {
  // Message lane
  activeMessage: boolean;
  idleWaiting: boolean;
  pendingMessages: boolean;
  messageProcess: ChildProcess | null;
  messageContainerName: string | null;
  messageGroupFolder: string | null;
  retryCount: number;

  // Task lane
  activeTask: boolean;
  pendingTasks: QueuedTask[];
  taskProcess: ChildProcess | null;
  taskContainerName: string | null;
  taskGroupFolder: string | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        activeMessage: false,
        idleWaiting: false,
        pendingMessages: false,
        messageProcess: null,
        messageContainerName: null,
        messageGroupFolder: null,
        retryCount: 0,

        activeTask: false,
        pendingTasks: [],
        taskProcess: null,
        taskContainerName: null,
        taskGroupFolder: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) {
      logger.warn({ groupJid }, 'Message check enqueue rejected: queue shutting down');
      return;
    }

    const state = this.getGroup(groupJid);

    if (state.activeMessage) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Message container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    // Increment synchronously to prevent concurrency overshoot
    state.activeMessage = true;
    state.idleWaiting = false;
    state.pendingMessages = false;
    this.activeCount++;
    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) {
      logger.warn(
        { groupJid, taskId },
        'Task enqueue rejected: queue shutting down (task will be skipped)',
      );
      return;
    }

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.info({ groupJid, taskId }, 'Task already queued, skipping duplicate');
      return;
    }

    if (state.activeTask) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.info(
        { groupJid, taskId, queueDepth: state.pendingTasks.length },
        'Task queued behind active task container',
      );
      return;
    }

    // If a message container is idle-waiting and a task arrives, preempt the
    // idle message container so it finishes quickly and frees its slot.
    if (state.activeMessage && state.idleWaiting) {
      this.closeStdin(groupJid);
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.info(
        { groupJid, taskId, activeCount: this.activeCount, maxConcurrent: MAX_CONCURRENT_CONTAINERS },
        'At concurrency limit, task queued (will run when slot available)',
      );
      return;
    }

    // Run immediately — increment synchronously to prevent concurrency overshoot
    state.activeTask = true;
    this.activeCount++;
    logger.info(
      { groupJid, taskId, activeCount: this.activeCount },
      'Task starting immediately',
    );
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string, lane: 'message' | 'task' = 'message'): void {
    const state = this.getGroup(groupJid);
    if (lane === 'task') {
      state.taskProcess = proc;
      state.taskContainerName = containerName;
      if (groupFolder) state.taskGroupFolder = groupFolder;
    } else {
      state.messageProcess = proc;
      state.messageContainerName = containerName;
      if (groupFolder) state.messageGroupFolder = groupFolder;
    }
  }

  /**
   * Mark the message container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending and no task container is running, preempt the idle
   * message container so the task can start sooner.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0 && !state.activeTask) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active message container via IPC file.
   * Returns true if the message was written, false if no active message container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.activeMessage || !state.messageGroupFolder) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.messageGroupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active message container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.activeMessage || !state.messageGroupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.messageGroupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Signal the active task container to wind down by writing a close sentinel.
   */
  closeTaskStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.activeTask || !state.taskGroupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.taskGroupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Mark the task container as having completed its work.
   * Unlike message containers, task containers don't have an idle-waiting concept,
   * so this is a no-op for state but could be used for future task lifecycle tracking.
   */
  notifyTaskIdle(_groupJid: string): void {
    // Task containers are single-turn — no idle waiting state to manage.
    // The task scheduler handles closing via closeTaskStdin.
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    // activeMessage, idleWaiting, pendingMessages, and activeCount are now set
    // synchronously by the caller to prevent concurrency overshoot.

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting message container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.activeMessage = false;
      state.messageProcess = null;
      state.messageContainerName = null;
      state.messageGroupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    // activeTask and activeCount are now set synchronously by the caller
    // to prevent concurrency overshoot.

    logger.info(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running task in separate container',
    );

    const taskStart = Date.now();
    try {
      await task.fn();
      logger.info(
        { groupJid, taskId: task.id, durationMs: Date.now() - taskStart },
        'Task container finished',
      );
    } catch (err) {
      logger.error(
        { groupJid, taskId: task.id, durationMs: Date.now() - taskStart, err },
        'Error running task',
      );
    } finally {
      state.activeTask = false;
      state.taskProcess = null;
      state.taskContainerName = null;
      state.taskGroupFolder = null;
      this.activeCount--;
      logger.debug(
        { groupJid, taskId: task.id, activeCount: this.activeCount, pendingTasks: state.pendingTasks.length },
        'Task slot released, draining group',
      );
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Messages first — user-facing responses take priority over background tasks
    if (state.pendingMessages && !state.activeMessage) {
      if (this.activeCount < MAX_CONCURRENT_CONTAINERS) {
        state.activeMessage = true;
        state.idleWaiting = false;
        state.pendingMessages = false;
        this.activeCount++;
        this.runForGroup(groupJid, 'drain').catch((err) =>
          logger.error({ groupJid, err }, 'Unhandled error in runForGroup (drain)'),
        );
      }
    }

    // Then pending tasks (in their own lane)
    if (state.pendingTasks.length > 0 && !state.activeTask) {
      if (this.activeCount < MAX_CONCURRENT_CONTAINERS) {
        const task = state.pendingTasks.shift()!;
        state.activeTask = true;
        this.activeCount++;
        logger.info(
          { groupJid, taskId: task.id, activeCount: this.activeCount, remainingTasks: state.pendingTasks.length },
          'Draining pending task from queue',
        );
        this.runTask(groupJid, task).catch((err) =>
          logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
        );
      } else {
        logger.debug(
          { groupJid, activeCount: this.activeCount, pendingTasks: state.pendingTasks.length },
          'Cannot drain pending tasks: at concurrency limit',
        );
      }
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    if (!state.pendingMessages && state.pendingTasks.length === 0) {
      this.drainWaiting();
    }
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Messages first
      if (state.pendingMessages && !state.activeMessage) {
        state.activeMessage = true;
        state.idleWaiting = false;
        state.pendingMessages = false;
        this.activeCount++;
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Unhandled error in runForGroup (waiting)'),
        );
      }

      if (state.pendingTasks.length > 0 && !state.activeTask) {
        if (this.activeCount < MAX_CONCURRENT_CONTAINERS) {
          state.activeTask = true;
          this.activeCount++;
          const task = state.pendingTasks.shift()!;
          this.runTask(nextJid, task).catch((err) =>
            logger.error({ groupJid: nextJid, taskId: task.id, err }, 'Unhandled error in runTask (waiting)'),
          );
        }
      }
    }
  }

  /**
   * Returns true when the group has an active message container that is not
   * idle-waiting.  Task containers are invisible to this check — the user
   * should not be told "wait" just because a background task is running.
   */
  isBusy(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return !!state && state.activeMessage && !state.idleWaiting;
  }

  /**
   * Returns a snapshot of all active and pending work across all groups.
   * Used by the /status command to show background task execution state.
   */
  getStatus(): Array<{
    groupJid: string;
    activeMessage: boolean;
    idleWaiting: boolean;
    pendingMessages: boolean;
    activeTask: boolean;
    pendingTaskCount: number;
    messageContainerName: string | null;
    taskContainerName: string | null;
  }> {
    const result: Array<{
      groupJid: string;
      activeMessage: boolean;
      idleWaiting: boolean;
      pendingMessages: boolean;
      activeTask: boolean;
      pendingTaskCount: number;
      messageContainerName: string | null;
      taskContainerName: string | null;
    }> = [];
    for (const [groupJid, state] of this.groups) {
      if (
        state.activeMessage ||
        state.activeTask ||
        state.pendingMessages ||
        state.pendingTasks.length > 0
      ) {
        result.push({
          groupJid,
          activeMessage: state.activeMessage,
          idleWaiting: state.idleWaiting,
          pendingMessages: state.pendingMessages,
          activeTask: state.activeTask,
          pendingTaskCount: state.pendingTasks.length,
          messageContainerName: state.messageContainerName,
          taskContainerName: state.taskContainerName,
        });
      }
    }
    return result;
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.messageProcess && !state.messageProcess.killed && state.messageContainerName) {
        activeContainers.push(state.messageContainerName);
      }
      if (state.taskProcess && !state.taskProcess.killed && state.taskContainerName) {
        activeContainers.push(state.taskContainerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
