/**
 * E2E Integration Test: Message Receive -> Container Process -> Reply
 *
 * Exercises the full message pipeline using real modules (SQLite, router,
 * container-runner) with minimal mocks at system boundaries only:
 *   - child_process.spawn (fake container process)
 *   - Channel (sendMessage, setTyping)
 *   - fs (partial: IPC dirs, group folders)
 *   - config (test paths, short timeouts)
 *   - logger (silent)
 *
 * Since processGroupMessages is private in index.ts, we replicate the
 * orchestration wiring directly: store -> query -> format -> container -> assert.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// --- Sentinel markers (must match container-runner.ts) ---
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// --- Mocks at system boundaries ---

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 5000,
  DATA_DIR: '/tmp/nanoclaw-e2e-data',
  FIRST_OUTPUT_TIMEOUT: 3000,
  GROUPS_DIR: '/tmp/nanoclaw-e2e-groups',
  IDLE_TIMEOUT: 5000,
  MAIN_GROUP_FOLDER: 'main',
  STORE_DIR: '/tmp/nanoclaw-e2e-store',
  TIMEZONE: 'UTC',
  TRIGGER_PATTERN: /^@Andy\b/i,
  MAX_CONCURRENT_CONTAINERS: 2,
  POLL_INTERVAL: 2000,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
  loadMountAllowlist: vi.fn(() => null),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// --- Fake process for spawn ---

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

// --- Imports (must come after vi.mock calls) ---

import { _initTestDatabase, storeMessage, getMessagesSince, storeChatMetadata } from './db.js';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { formatMessages, formatOutbound } from './router.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

// --- Test fixtures ---

const TEST_CHAT_JID = 'tg:123';
const ASSISTANT_NAME = 'Andy';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2025-01-01T00:00:00.000Z',
};

function createMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chat_jid: TEST_CHAT_JID,
    sender: 'user1@example.com',
    sender_name: 'Alice',
    content: '@Andy what is 2+2?',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function createChannel(): Channel & {
  sendMessage: ReturnType<typeof vi.fn>;
  setTyping: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'test-channel',
    connect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid === TEST_CHAT_JID),
    disconnect: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
  };
}

function emitOutput(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

// --- Orchestration helper ---
// Replicates processGroupMessages wiring without importing private function

async function runPipeline(
  group: RegisteredGroup,
  chatJid: string,
  channel: Channel,
  sinceTimestamp: string,
): Promise<{
  output: ContainerOutput;
  sentMessages: Array<{ jid: string; text: string; replyToId?: string }>;
}> {
  const sentMessages: Array<{ jid: string; text: string; replyToId?: string }> = [];

  // 1. Query messages from real DB
  const messages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
  if (messages.length === 0) {
    return {
      output: { status: 'success', result: null },
      sentMessages,
    };
  }

  // 2. Format via real formatMessages
  const prompt = formatMessages(messages);
  const lastMessageId = messages[0].id;

  // 3. Run through real container-runner with mocked spawn
  const output = await runContainerAgent(
    group,
    {
      prompt,
      groupFolder: group.folder,
      chatJid,
      isMain: false,
    },
    () => {}, // onProcess: no-op
    async (result) => {
      // Streaming callback: same logic as index.ts processGroupMessages
      if (result.result) {
        const text = formatOutbound(result.result);
        if (text) {
          sentMessages.push({ jid: chatJid, text, replyToId: lastMessageId });
          await channel.sendMessage(chatJid, text, lastMessageId);
        }
      }
    },
  );

  return { output, sentMessages };
}

// --- Tests ---

describe('E2E: Message Receive -> Container Process -> Reply', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    _initTestDatabase();
    // Ensure the chat JID exists so storeMessage FK constraint is satisfied
    storeChatMetadata(TEST_CHAT_JID, '2025-01-01T00:00:00.000Z', 'Test Group', 'telegram', true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes a triggered message and sends reply to channel', async () => {
    const channel = createChannel();
    const msg = createMessage({
      id: 'msg-trigger-1',
      content: '@Andy what is 2+2?',
      timestamp: '2025-06-01T10:00:00.000Z',
    });
    storeMessage(msg);

    const pipelinePromise = runPipeline(testGroup, TEST_CHAT_JID, channel, '');

    // Let spawn happen
    await vi.advanceTimersByTimeAsync(10);

    // Fake container emits success
    emitOutput(fakeProc, {
      status: 'success',
      result: 'The answer is 4',
      newSessionId: 'session-001',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Container exits normally
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const { output, sentMessages } = await pipelinePromise;

    expect(output.status).toBe('success');
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].jid).toBe(TEST_CHAT_JID);
    expect(sentMessages[0].text).toBe('The answer is 4');
    expect(sentMessages[0].replyToId).toBe('msg-trigger-1');
    expect(channel.sendMessage).toHaveBeenCalledWith(
      TEST_CHAT_JID,
      'The answer is 4',
      'msg-trigger-1',
    );
  });

  it('formats multiple pending messages into XML prompt', async () => {
    const channel = createChannel();

    // Store 3 messages from different senders
    const messages = [
      createMessage({
        id: 'msg-multi-1',
        sender_name: 'Alice',
        content: '@Andy help me with this',
        timestamp: '2025-06-01T10:00:00.000Z',
      }),
      createMessage({
        id: 'msg-multi-2',
        sender_name: 'Bob',
        content: 'I agree, we need help',
        timestamp: '2025-06-01T10:00:01.000Z',
      }),
      createMessage({
        id: 'msg-multi-3',
        sender_name: 'Charlie',
        content: 'Me too!',
        timestamp: '2025-06-01T10:00:02.000Z',
      }),
    ];
    for (const msg of messages) {
      storeMessage(msg);
    }

    // Capture what gets written to stdin
    let stdinData = '';
    fakeProc.stdin.on('data', (chunk: Buffer) => {
      stdinData += chunk.toString();
    });

    const pipelinePromise = runPipeline(testGroup, TEST_CHAT_JID, channel, '');

    await vi.advanceTimersByTimeAsync(10);

    // Emit output and close
    emitOutput(fakeProc, { status: 'success', result: 'Got it!' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await pipelinePromise;

    // Parse the container input from stdin
    const containerInput = JSON.parse(stdinData);
    const prompt = containerInput.prompt;

    // Assert XML structure contains all 3 messages
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="Alice"');
    expect(prompt).toContain('sender="Bob"');
    expect(prompt).toContain('sender="Charlie"');
    expect(prompt).toContain('@Andy help me with this');
    expect(prompt).toContain('I agree, we need help');
    expect(prompt).toContain('Me too!');
  });

  it('strips <internal> tags from agent response', async () => {
    const channel = createChannel();
    const msg = createMessage({
      id: 'msg-internal-1',
      content: '@Andy tell me a fact',
      timestamp: '2025-06-01T10:00:00.000Z',
    });
    storeMessage(msg);

    const pipelinePromise = runPipeline(testGroup, TEST_CHAT_JID, channel, '');

    await vi.advanceTimersByTimeAsync(10);

    // Container emits response with internal tags
    emitOutput(fakeProc, {
      status: 'success',
      result: '<internal>thinking step</internal>The answer is 4',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const { sentMessages } = await pipelinePromise;

    // Internal tags should be stripped
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe('The answer is 4');
    expect(channel.sendMessage).toHaveBeenCalledWith(
      TEST_CHAT_JID,
      'The answer is 4',
      'msg-internal-1',
    );
  });

  it('handles container error without sending reply', async () => {
    const channel = createChannel();
    const msg = createMessage({
      id: 'msg-error-1',
      content: '@Andy crash please',
      timestamp: '2025-06-01T10:00:00.000Z',
    });
    storeMessage(msg);

    const pipelinePromise = runPipeline(testGroup, TEST_CHAT_JID, channel, '');

    await vi.advanceTimersByTimeAsync(10);

    // Container exits with error code (no output emitted)
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const { output, sentMessages } = await pipelinePromise;

    expect(output.status).toBe('error');
    expect(output.error).toContain('Container exited with code 1');
    expect(sentMessages).toHaveLength(0);
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('container timeout triggers error path', async () => {
    const channel = createChannel();
    const msg = createMessage({
      id: 'msg-timeout-1',
      content: '@Andy do something slow',
      timestamp: '2025-06-01T10:00:00.000Z',
    });
    storeMessage(msg);

    const pipelinePromise = runPipeline(testGroup, TEST_CHAT_JID, channel, '');

    await vi.advanceTimersByTimeAsync(10);

    // No output emitted -- advance past FIRST_OUTPUT_TIMEOUT (3000ms)
    // This triggers the first-output timeout, which calls killOnTimeout()
    await vi.advanceTimersByTimeAsync(3000);

    // The kill triggers close event
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const { output, sentMessages } = await pipelinePromise;

    expect(output.status).toBe('error');
    expect(output.error).toContain('timed out');
    expect(sentMessages).toHaveLength(0);
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});
