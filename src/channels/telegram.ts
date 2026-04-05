import { Api, Bot, InlineKeyboard } from 'grammy';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';

/**
 * Timeout for outbound Telegram API calls (sendMessage, sendChatAction, etc.).
 *
 * grammY defaults to 500s which is designed for getUpdates long polling and
 * large file uploads. For sendMessage this is far too long — a single hung
 * request blocks the IPC processing loop and makes the bot appear dead.
 * 30 seconds is generous for a text message; Telegram usually responds in <2s.
 */
const SEND_TIMEOUT_MS = 30_000;

/** Race a promise against a timeout. Rejects with a clear error on timeout. */
function withSendTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Telegram ${label} timed out after ${SEND_TIMEOUT_MS / 1000}s`,
          ),
        ),
      SEND_TIMEOUT_MS,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
import {
  ButtonRows,
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  ScheduledTask,
} from '../types.js';

/**
 * Convert agent output (WhatsApp-style formatting) to Telegram HTML.
 * Handles: *bold*, **bold**, _italic_, ```code blocks```, `inline code`
 * Falls back gracefully — if conversion looks wrong, returns null.
 */
export function toTelegramHtml(text: string): string {
  // Step 1: Escape HTML entities in the raw text
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Step 2: Convert code blocks first (```...```) to protect their contents
  // Handle multiline and inline code blocks
  html = html.replace(/```([\s\S]*?)```/g, (_match, code) => {
    return `<pre>${code}</pre>`;
  });

  // Step 3: Convert inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    return `<code>${code}</code>`;
  });

  // Step 4: Convert double-asterisk bold (**...**) first
  html = html.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<b>$1</b>');

  // Step 5: Convert single-asterisk bold (*...*) — but not inside <pre>/<code> tags
  html = html.replace(
    /(?<![<\w\/])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![>\w])/g,
    '<b>$1</b>',
  );

  // Step 6: Convert italic (_..._) — similar approach
  html = html.replace(
    /(?<![<\w\/])_(?!\s)([^_\n]+?)(?<!\s)_(?![>\w])/g,
    '<i>$1</i>',
  );

  return html;
}

export interface QueueStatusEntry {
  groupJid: string;
  activeMessage: boolean;
  idleWaiting: boolean;
  pendingMessages: boolean;
  activeTask: boolean;
  pendingTaskCount: number;
  messageContainerName: string | null;
  taskContainerName: string | null;
}

export interface QueueMetrics {
  activeCount: number;
  maxContainers: number;
  waitingByPriority: {
    mainMessages: number;
    messages: number;
    tasks: number;
  };
}

export interface ChannelStatusEntry {
  name: string;
  connected: boolean;
}

export interface DoctorData {
  pid: number;
  uptimeMs: number;
  memoryMb: number;
  nodeVersion: string;
  docker: { available: boolean; error?: string };
  containerImage: string;
  containers: { active: number; max: number };
  channels: ChannelStatusEntry[];
  groups: { count: number; mainName: string | null };
  scheduler: {
    total: number;
    active: number;
    paused: number;
    byCron: number;
    byInterval: number;
    byOnce: number;
    nextDue: string | null;
  };
  git: {
    branch: string;
    commitShort: string;
    commitAge: string;
    clean: boolean;
    upToDate: boolean | null;
  };
  runStats: {
    total: number;
    byStatus: Record<string, number>;
    deadLetterCount: number;
  };
  issues: string[];
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRestart?: () => Promise<void>;
  getScheduledTasks?: () => ScheduledTask[];
  getQueueStatus?: () => QueueStatusEntry[];
  getUptime?: () => number;
  getRunStats?: () => {
    total: number;
    byStatus: Record<string, number>;
    deadLetterCount: number;
  };
  getQueueMetrics?: () => QueueMetrics;
  getChannelStatus?: () => ChannelStatusEntry[];
  getDoctorData?: () => DoctorData;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private pollingWatchdog: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private lastUpdateTime = Date.now();
  private lastWatchdogTick = Date.now();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} 在线中`);
    });

    // Command to restart the server
    this.bot.command('restart', async (ctx) => {
      if (!this.opts.onRestart) {
        ctx.reply('不支持重启');
        return;
      }
      await ctx.reply('正在重启服务器...');
      logger.info(
        { chatId: ctx.chat.id, user: ctx.from?.first_name },
        'Restart triggered via /restart command',
      );
      // Small delay so the reply is sent before shutting down
      setTimeout(() => this.opts.onRestart!(), 500);
    });

    // Command to list scheduled tasks
    this.bot.command('tasks', (ctx) => {
      if (!this.opts.getScheduledTasks) {
        ctx.reply('定时任务功能不可用');
        return;
      }

      const allTasks = this.opts.getScheduledTasks();
      // Hide completed one-off tasks — they're historical noise
      const tasks = allTasks.filter(
        (t) => !(t.schedule_type === 'once' && t.status === 'completed'),
      );
      if (tasks.length === 0) {
        ctx.reply('当前没有定时任务');
        return;
      }

      const groups = this.opts.registeredGroups();
      const lines = tasks.map((t, i) => {
        const statusTag =
          t.status === 'active'
            ? 'active'
            : t.status === 'paused'
              ? 'paused'
              : 'done';
        const groupName =
          Object.values(groups).find((g) => g.folder === t.group_folder)
            ?.name || t.group_folder;
        const scheduleDesc = formatSchedule(t);
        const promptPreview =
          t.prompt.length > 60 ? `${t.prompt.slice(0, 60)}...` : t.prompt;

        let line = `${i + 1}. [${statusTag}] ${promptPreview}\n    ${groupName} | ${scheduleDesc}`;

        if (t.status === 'active') {
          const lastRunInfo = t.last_run
            ? `Last: ${formatTime(t.last_run)}`
            : '';
          const nextRunInfo =
            t.next_run && t.next_run < '9999'
              ? `Next: ${formatTime(t.next_run)}`
              : '';
          const timeInfo = [lastRunInfo, nextRunInfo]
            .filter(Boolean)
            .join('  ');
          if (timeInfo) {
            line += `\n    ${timeInfo}`;
          }
        }

        return line;
      });

      // Compact ID footer — show short IDs for reference
      const shortIds = tasks.map((t) => t.id.slice(0, 8));
      const idFooter = `IDs: ${shortIds.join(' / ')}`;

      const header = `<b>定时任务</b> (${tasks.length})\n\n`;
      const body = lines.join('\n\n');
      const footer = `\n\n<code>${idFooter}</code>`;
      ctx.reply(header + body + footer, { parse_mode: 'HTML' }).catch(() => {
        // Fallback to plain text if HTML fails
        ctx.reply(`定时任务 (${tasks.length})\n\n${body}\n\n${idFooter}`);
      });
    });

    // Command to show full system status dashboard
    this.bot.command('status', (ctx) => {
      if (!this.opts.getQueueStatus) {
        ctx.reply('状态查询不可用');
        return;
      }

      const entries = this.opts.getQueueStatus();
      const groups = this.opts.registeredGroups();

      // Global metrics section
      const sections: string[] = [];

      // Uptime + Memory line
      const uptimeMs = this.opts.getUptime?.() ?? 0;
      const uptimeStr = formatUptime(uptimeMs);
      const memMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
      sections.push(`Uptime: ${uptimeStr} | Memory: ${memMb} MB`);

      // Containers + Queue line
      const metrics = this.opts.getQueueMetrics?.();
      if (metrics) {
        const totalWaiting =
          metrics.waitingByPriority.mainMessages +
          metrics.waitingByPriority.messages +
          metrics.waitingByPriority.tasks;
        sections.push(
          `Containers: ${metrics.activeCount}/${metrics.maxContainers} | Queue: ${totalWaiting} waiting`,
        );
      }

      // Per-group status section
      if (entries.length > 0) {
        const groupLines = entries.map((e) => {
          const group = groups[e.groupJid];
          const name = group?.name || e.groupJid;

          const msgStatus = e.activeMessage
            ? e.idleWaiting
              ? 'idle-waiting'
              : 'running'
            : 'idle';
          const taskStatus = e.activeTask ? 'running' : 'idle';

          const parts: string[] = [];
          parts.push(`Msg: ${msgStatus} | Task: ${taskStatus}`);

          if (e.pendingMessages) {
            parts.push('Pending: msg queued');
          }
          if (e.pendingTaskCount > 0) {
            parts.push(`Pending: ${e.pendingTaskCount} task(s)`);
          }

          return `<b>${name}</b>\n    ${parts.join('\n    ')}`;
        });

        sections.push(`-- Active Groups --\n\n${groupLines.join('\n\n')}`);
      } else {
        sections.push('-- Active Groups --\n\nNo active work');
      }

      // Channels section
      const channelStatus = this.opts.getChannelStatus?.();
      if (channelStatus && channelStatus.length > 0) {
        const channelLines = channelStatus
          .map(
            (ch) =>
              `${ch.name}: ${ch.connected ? 'connected' : 'disconnected'}`,
          )
          .join('\n');
        sections.push(`-- Channels --\n${channelLines}`);
      }

      // Run ledger section
      const runStats = this.opts.getRunStats?.();
      if (runStats && runStats.total > 0) {
        const ok = runStats.byStatus['acked'] || 0;
        const fail =
          (runStats.byStatus['failed'] || 0) +
          (runStats.byStatus['dead_letter'] || 0);
        const running = runStats.byStatus['running'] || 0;
        sections.push(
          `-- Run Ledger --\nTotal: ${runStats.total} | OK: ${ok} | Fail: ${fail} | Running: ${running}`,
        );
      }

      const header = '<b>System Status</b>\n\n';
      const body = sections.join('\n\n');
      ctx.reply(header + body, { parse_mode: 'HTML' }).catch(() => {
        ctx.reply(`System Status\n\n${body.replace(/<[^>]+>/g, '')}`);
      });
    });

    // Command to run system diagnostics
    this.bot.command('doctor', async (ctx) => {
      if (!this.opts.getDoctorData) {
        ctx.reply('诊断功能不可用');
        return;
      }

      await ctx.reply('Running diagnostics...');

      let data: DoctorData;
      try {
        data = this.opts.getDoctorData();
      } catch (err) {
        ctx.reply('诊断过程出错');
        logger.error({ err }, 'Doctor command failed');
        return;
      }

      const sections: string[] = [];

      // Process section
      sections.push(
        `<b>-- Process --</b>\n` +
          `PID: ${data.pid} | Uptime: ${formatUptime(data.uptimeMs)}\n` +
          `Memory: ${data.memoryMb} MB | Node: ${data.nodeVersion}`,
      );

      // Container runtime section
      const dockerStatus = data.docker.available
        ? 'running'
        : `error: ${data.docker.error || 'unknown'}`;
      sections.push(
        `<b>-- Container Runtime --</b>\n` +
          `Docker: ${dockerStatus}\n` +
          `Image: ${data.containerImage}\n` +
          `Active: ${data.containers.active}/${data.containers.max} containers`,
      );

      // Channels section
      if (data.channels.length > 0) {
        const channelLines = data.channels
          .map(
            (ch) =>
              `${ch.name}: ${ch.connected ? 'connected' : 'disconnected'}`,
          )
          .join('\n');
        sections.push(`<b>-- Channels --</b>\n${channelLines}`);
      }

      // Groups section
      const mainInfo = data.groups.mainName
        ? `Main: ${data.groups.mainName}`
        : 'Main: not set';
      sections.push(
        `<b>-- Groups --</b>\n` +
          `Registered: ${data.groups.count} groups\n` +
          mainInfo,
      );

      // Scheduler section
      const schedParts = [];
      if (data.scheduler.byCron > 0)
        schedParts.push(`${data.scheduler.byCron} cron`);
      if (data.scheduler.byInterval > 0)
        schedParts.push(`${data.scheduler.byInterval} interval`);
      if (data.scheduler.byOnce > 0)
        schedParts.push(`${data.scheduler.byOnce} once`);
      const schedBreakdown =
        schedParts.length > 0 ? ` (${schedParts.join(', ')})` : '';
      const nextDueStr = data.scheduler.nextDue
        ? `Next due: ${formatTime(data.scheduler.nextDue)}`
        : 'Next due: none';
      sections.push(
        `<b>-- Scheduler --</b>\n` +
          `Tasks: ${data.scheduler.total} total, ${data.scheduler.active} active, ${data.scheduler.paused} paused${schedBreakdown}\n` +
          nextDueStr,
      );

      // Code section
      const cleanStr = data.git.clean ? 'yes' : 'no';
      const upToDateStr =
        data.git.upToDate === null
          ? 'unknown'
          : data.git.upToDate
            ? 'yes'
            : 'no';
      sections.push(
        `<b>-- Code --</b>\n` +
          `Branch: ${data.git.branch} | Commit: <code>${data.git.commitShort}</code>\n` +
          `Last commit: ${data.git.commitAge}\n` +
          `Clean: ${cleanStr} | Up-to-date: ${upToDateStr}`,
      );

      // Run ledger section
      if (data.runStats.total > 0) {
        const ok = data.runStats.byStatus['acked'] || 0;
        const fail = data.runStats.byStatus['failed'] || 0;
        const dead = data.runStats.deadLetterCount;
        sections.push(
          `<b>-- Run Ledger --</b>\n` +
            `Total: ${data.runStats.total} | OK: ${ok} | Fail: ${fail} | Dead: ${dead}`,
        );
      }

      // Issues section
      if (data.issues.length > 0) {
        const issueLines = data.issues.map((issue) => `! ${issue}`).join('\n');
        sections.push(`<b>-- Issues --</b>\n${issueLines}`);
      } else {
        sections.push(`<b>-- Issues --</b>\nAll systems healthy`);
      }

      const header = '<b>System Diagnostic</b>\n\n';
      const body = sections.join('\n\n');
      ctx.reply(header + body, { parse_mode: 'HTML' }).catch(() => {
        ctx.reply(`System Diagnostic\n\n${body.replace(/<[^>]+>/g, '')}`);
      });
    });

    // Set bot menu commands so they appear in Telegram's UI
    this.bot.api
      .setMyCommands([
        { command: 'tasks', description: '查看定时任务列表' },
        { command: 'status', description: '系统状态仪表盘' },
        { command: 'doctor', description: '系统健康诊断' },
        { command: 'ping', description: '检查机器人是否在线' },
        { command: 'restart', description: '重启服务器' },
        { command: 'chatid', description: '获取当前聊天的注册 ID' },
      ])
      .catch((err) => {
        logger.warn({ err }, 'Failed to set bot commands menu');
      });

    this.bot.on('message:text', async (ctx) => {
      this.lastUpdateTime = Date.now();

      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // When the user replies to a message, prepend the quoted message as
      // context so the agent knows what the user is referring to.
      const reply = ctx.message.reply_to_message;
      if (reply) {
        const replyText = reply.text || reply.caption || '[non-text message]';
        const replyFrom =
          reply.from?.first_name || reply.from?.username || 'Unknown';
        content = `[Replying to ${replyFrom}: "${replyText}"]\n${content}`;
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        {
          chatJid,
          chatName,
          sender: senderName,
          preview: content.slice(0, 200),
        },
        'Telegram message received',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      this.lastUpdateTime = Date.now();
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // Handle photo messages — download the image and store with a reference
    this.bot.on('message:photo', async (ctx) => {
      this.lastUpdateTime = Date.now();
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption || '';
      const msgId = ctx.message.message_id.toString();

      // Download the highest-resolution photo
      let imagePath: string | undefined;
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const url =
          `https://api.telegram.org/file/bot${this.botToken}/` + file.file_path;

        const response = await fetch(url);
        if (response.ok) {
          const mediaDir = path.join(DATA_DIR, 'media');
          fs.mkdirSync(mediaDir, { recursive: true });
          const filename = `${chatJid.replace(':', '_')}-${msgId}.jpg`;
          const filePath = path.join(mediaDir, filename);
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(filePath, buffer);
          imagePath = filename;
          logger.info(
            { chatJid, msgId, size: buffer.length },
            'Photo downloaded',
          );
        }
      } catch (err) {
        logger.warn({ chatJid, msgId, err }, 'Failed to download photo');
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: caption || '[Photo]',
        timestamp,
        is_from_me: false,
        image_path: imagePath,
      });

      logger.info(
        {
          chatJid,
          sender: senderName,
          hasImage: !!imagePath,
          preview: (caption || '[Photo]').slice(0, 200),
        },
        'Telegram photo received',
      );
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle inline button clicks — feed button text as a regular inbound message
    this.bot.on('callback_query:data', async (ctx) => {
      this.lastUpdateTime = Date.now();

      // Dismiss the loading spinner on the button
      await ctx.answerCallbackQuery().catch((err) => {
        logger.debug({ err }, 'Failed to answer callback query');
      });

      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!chatId) return;
      const chatJid = `tg:${chatId}`;
      const messageId = ctx.callbackQuery.message?.message_id;

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const buttonText = ctx.callbackQuery.data;
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const timestamp = new Date().toISOString();
      const msgId = messageId?.toString() || '';

      // Remove the inline keyboard and append the selected option to the
      // original message so the user can see what they picked.
      if (messageId) {
        try {
          const originalText = (ctx.callbackQuery.message as any)?.text || '';
          const updatedHtml = toTelegramHtml(
            `${originalText}\n\n-- ${senderName}: ${buttonText}`,
          );
          await this.bot!.api.editMessageText(chatId, messageId, updatedHtml, {
            parse_mode: 'HTML',
          });
        } catch (err) {
          // Fallback: just remove the keyboard without changing text
          logger.debug(
            { chatJid, messageId, err },
            'Failed to edit message text after button click, removing keyboard only',
          );
          try {
            await this.bot!.api.editMessageReplyMarkup(chatId, messageId, {
              reply_markup: { inline_keyboard: [] },
            });
          } catch (rmErr) {
            logger.debug(
              { chatJid, messageId, err: rmErr },
              'Failed to remove inline keyboard',
            );
          }
        }
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: buttonText,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, sender: senderName, buttonText },
        'Telegram inline button clicked',
      );
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      const polling = this.bot!.start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );

          // Start watchdog to detect silent polling death.
          //
          // Sleep/wake detection: macOS sleep freezes timers. When the
          // system wakes, the 30s setInterval fires but the actual
          // wall-clock gap is minutes/hours. The Telegram long-poll
          // HTTP connection is dead at this point but grammY's
          // bot.isRunning() still returns true (it checks the object
          // state, not the socket). We detect the time jump and
          // exit so launchd restarts with a fresh connection.
          this.pollingWatchdog = setInterval(() => {
            const now = Date.now();
            const tickElapsed = now - this.lastWatchdogTick;
            this.lastWatchdogTick = now;

            // Watchdog runs every 30s. If >2 min elapsed between
            // ticks, the system was asleep.
            const SLEEP_THRESHOLD_MS = 2 * 60 * 1000;
            if (tickElapsed > SLEEP_THRESHOLD_MS) {
              logger.warn(
                { sleepDurationMs: tickElapsed, tickElapsed },
                'System sleep detected (wall-clock jump), forcing restart to reconnect Telegram',
              );
              process.exit(1);
            }

            if (this.bot && !this.bot.isRunning() && !this.stopping) {
              logger.fatal(
                'Telegram polling stopped unexpectedly, exiting for restart',
              );
              process.exit(1);
            }

            // Detect silently dead polling: if no updates received for an
            // extended period and there are registered groups, the HTTP
            // connection to Telegram is likely dead.
            //
            // IMPORTANT: Only treat silence as fatal when grammY's polling
            // loop has actually stopped. When bot.isRunning() is true the
            // long-poll connection is healthy — there are simply no new
            // messages. Exiting in that case causes an infinite restart
            // loop via launchd/systemd KeepAlive.
            if (!this.stopping) {
              const silenceMs = Date.now() - this.lastUpdateTime;
              const hasGroups =
                Object.keys(this.opts.registeredGroups()).length > 0;
              const pollingAlive = this.bot?.isRunning() ?? false;

              if (hasGroups && silenceMs > 10 * 60 * 1000 && !pollingAlive) {
                logger.fatal(
                  {
                    silenceMs,
                    lastUpdateTime: new Date(this.lastUpdateTime).toISOString(),
                  },
                  'No Telegram updates for 10+ minutes and polling stopped, exiting for restart',
                );
                process.exit(1);
              } else if (hasGroups && silenceMs > 30 * 60 * 1000) {
                // Polling is alive but 30+ minutes of silence is unusual —
                // log a warning but do NOT exit.
                logger.warn(
                  {
                    silenceMs,
                    lastUpdateTime: new Date(this.lastUpdateTime).toISOString(),
                    pollingAlive,
                  },
                  'No Telegram updates for 30+ minutes — polling appears alive, monitoring',
                );
              }
            }
          }, 30_000);

          resolve();
        },
      });

      // Catch fatal polling errors (409 Conflict, 401 Unauthorized, etc.)
      polling.catch((err) => {
        logger.fatal({ err }, 'Telegram polling loop crashed');
        process.exit(1);
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      const html = toTelegramHtml(text);
      const chunks: string[] = [];
      const source = html;

      if (source.length <= MAX_LENGTH) {
        chunks.push(source);
      } else {
        for (let i = 0; i < source.length; i += MAX_LENGTH) {
          chunks.push(source.slice(i, i + MAX_LENGTH));
        }
      }

      for (let ci = 0; ci < chunks.length; ci++) {
        const opts: Record<string, unknown> = { parse_mode: 'HTML' };
        // Only reply-to on the first chunk
        if (ci === 0 && replyToMessageId) {
          opts.reply_parameters = { message_id: Number(replyToMessageId) };
        }
        try {
          await withSendTimeout(
            this.bot.api.sendMessage(numericId, chunks[ci], opts),
            'sendMessage',
          );
        } catch {
          // Fallback: send as plain text if HTML parsing fails
          logger.debug(
            { jid },
            'HTML parse failed, falling back to plain text',
          );
          const fallbackOpts: Record<string, unknown> = {};
          if (ci === 0 && replyToMessageId) {
            fallbackOpts.reply_parameters = {
              message_id: Number(replyToMessageId),
            };
          }
          await withSendTimeout(
            this.bot.api.sendMessage(
              numericId,
              text.slice(0, MAX_LENGTH),
              fallbackOpts,
            ),
            'sendMessage',
          );
          break;
        }
      }
      logger.info(
        { jid, length: text.length, preview: text.slice(0, 200) },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendMessageWithButtons(
    jid: string,
    text: string,
    buttons: ButtonRows,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const html = toTelegramHtml(text);

      // Build grammY InlineKeyboard from ButtonRows
      const keyboard = new InlineKeyboard();
      for (const row of buttons) {
        for (const btn of row) {
          keyboard.text(btn.text, btn.text);
        }
        keyboard.row();
      }

      const opts: Record<string, unknown> = {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      };
      if (replyToMessageId) {
        opts.reply_parameters = { message_id: Number(replyToMessageId) };
      }

      try {
        await withSendTimeout(
          this.bot.api.sendMessage(numericId, html, opts),
          'sendMessageWithButtons',
        );
      } catch {
        // Fallback: send as plain text if HTML parsing fails
        logger.debug(
          { jid },
          'HTML parse failed in sendMessageWithButtons, falling back to plain text',
        );
        const fallbackOpts: Record<string, unknown> = {
          reply_markup: keyboard,
        };
        if (replyToMessageId) {
          fallbackOpts.reply_parameters = {
            message_id: Number(replyToMessageId),
          };
        }
        await withSendTimeout(
          this.bot.api.sendMessage(
            numericId,
            text.slice(0, 4096),
            fallbackOpts,
          ),
          'sendMessageWithButtons',
        );
      }

      logger.info(
        {
          jid,
          length: text.length,
          buttonCount: buttons.flat().length,
          preview: text.slice(0, 200),
        },
        'Telegram message with buttons sent',
      );
    } catch (err) {
      logger.error(
        { jid, err },
        'Failed to send Telegram message with buttons',
      );
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  getLastUpdateTime(): number {
    return this.lastUpdateTime;
  }

  async disconnect(): Promise<void> {
    this.stopping = true;

    // Clear polling watchdog
    if (this.pollingWatchdog) {
      clearInterval(this.pollingWatchdog);
      this.pollingWatchdog = null;
    }

    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;

    if (!isTyping) {
      // Stop the repeating typing indicator
      const existing = this.typingIntervals.get(jid);
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(jid);
      }
      return;
    }

    // Already typing for this chat — don't stack intervals
    if (this.typingIntervals.has(jid)) return;

    const numericId = jid.replace(/^tg:/, '');
    const sendAction = () => {
      this.bot?.api.sendChatAction(numericId, 'typing').catch((err) => {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      });
    };

    // Send immediately, then repeat every 4s (Telegram typing expires after 5s)
    sendAction();
    const interval = setInterval(sendAction, 4000);
    this.typingIntervals.set(jid, interval);
  }
}

/** Format a scheduled task's schedule into a readable string. */
function formatSchedule(task: ScheduledTask): string {
  switch (task.schedule_type) {
    case 'cron':
      return `Cron: ${task.schedule_value}`;
    case 'interval': {
      const ms = parseInt(task.schedule_value, 10);
      if (ms >= 86400000) return `每 ${Math.round(ms / 86400000)} 天`;
      if (ms >= 3600000) return `每 ${Math.round(ms / 3600000)} 小时`;
      if (ms >= 60000) return `每 ${Math.round(ms / 60000)} 分钟`;
      return `每 ${Math.round(ms / 1000)} 秒`;
    }
    case 'once':
      return '一次性';
    default:
      return task.schedule_type;
  }
}

/** Format an ISO timestamp into a short localized string (Asia/Shanghai). */
function formatTime(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Format milliseconds into a human-readable uptime string. */
function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" -> pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  replyToMessageId?: string,
): Promise<boolean> {
  if (poolApis.length === 0) {
    // No pool bots available — caller should fall back to main bot
    logger.warn(
      { sender, chatId },
      'No pool bots available, skipping pool message',
    );
    return false;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    const html = toTelegramHtml(text);
    const chunks: string[] = [];
    const source = html;

    if (source.length <= MAX_LENGTH) {
      chunks.push(source);
    } else {
      for (let i = 0; i < source.length; i += MAX_LENGTH) {
        chunks.push(source.slice(i, i + MAX_LENGTH));
      }
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      try {
        const opts: Record<string, unknown> = { parse_mode: 'HTML' };
        if (ci === 0 && replyToMessageId) {
          opts.reply_parameters = { message_id: Number(replyToMessageId) };
        }
        await withSendTimeout(
          api.sendMessage(numericId, chunks[ci], opts),
          'sendMessage(pool)',
        );
      } catch {
        // Fallback: send as plain text if HTML parsing fails
        logger.debug(
          { chatId, sender },
          'HTML parse failed in pool message, falling back to plain text',
        );
        const fallbackOpts: Record<string, unknown> = {};
        if (ci === 0 && replyToMessageId) {
          fallbackOpts.reply_parameters = {
            message_id: Number(replyToMessageId),
          };
        }
        await withSendTimeout(
          api.sendMessage(numericId, text.slice(0, MAX_LENGTH), fallbackOpts),
          'sendMessage(pool)',
        );
        break;
      }
    }
    logger.info(
      {
        chatId,
        sender,
        poolIndex: idx,
        length: text.length,
        preview: text.slice(0, 200),
      },
      'Pool message sent',
    );
    return true;
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
}
