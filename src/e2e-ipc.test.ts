/**
 * E2E Integration Tests: IPC delivery-ack dedup and error observability.
 *
 * Group 1 -- Full-pipeline mock tests (runContainerAgent + fake process):
 *   - Streaming output then crash: no duplicate delivery
 *   - Crash without any output: error metadata populated
 *   - Error includes exitCode, durationMs, stderrTail, logFile
 *
 * Group 2 -- run_ledger error observability:
 *   - getRecentErrors returns acked-with-error runs
 *   - getErrorsByGroup filters correctly
 *   - Error metadata stored in run_ledger and queryable
 *
 * Note: Delivery-ack unit tests (record/check/clear, TTL eviction,
 * wrong-run isolation) live in delivery-ack.test.ts.
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
  CONTAINER_MEMORY_LIMIT: '4g',
  CONTAINER_CPU_LIMIT: '2',
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-e2e-ipc-data',
  FIRST_OUTPUT_TIMEOUT: 3000,
  GROUPS_DIR: '/tmp/nanoclaw-e2e-ipc-groups',
  IDLE_TIMEOUT: 5000,
  MAIN_GROUP_FOLDER: 'main',
  STORE_DIR: '/tmp/nanoclaw-e2e-ipc-store',
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

vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false })),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn(),
    constants: {},
  };
  return { ...fsMock, default: fsMock };
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

vi.mock('child_process', () => ({
  spawn: vi.fn(() => fakeProc),
  exec: vi.fn(
    (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    },
  ),
}));

// --- Imports (must come after vi.mock calls) ---

import { _initTestDatabase } from './db.js';
import {
  createRun,
  transitionRun,
  getRecentErrors,
  getErrorsByGroup,
} from './run-ledger.js';
import { _resetForTest } from './delivery-ack.js';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

// --- Test fixtures ---

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2025-01-01T00:00:00.000Z',
};

function emitOutput(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

// ---------------------------------------------------------------------------
// Group 1: Full-pipeline mock tests (runContainerAgent + fake process)
// ---------------------------------------------------------------------------

describe('E2E: Full-pipeline IPC dedup scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    _resetForTest();
    _initTestDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('container sends streaming output then crashes: no duplicate', async () => {
    // Track whether onOutput was called (simulates message delivery)
    const deliveries: ContainerOutput[] = [];

    const agentPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test prompt',
        groupFolder: testGroup.folder,
        chatJid: 'tg:123',
        isMain: false,
      },
      () => {}, // onProcess: no-op
      async (result) => {
        // Streaming callback: record delivery
        deliveries.push(result);
      },
    );

    // Let spawn happen
    await vi.advanceTimersByTime(10);

    // Container emits a success result via stdout markers
    emitOutput(fakeProc, {
      status: 'success',
      result: 'Here is the answer',
      newSessionId: 'session-crash-001',
    });

    // Let the streaming output be processed
    await vi.advanceTimersByTime(10);

    // Container crashes with OOM kill (code 137)
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTime(10);

    const output = await agentPromise;

    // The streaming callback was invoked exactly once with the result
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].result).toBe('Here is the answer');

    // Container exited with error code, but the output was already streamed
    // The container-runner reports error because exit code != 0
    expect(output.status).toBe('error');
    expect(output.exitCode).toBe(137);
  });

  it('container crashes without any output: error returned', async () => {
    const deliveries: ContainerOutput[] = [];

    const agentPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test prompt',
        groupFolder: testGroup.folder,
        chatJid: 'tg:456',
        isMain: false,
      },
      () => {},
      async (result) => {
        deliveries.push(result);
      },
    );

    await vi.advanceTimersByTime(10);

    // Push some stderr before crash
    fakeProc.stderr.push('Killed\n');
    await vi.advanceTimersByTime(10);

    // Container crashes immediately with code 137, no stdout output
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTime(10);

    const output = await agentPromise;

    // No streaming output was delivered
    expect(deliveries).toHaveLength(0);

    // Error metadata is populated
    expect(output.status).toBe('error');
    expect(output.exitCode).toBe(137);
    expect(output.error).toContain('Container exited with code 137');
    expect(output.stderrTail).toContain('Killed');
    expect(output.logFile).toBeDefined();
    expect(output.logFile).toContain('.log');
  });

  it('container error includes exitCode, durationMs, stderrTail, logFile', async () => {
    const agentPromise = runContainerAgent(
      testGroup,
      {
        prompt: 'test prompt for metadata',
        groupFolder: testGroup.folder,
        chatJid: 'tg:789',
        isMain: false,
      },
      () => {},
    );

    await vi.advanceTimersByTime(10);

    // Push stderr content
    fakeProc.stderr.push('Error: something went wrong\nStack trace here\n');
    await vi.advanceTimersByTime(10);

    // Container exits with code 1
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTime(10);

    const output = await agentPromise;

    expect(output.status).toBe('error');
    expect(output.exitCode).toBe(1);
    expect(typeof output.durationMs).toBe('number');
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
    expect(output.stderrTail).toContain('Error: something went wrong');
    expect(output.stderrTail).toContain('Stack trace here');
    expect(output.logFile).toBeDefined();
    expect(typeof output.logFile).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Group 2: run_ledger error observability
// ---------------------------------------------------------------------------

describe('E2E: run_ledger error metadata and queries', () => {
  beforeEach(() => {
    _resetForTest();
    _initTestDatabase();
  });

  it('getRecentErrors returns acked-with-error runs', () => {
    // Create a run and transition it through to acked with an error field set
    const run = createRun('message', 'tg:group-1', 'test-group', 'hello');
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'acked', {
      error: 'Container OOM killed',
      exit_code: 137,
      stderr_excerpt: 'Killed',
      duration_ms: 4500,
      log_file: '/logs/run-001.log',
      ipc_delivered: 1,
    });

    const errors = getRecentErrors(10);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const found = errors.find((e) => e.id === run.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('acked');
    expect(found!.error).toBe('Container OOM killed');
    expect(found!.exit_code).toBe(137);
    expect(found!.stderr_excerpt).toBe('Killed');
    expect(found!.duration_ms).toBe(4500);
    expect(found!.log_file).toBe('/logs/run-001.log');
    expect(found!.ipc_delivered).toBe(1);
  });

  it('getErrorsByGroup filters correctly', () => {
    // Create two runs in different groups, both with errors
    const runA = createRun('message', 'tg:group-a', 'group-alpha', 'msg-a');
    transitionRun(runA.id, 'running');
    transitionRun(runA.id, 'failed', {
      error: 'Timeout in group-alpha',
      exit_code: 1,
    });

    const runB = createRun('message', 'tg:group-b', 'group-beta', 'msg-b');
    transitionRun(runB.id, 'running');
    transitionRun(runB.id, 'failed', {
      error: 'Crash in group-beta',
      exit_code: 2,
    });

    // Query for group-alpha only
    const alphaErrors = getErrorsByGroup('group-alpha', 10);
    expect(alphaErrors.length).toBe(1);
    expect(alphaErrors[0].id).toBe(runA.id);
    expect(alphaErrors[0].error).toBe('Timeout in group-alpha');

    // Query for group-beta only
    const betaErrors = getErrorsByGroup('group-beta', 10);
    expect(betaErrors.length).toBe(1);
    expect(betaErrors[0].id).toBe(runB.id);
    expect(betaErrors[0].error).toBe('Crash in group-beta');

    // Query for non-existent group returns empty
    const noErrors = getErrorsByGroup('group-gamma', 10);
    expect(noErrors).toHaveLength(0);
  });

  it('error metadata is stored in run_ledger and queryable', () => {
    const run = createRun('message', 'tg:group-meta', 'meta-group', 'payload');
    transitionRun(run.id, 'running');

    const updated = transitionRun(run.id, 'failed', {
      stderr_excerpt: 'Error: ENOMEM\nCannot allocate memory',
      exit_code: 137,
      duration_ms: 12345,
      log_file: '/var/log/nanoclaw/run-xyz.log',
      error: 'Container killed by OOM',
    });

    expect(updated).not.toBeNull();
    expect(updated!.stderr_excerpt).toBe(
      'Error: ENOMEM\nCannot allocate memory',
    );
    expect(updated!.exit_code).toBe(137);
    expect(updated!.duration_ms).toBe(12345);
    expect(updated!.log_file).toBe('/var/log/nanoclaw/run-xyz.log');
    expect(updated!.error).toBe('Container killed by OOM');
    expect(updated!.status).toBe('failed');

    // Verify via getRecentErrors query
    const errors = getRecentErrors(10);
    const found = errors.find((e) => e.id === run.id);
    expect(found).toBeDefined();
    expect(found!.stderr_excerpt).toBe('Error: ENOMEM\nCannot allocate memory');
    expect(found!.exit_code).toBe(137);
    expect(found!.duration_ms).toBe(12345);
    expect(found!.log_file).toBe('/var/log/nanoclaw/run-xyz.log');
  });
});
