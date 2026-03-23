import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  IPC_POLL_INTERVAL,
  POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TELEGRAM_BOT_TOKEN,
  TIMEZONE,
  TRIGGER_PATTERN,
  X_HEALTH_CHECK_INTERVAL,
} from './config.js';
import { TelegramChannel } from './channels/telegram.js';
import type { DoctorData } from './channels/telegram.js';
import { initBotPool } from './channels/telegram.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeQueueStatusSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { GIT_LOCK_FILE_PATH, getStaleLockInfo } from './git-lock.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  wasDelivered,
  clearDeliveryAck,
  checkPendingIpcFiles,
} from './delivery-ack.js';
import { shouldRotateSession, rotateSession } from './session-rotation.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  buttonsToTextFallback,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  createRun,
  getRunStats,
  pruneOldRuns,
  transitionRun,
} from './run-ledger.js';
import { startSchedulerLoop, triggerSchedulerDrain } from './task-scheduler.js';
import { ButtonRows, Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { startXHealthCheck } from './x-health.js';
import {
  startAutoUpdateLoop,
  UPDATE_CHANGELOG_PATH,
  PRE_UPDATE_HEAD_PATH,
  LAST_ANNOUNCED_HEAD_PATH,
  computeChangelog,
} from './auto-update.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let lastMessageLoopTick = 0;
const startTime = Date.now();

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Set main group for queue priority scheduling
  const mainJid = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain === true,
  )?.[0];
  if (mainJid) {
    queue.setMainGroup(mainJid);
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Update queue priority if this is the main group
  if (group.isMain === true) {
    queue.setMainGroup(jid);
  }

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** Build a full system diagnostic snapshot for the /doctor command. */
function buildDoctorData(): DoctorData {
  const uptimeMs = Date.now() - startTime;
  const memoryMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  const issues: string[] = [];

  // Docker check
  let dockerAvailable = false;
  let dockerError: string | undefined;
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    dockerAvailable = true;
  } catch (err) {
    dockerError = err instanceof Error ? err.message.split('\n')[0] : 'unknown';
    issues.push('Container runtime not responding');
  }

  // Container metrics
  const metrics = queue.getQueueMetrics();

  // Channel status
  const channelStatus = channels.map((ch) => ({
    name: ch.name,
    connected: ch.isConnected(),
  }));
  const disconnected = channelStatus.filter((ch) => !ch.connected);
  if (disconnected.length > 0) {
    issues.push(
      `${disconnected.length} channel(s) disconnected: ${disconnected.map((ch) => ch.name).join(', ')}`,
    );
  }

  // Groups
  const groupCount = Object.keys(registeredGroups).length;
  const mainEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain === true,
  );
  const mainName = mainEntry ? mainEntry[1].name : null;

  // Scheduler stats
  const allTasks = getAllTasks();
  const activeTasks = allTasks.filter((t) => t.status === 'active');
  const pausedTasks = allTasks.filter((t) => t.status === 'paused');
  const byCron = allTasks.filter((t) => t.schedule_type === 'cron').length;
  const byInterval = allTasks.filter(
    (t) => t.schedule_type === 'interval',
  ).length;
  const byOnce = allTasks.filter((t) => t.schedule_type === 'once').length;

  // Find next due task
  let nextDue: string | null = null;
  for (const task of activeTasks) {
    if (task.next_run && task.next_run < '9999') {
      if (!nextDue || task.next_run < nextDue) {
        nextDue = task.next_run;
      }
    }
  }

  // Git checks
  let gitBranch = 'unknown';
  let gitCommitShort = 'unknown';
  let gitCommitAge = 'unknown';
  let gitClean = true;
  let gitUpToDate: boolean | null = null;

  try {
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    gitCommitShort = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    const commitTimestamp = execSync('git log -1 --format=%ct', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();
    const ageMs = Date.now() - parseInt(commitTimestamp, 10) * 1000;
    const ageHours = Math.floor(ageMs / 3600000);
    const ageDays = Math.floor(ageHours / 24);
    if (ageDays > 0) {
      gitCommitAge = `${ageDays}d ${ageHours % 24}h ago`;
    } else if (ageHours > 0) {
      gitCommitAge = `${ageHours}h ago`;
    } else {
      gitCommitAge = `${Math.floor(ageMs / 60000)}m ago`;
    }

    const statusOutput = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();
    gitClean = statusOutput.length === 0;
    if (!gitClean) {
      const dirtyCount = statusOutput.split('\n').filter(Boolean).length;
      issues.push(`Git working tree dirty (${dirtyCount} files)`);
    }

    // Check if up-to-date with origin (uses cached fetch, does not fetch)
    try {
      execSync('git fetch origin --dry-run', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      });
      const local = execSync('git rev-parse HEAD', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      }).trim();
      const remote = execSync(`git rev-parse origin/${gitBranch}`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      }).trim();
      gitUpToDate = local === remote;
      if (!gitUpToDate) {
        issues.push('Not up-to-date with origin');
      }
    } catch {
      gitUpToDate = null;
    }
  } catch {
    issues.push('Git info unavailable');
  }

  // Run ledger
  const runStats = getRunStats();
  if (runStats.deadLetterCount > 0) {
    issues.push(
      `${runStats.deadLetterCount} dead-letter run(s) need attention`,
    );
  }

  return {
    pid: process.pid,
    uptimeMs,
    memoryMb,
    nodeVersion: process.version,
    docker: { available: dockerAvailable, error: dockerError },
    containerImage: CONTAINER_IMAGE,
    containers: { active: metrics.activeCount, max: metrics.maxContainers },
    channels: channelStatus,
    groups: { count: groupCount, mainName },
    scheduler: {
      total: allTasks.length,
      active: activeTasks.length,
      paused: pausedTasks.length,
      byCron,
      byInterval,
      byOnce,
      nextDue,
    },
    git: {
      branch: gitBranch,
      commitShort: gitCommitShort,
      commitAge: gitCommitAge,
      clean: gitClean,
      upToDate: gitUpToDate,
    },
    runStats,
    issues,
  };
}

/**
 * Read image files referenced by messages and return as base64 for the container.
 */
function collectImages(
  messages: NewMessage[],
): Array<{ base64: string; media_type: string }> {
  const images: Array<{ base64: string; media_type: string }> = [];
  for (const msg of messages) {
    if (!msg.image_path) continue;
    try {
      const filePath = path.join(DATA_DIR, 'media', msg.image_path);
      const buffer = fs.readFileSync(filePath);
      images.push({
        base64: buffer.toString('base64'),
        media_type: 'image/jpeg',
      });
    } catch (err) {
      logger.warn(
        { image_path: msg.image_path, err },
        'Failed to read image file',
      );
    }
  }
  return images;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const lastMessageId = missedMessages[0].id;

  // Track this execution in the run ledger
  const run = createRun('message', chatJid, group.folder, prompt.slice(0, 200));

  // Collect images from messages
  const images = collectImages(missedMessages);
  if (images.length > 0) {
    logger.info(
      { group: group.name, imageCount: images.length },
      'Collected images for container',
    );
  }

  // Write reply context for the MCP server inside the container
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupIpcDir, 'reply_context.json'),
    JSON.stringify({ lastMessageId, runId: run.id }),
  );

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let streamingTransitioned = false;

  transitionRun(run.id, 'running');

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    images,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          if (!streamingTransitioned) {
            transitionRun(run.id, 'streaming');
            streamingTransitioned = true;
          }
          await channel.setTyping?.(chatJid, false);
          await channel.sendMessage(chatJid, text, lastMessageId);
          // Warnings (e.g. large session) should be sent to the user but must NOT
          // set outputSentToUser — otherwise a subsequent container failure skips
          // cursor rollback and the user's prompt is silently lost.
          if (!result.isWarning) {
            outputSentToUser = true;
            transitionRun(run.id, 'reply_sent');
          }
        }
        // Only reset idle timer on actual results, not warnings or session-update markers
        if (!result.isWarning) {
          resetIdleTimer();
        }
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    run.id,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output.status === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      transitionRun(run.id, 'acked', {
        error: output.errorDetail,
        exit_code: output.exitCode,
        duration_ms: output.durationMs,
        stderr_excerpt: output.stderrTail,
        log_file: output.logFile,
      });
      clearDeliveryAck(run.id);
      return true;
    }

    // Grace window: the container may have sent a message via IPC (send_message
    // MCP tool) just before crashing.  The IPC watcher polls on a 1s interval,
    // so we wait slightly longer than one poll cycle for a delivery ack keyed
    // by this run's ID before deciding to roll back.
    //
    // Note: delivery acks fire for ALL IPC messages including progress updates,
    // not just final replies.  If a run sends a progress update then crashes,
    // we intentionally skip rollback — the user already received a message and
    // re-processing the same prompt would cause more confusion than dropping
    // the retry.
    await new Promise((resolve) =>
      setTimeout(resolve, IPC_POLL_INTERVAL + 200),
    );

    if (wasDelivered(run.id)) {
      logger.warn(
        { group: group.name, runId: run.id },
        'IPC delivery detected during grace window, skipping cursor rollback',
      );
      clearDeliveryAck(run.id);
      transitionRun(run.id, 'acked', {
        error: output.errorDetail,
        ipc_delivered: 1,
        exit_code: output.exitCode,
        duration_ms: output.durationMs,
        stderr_excerpt: output.stderrTail,
        log_file: output.logFile,
      });
      return true;
    }

    // Fallback: check IPC directory directly for pending files the watcher
    // hasn't processed yet (e.g. slow channel send or backlog).
    const groupIpcDir = resolveGroupIpcPath(group.folder);
    if (checkPendingIpcFiles(groupIpcDir, run.id)) {
      logger.warn(
        { group: group.name, runId: run.id },
        'Pending IPC file detected for this run, skipping cursor rollback',
      );
      clearDeliveryAck(run.id);
      transitionRun(run.id, 'acked', {
        error: output.errorDetail,
        ipc_delivered: 1,
        exit_code: output.exitCode,
        duration_ms: output.durationMs,
        stderr_excerpt: output.stderrTail,
        log_file: output.logFile,
      });
      return true;
    }

    transitionRun(run.id, 'failed', {
      error: output.errorDetail || 'container error',
      exit_code: output.exitCode,
      duration_ms: output.durationMs,
      stderr_excerpt: output.stderrTail,
      log_file: output.logFile,
    });

    // If this is already a retry (retryCount >= 1), the same messages caused
    // the previous failure too.  Advancing the cursor skips the problematic
    // batch so the system doesn't loop forever on un-processable messages
    // (e.g. [Photo] without image data).
    if (queue.getRetryCount(chatJid) >= 1) {
      logger.error(
        { group: group.name, messageCount: missedMessages.length },
        'Consecutive failures for group — skipping problematic messages to break retry loop',
      );
      // Transition to failed — auto-promotes to dead_letter when retries exhausted
      transitionRun(run.id, 'failed', {
        error: 'Consecutive failures — messages skipped to break retry loop',
      });
      // Cursor was already advanced before running the agent; just keep it.
      return true;
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  clearDeliveryAck(run.id);
  transitionRun(run.id, 'acked');
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  images: Array<{ base64: string; media_type: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  runId?: string,
): Promise<{
  status: 'success' | 'error';
  errorDetail?: string;
  exitCode?: number;
  durationMs?: number;
  stderrTail?: string;
  logFile?: string;
}> {
  const isMain = group.isMain === true;
  let sessionId: string | undefined = sessions[group.folder];

  // Auto-rotate session if transcript on disk is too large
  if (sessionId && shouldRotateSession(group.folder)) {
    const result = rotateSession(group.folder, sessionId);
    if (result.rotated) {
      delete sessions[group.folder];
      deleteSession(group.folder);
      sessionId = undefined;
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      last_run: t.last_run,
      last_result: t.last_result,
      created_at: t.created_at,
      context_mode: t.context_mode,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update queue status snapshot for container to read
  writeQueueStatusSnapshot(
    group.folder,
    isMain,
    queue.getStatus(),
    registeredGroups,
    queue.getQueueMetrics(),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        images: images.length > 0 ? images : undefined,
        runId,
      },
      (proc, containerName) =>
        queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          'message',
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return {
        status: 'error',
        errorDetail: output.error,
        exitCode: output.exitCode,
        durationMs: output.durationMs,
        stderrTail: output.stderrTail,
        logFile: output.logFile,
      };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      errorDetail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    lastMessageLoopTick = Date.now();
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Do NOT update reply_context.json here. The piped messages are
            // supplemental input; the agent may still be composing a response
            // to the original batch. Overwriting reply context would cause
            // those in-flight replies to point at the wrong message.
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // Check if a message container is already busy BEFORE enqueuing,
            // so we only ack when the user genuinely has to wait behind an
            // earlier conversation — not when this is the first message.
            const wasBusy = queue.isBusy(chatJid);

            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);

            // Status feedback: let the user know their message is queued
            if (wasBusy) {
              const ackMsgId = messagesToSend[0].id;
              channel
                .sendMessage(chatJid, '收到，稍等...', ackMsgId)
                .catch((err) =>
                  logger.warn({ chatJid, err }, 'Failed to send queue status'),
                );
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function startHealthMonitor(): void {
  // 1. Event loop lag detection
  //    A setTimeout(fn, 5000) that fires >30s late means the event loop was blocked.
  const LAG_CHECK_INTERVAL = 5_000;
  const LAG_THRESHOLD = 30_000;

  let lastTick = Date.now();
  let currentLagMs = 0;
  const checkLag = () => {
    const now = Date.now();
    const lag = now - lastTick - LAG_CHECK_INTERVAL;
    currentLagMs = lag;
    lastTick = now;
    if (lag > LAG_THRESHOLD) {
      logger.fatal({ lagMs: lag }, 'Event loop blocked, exiting for restart');
      process.exit(1);
    }
    setTimeout(checkLag, LAG_CHECK_INTERVAL);
  };
  setTimeout(checkLag, LAG_CHECK_INTERVAL);

  // 2. Heartbeat log (every 5 minutes)
  const HEARTBEAT_INTERVAL = 5 * 60 * 1000;
  setInterval(() => {
    const status = queue.getStatus();
    const metrics = queue.getQueueMetrics();
    const activeContainers = status.filter(
      (s) => s.activeMessage || s.activeTask,
    ).length;
    const pendingMessages = status.filter((s) => s.pendingMessages).length;
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    // Worktree count for concurrency visibility
    let worktreeCount = 0;
    try {
      const wtList = execSync('git worktree list --porcelain', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      });
      worktreeCount = wtList
        .split('\n')
        .filter((l) => l.startsWith('worktree ')).length;
    } catch {
      /* non-fatal */
    }

    // Check for stale git lock files
    const staleLock = getStaleLockInfo();

    const runStats = getRunStats();
    logger.info(
      {
        uptimeMin: Math.round((Date.now() - startTime) / 60_000),
        activeContainers,
        pendingMessages,
        rssMb,
        lagMs: currentLagMs,
        worktreeCount,
        staleLock: staleLock
          ? { pid: staleLock.pid, operation: staleLock.operation }
          : null,
        queueMetrics: metrics,
        deadLetters: runStats.deadLetterCount,
        runsByStatus: runStats.byStatus,
      },
      'Heartbeat',
    );

    // Reset boot attempts counter after stable operation
    try {
      const attemptsPath = path.join(DATA_DIR, '.boot-attempts');
      if (fs.existsSync(attemptsPath)) {
        fs.writeFileSync(attemptsPath, '0');
      }
    } catch {
      /* non-critical */
    }
  }, HEARTBEAT_INTERVAL);

  // 3. Periodic orphan container cleanup (every 10 minutes)
  setInterval(
    () => {
      try {
        cleanupOrphans({ quiet: true });
      } catch (err) {
        logger.warn({ err }, 'Periodic orphan cleanup failed');
      }
    },
    10 * 60 * 1000,
  );

  // 4. Daily prune of old run ledger entries (every 24 hours)
  setInterval(
    () => {
      try {
        const pruned = pruneOldRuns(7);
        if (pruned > 0) {
          logger.info({ pruned }, 'Pruned old run ledger entries');
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to prune run ledger');
      }
    },
    24 * 60 * 60 * 1000,
  );

  // 5. Message loop stall detection
  //    The message loop updates lastMessageLoopTick every ~2s. If it hasn't
  //    been updated for 60s, the loop is stuck.
  const LOOP_STALL_THRESHOLD = 60_000;
  setInterval(() => {
    if (
      messageLoopRunning &&
      lastMessageLoopTick > 0 &&
      Date.now() - lastMessageLoopTick > LOOP_STALL_THRESHOLD
    ) {
      logger.fatal(
        { stalledForMs: Date.now() - lastMessageLoopTick },
        'Message loop stalled, exiting for restart',
      );
      process.exit(1);
    }
  }, 30_000);

  // Periodic orphan container cleanup (every 10 minutes)
  setInterval(
    () => {
      try {
        cleanupOrphans();
      } catch (err) {
        logger.warn({ err }, 'Periodic orphan cleanup failed');
      }
    },
    10 * 60 * 1000,
  );
}

async function main(): Promise<void> {
  // Boot failure guard: auto-rollback after 3 consecutive failures
  const BOOT_ATTEMPTS_PATH = path.join(DATA_DIR, '.boot-attempts');
  const KNOWN_GOOD_PATH = path.join(DATA_DIR, '.known-good-commit');
  let bootAttempts = 0;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(BOOT_ATTEMPTS_PATH)) {
      bootAttempts =
        parseInt(fs.readFileSync(BOOT_ATTEMPTS_PATH, 'utf-8').trim(), 10) || 0;
    }
    bootAttempts++;
    fs.writeFileSync(BOOT_ATTEMPTS_PATH, String(bootAttempts));
  } catch {
    /* ignore fs errors during boot guard */
  }

  if (bootAttempts >= 3) {
    logger.error(
      { bootAttempts },
      'Too many consecutive boot failures — attempting rollback',
    );
    try {
      if (fs.existsSync(KNOWN_GOOD_PATH)) {
        const knownGood = fs.readFileSync(KNOWN_GOOD_PATH, 'utf-8').trim();
        if (!/^[0-9a-f]{40}$/i.test(knownGood)) {
          logger.error(
            { knownGood },
            'Invalid known-good SHA in boot guard, skipping rollback',
          );
        } else {
          const currentHead = execSync('git rev-parse HEAD', {
            encoding: 'utf-8',
            stdio: 'pipe',
          }).trim();
          if (knownGood !== currentHead) {
            execSync(`git reset --hard ${knownGood}`, { stdio: 'pipe' });
            const nodeBinDir = path.dirname(process.execPath);
            execSync('npm run build', {
              stdio: 'pipe',
              timeout: 120000,
              env: {
                ...process.env,
                PATH: `${nodeBinDir}:${process.env.PATH}`,
              },
            });
            fs.writeFileSync(BOOT_ATTEMPTS_PATH, '0');
            logger.info(
              { rolledBackTo: knownGood },
              'Boot rollback successful, restarting',
            );
            process.exit(0);
          }
        }
      }
    } catch (rollbackErr) {
      logger.fatal({ err: rollbackErr }, 'Boot rollback failed');
    }
  }

  // Crash on unhandled rejections instead of silently continuing in a broken state
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'Unhandled promise rejection');
    process.exit(1);
  });

  ensureContainerRuntimeRunning();
  cleanupOrphans();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // X health check: hoisted so shutdown handler can stop it
  let stopXHealthCheck: (() => void) | null = null;

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopXHealthCheck?.();
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels.
  // First, connect Telegram (our primary channel with custom options).
  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
      ...channelOpts,
      onRestart: () => shutdown('restart'),
      getScheduledTasks: () => getAllTasks(),
      getQueueStatus: () => queue.getStatus(),
      getUptime: () => Date.now() - startTime,
      getRunStats: () => getRunStats(),
      getQueueMetrics: () => queue.getQueueMetrics(),
      getChannelStatus: () =>
        channels.map((ch) => ({ name: ch.name, connected: ch.isConnected() })),
      getDoctorData: () => buildDoctorData(),
    });
    channels.push(telegram);
    await telegram.connect();

    if (TELEGRAM_BOT_POOL.length > 0) {
      await initBotPool(TELEGRAM_BOT_POOL);
    }
  }

  // Then, connect any additional channels registered via the channel registry.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const ch = factory(channelOpts);
    if (!ch) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(ch);
    await ch.connect();
  }

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder, 'task'),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text); // No reply-to for scheduled tasks
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, replyToMessageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, replyToMessageId);
    },
    sendMessageWithButtons: (
      jid: string,
      text: string,
      buttons: ButtonRows,
      replyToMessageId?: string,
    ) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendMessageWithButtons) {
        return channel.sendMessageWithButtons(
          jid,
          text,
          buttons,
          replyToMessageId,
        );
      }
      // Fallback: render buttons as numbered text options
      return channel.sendMessage(
        jid,
        buttonsToTextFallback(text, buttons),
        replyToMessageId,
      );
    },
    setTyping: async (jid, isTyping) => {
      const channel = findChannel(channels, jid);
      if (channel?.setTyping) await channel.setTyping(jid, isTyping);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    restart: async () => {
      logger.info('Restart requested — shutting down for launchd to restart');
      await queue.shutdown(10000);
      for (const ch of channels) await ch.disconnect();
      process.exit(0);
    },
    triggerSchedulerDrain,
    getQueueStatus: () => queue.getStatus(),
    writeQueueStatusSnapshot,
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
        last_run: t.last_run,
        last_result: t.last_result,
        created_at: t.created_at,
        context_mode: t.context_mode,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startHealthMonitor();
  stopXHealthCheck = startXHealthCheck(X_HEALTH_CHECK_INTERVAL);
  startAutoUpdateLoop(queue);
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Notify main group that the server has started.
  // If we restarted due to auto-update, include what changed.
  const mainJid = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain === true,
  )?.[0];
  if (mainJid) {
    const mainChannel = findChannel(channels, mainJid);
    if (mainChannel) {
      let msg = '服务已重启 ✅';
      let changelog = '';

      try {
        // Strategy A (primary): Compute changelog from pre-update HEAD marker.
        // The marker is written BEFORE pull, so it survives SIGTERM/crashes.
        if (fs.existsSync(PRE_UPDATE_HEAD_PATH)) {
          const savedSha = fs
            .readFileSync(PRE_UPDATE_HEAD_PATH, 'utf-8')
            .trim();
          const currentHead = execSync('git rev-parse HEAD', {
            cwd: process.cwd(),
            encoding: 'utf-8',
            stdio: 'pipe',
          }).trim();

          logger.info(
            { savedSha, currentHead, markerPath: PRE_UPDATE_HEAD_PATH },
            'Found pre-update HEAD marker',
          );

          // Dedup guard: don't re-announce the same update after a manual restart.
          let lastAnnounced = '';
          try {
            lastAnnounced = fs
              .readFileSync(LAST_ANNOUNCED_HEAD_PATH, 'utf-8')
              .trim();
          } catch {
            /* file doesn't exist yet */
          }

          if (savedSha !== currentHead && currentHead !== lastAnnounced) {
            changelog = computeChangelog(savedSha, currentHead, process.cwd());
          } else {
            logger.info(
              { savedSha, currentHead, lastAnnounced },
              'Skipping changelog: no change or already announced',
            );
          }

          // Clean up marker
          try {
            fs.unlinkSync(PRE_UPDATE_HEAD_PATH);
          } catch {
            /* ignore */
          }

          // Record what we announced
          if (changelog) {
            try {
              fs.mkdirSync(path.dirname(LAST_ANNOUNCED_HEAD_PATH), {
                recursive: true,
              });
              fs.writeFileSync(LAST_ANNOUNCED_HEAD_PATH, currentHead, 'utf-8');
            } catch {
              /* non-fatal */
            }
          }
        }

        // Strategy B (legacy fallback): Read pre-written changelog file.
        // Handles the case where an old version wrote the changelog before restart.
        if (!changelog && fs.existsSync(UPDATE_CHANGELOG_PATH)) {
          changelog = fs.readFileSync(UPDATE_CHANGELOG_PATH, 'utf-8').trim();
          logger.info(
            {
              changelogPath: UPDATE_CHANGELOG_PATH,
              changelogLength: changelog.length,
            },
            'Read legacy changelog from disk',
          );
          try {
            fs.unlinkSync(UPDATE_CHANGELOG_PATH);
          } catch {
            /* ignore */
          }
        }

        if (changelog) {
          msg += '\n\n*更新内容:*\n' + changelog;
        }
      } catch (changelogErr) {
        logger.warn(
          { err: changelogErr },
          'Failed to compute update changelog',
        );
      }

      mainChannel.sendMessage(mainJid, msg).catch((err) => {
        logger.warn({ err }, 'Failed to send startup notification');
      });
    }
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
