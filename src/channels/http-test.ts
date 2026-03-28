/**
 * HTTP Test Channel for NanoClaw
 *
 * A lightweight channel that exposes an HTTP server for sending messages
 * and receiving replies. Enables automated E2E testing of the full pipeline
 * (message -> container -> SDK -> reply) without needing Telegram or WhatsApp.
 *
 * Usage:
 *   Set HTTP_TEST_PORT=3100 in .env to enable.
 *   POST /message  { "text": "Hello", "sender": "tester" }
 *   GET  /replies   -> Returns collected replies as JSON array
 *   GET  /health    -> { "ok": true }
 *
 * JID format: http:<group-id>  (e.g., "http:test-main")
 *
 * For automated testing:
 *   1. Register a group with JID "http:test-main" and folder "http_test-main"
 *   2. POST /message with the text you want to send
 *   3. Poll GET /replies until you get a response (or use /wait endpoint)
 *   4. GET /wait?timeout=60 blocks until a reply arrives or timeout
 */

import http from 'http';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const DEFAULT_JID = 'http:test-main';

interface Reply {
  jid: string;
  text: string;
  replyToMessageId?: string;
  timestamp: string;
}

export class HttpTestChannel implements Channel {
  name = 'http-test';
  private server: http.Server | null = null;
  private port: number;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private replies: Reply[] = [];
  private waitResolvers: Array<(reply: Reply) => void> = [];

  constructor(port: number, opts: ChannelOpts) {
    this.port = port;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      // CORS for local development
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${this.port}`);

      if (req.method === 'POST' && url.pathname === '/message') {
        this.handlePostMessage(req, res);
      } else if (req.method === 'GET' && url.pathname === '/replies') {
        this.handleGetReplies(req, res);
      } else if (req.method === 'GET' && url.pathname === '/wait') {
        this.handleWait(req, res, url);
      } else if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            channel: 'http-test',
            replies: this.replies.length,
          }),
        );
      } else if (req.method === 'POST' && url.pathname === '/clear') {
        this.replies = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cleared: true }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'HTTP test channel listening');
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const reply: Reply = {
      jid,
      text,
      replyToMessageId,
      timestamp: new Date().toISOString(),
    };
    this.replies.push(reply);
    logger.debug(
      { jid, textLength: text.length },
      'HTTP test channel: reply collected',
    );

    // Resolve any waiting /wait requests
    for (const resolve of this.waitResolvers) {
      resolve(reply);
    }
    this.waitResolvers = [];
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('http:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  // --- HTTP handlers ---

  private handlePostMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const text = data.text as string;
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "text" field' }));
          return;
        }

        const jid = (data.jid as string) || DEFAULT_JID;
        const sender = (data.sender as string) || 'http-tester';
        const senderName = (data.sender_name as string) || sender;
        const msgId = `http-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const timestamp = new Date().toISOString();

        // Report chat metadata (so the system knows about this JID)
        this.onChatMetadata(jid, timestamp, 'HTTP Test', 'http-test', false);

        // Deliver the message
        const msg: NewMessage = {
          id: msgId,
          chat_jid: jid,
          sender,
          sender_name: senderName,
          content: text,
          timestamp,
          is_from_me: true,
        };
        this.onMessage(jid, msg);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messageId: msgId, jid }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleGetReplies(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.replies));
  }

  private handleWait(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): void {
    const timeoutSec = parseInt(url.searchParams.get('timeout') || '30', 10);
    const currentCount = this.replies.length;

    // If there are already new replies since the caller last checked, return immediately
    const sinceParam = url.searchParams.get('since');
    if (sinceParam) {
      const sinceCount = parseInt(sinceParam, 10);
      if (this.replies.length > sinceCount) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.replies.slice(sinceCount)));
        return;
      }
    }

    // Block until a new reply arrives or timeout
    const timer = setTimeout(() => {
      // Remove this resolver
      this.waitResolvers = this.waitResolvers.filter((r) => r !== resolver);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    }, timeoutSec * 1000);

    const resolver = (reply: Reply) => {
      clearTimeout(timer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([reply]));
    };

    this.waitResolvers.push(resolver);
  }
}

// --- Self-registration ---
// Enabled when HTTP_TEST_PORT is set in .env or environment
registerChannel('http-test', (opts) => {
  const envConfig = readEnvFile(['HTTP_TEST_PORT']);
  const portStr = process.env.HTTP_TEST_PORT || envConfig.HTTP_TEST_PORT || '';
  const port = parseInt(portStr, 10);
  if (!port || isNaN(port)) return null;
  return new HttpTestChannel(port, opts);
});
