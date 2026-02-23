import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
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
  html = html.replace(
    /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g,
    '<b>$1</b>',
  );

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

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRestart?: () => Promise<void>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

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
      logger.info({ chatId: ctx.chat.id, user: ctx.from?.first_name }, 'Restart triggered via /restart command');
      // Small delay so the reply is sent before shutting down
      setTimeout(() => this.opts.onRestart!(), 500);
    });

    // Set bot menu commands so they appear in Telegram's UI
    this.bot.api.setMyCommands([
      { command: 'restart', description: '重启服务器' },
      { command: 'ping', description: '检查机器人是否在线' },
      { command: 'chatid', description: '获取当前聊天的注册 ID' },
    ]).catch((err) => {
      logger.warn({ err }, 'Failed to set bot commands menu');
    });

    this.bot.on('message:text', async (ctx) => {
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
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
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

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
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

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string, replyToMessageId?: string): Promise<void> {
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
          await this.bot.api.sendMessage(numericId, chunks[ci], opts);
        } catch {
          // Fallback: send as plain text if HTML parsing fails
          logger.debug({ jid }, 'HTML parse failed, falling back to plain text');
          const fallbackOpts: Record<string, unknown> = {};
          if (ci === 0 && replyToMessageId) {
            fallbackOpts.reply_parameters = { message_id: Number(replyToMessageId) };
          }
          await this.bot.api.sendMessage(numericId, text.slice(0, MAX_LENGTH), fallbackOpts);
          break;
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
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
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots available — cannot send via pool
    logger.warn({ sender, chatId }, 'No pool bots available, skipping pool message');
    return;
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
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
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
        await api.sendMessage(numericId, chunks[ci], opts);
      } catch {
        // Fallback: send as plain text if HTML parsing fails
        logger.debug({ chatId, sender }, 'HTML parse failed in pool message, falling back to plain text');
        const fallbackOpts: Record<string, unknown> = {};
        if (ci === 0 && replyToMessageId) {
          fallbackOpts.reply_parameters = { message_id: Number(replyToMessageId) };
        }
        await api.sendMessage(numericId, text.slice(0, MAX_LENGTH), fallbackOpts);
        break;
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}
