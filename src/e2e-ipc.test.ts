/**
 * E2E Integration Tests: IPC delivery-ack dedup and error observability.
 *
 * Covers:
 *   - Delivery ack lifecycle (record, check, clear)
 *   - TTL eviction under map size threshold
 *   - Wrong-run isolation (no cross-contamination)
 *   - run_ledger error metadata population (stderr_excerpt, exit_code, etc.)
 *   - getRecentErrors / getErrorsByGroup query correctness
 *   - Acked-with-error runs visible in error queries
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { _initTestDatabase } from './db.js';
import {
  createRun,
  transitionRun,
  getRecentErrors,
  getErrorsByGroup,
} from './run-ledger.js';
import {
  recordDeliveryAck,
  wasDelivered,
  clearDeliveryAck,
  _resetForTest,
} from './delivery-ack.js';

// ---------------------------------------------------------------------------
// Delivery-ack lifecycle
// ---------------------------------------------------------------------------

describe('E2E: IPC delivery-ack dedup', () => {
  beforeEach(() => {
    _resetForTest();
    _initTestDatabase();
  });

  it('IPC delivery then crash: record, check, clear lifecycle', () => {
    const runId = 'run-ipc-crash-001';

    // Before recording, nothing is delivered
    expect(wasDelivered(runId)).toBe(false);

    // Simulate IPC watcher calling recordDeliveryAck after send_message
    recordDeliveryAck(runId);
    expect(wasDelivered(runId)).toBe(true);

    // After the dedup logic consumes the ack, clear it
    clearDeliveryAck(runId);
    expect(wasDelivered(runId)).toBe(false);
  });

  it('TTL eviction: stale entries are evicted when map exceeds 100', () => {
    // Record 101 entries with old timestamps by advancing Date.now()
    const realDateNow = Date.now;

    // Freeze time at a base point
    const baseTime = 1_700_000_000_000;
    let currentTime = baseTime;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    // Record 101 entries at the base time (these will become "old")
    for (let i = 0; i < 101; i++) {
      recordDeliveryAck(`stale-run-${i}`);
    }

    // Advance time by more than MAX_AGE_MS (10 minutes = 600_000 ms)
    currentTime = baseTime + 11 * 60 * 1000;

    // Record one more -- this triggers eviction because size > 100
    recordDeliveryAck('fresh-run');

    // All stale entries should be evicted
    for (let i = 0; i < 101; i++) {
      expect(wasDelivered(`stale-run-${i}`)).toBe(false);
    }

    // The fresh entry should still be present
    expect(wasDelivered('fresh-run')).toBe(true);

    vi.restoreAllMocks();
  });

  it('wrong-run contamination: run-A ack does not affect run-B', () => {
    const runA = 'run-A-isolated';
    const runB = 'run-B-isolated';

    recordDeliveryAck(runA);

    expect(wasDelivered(runA)).toBe(true);
    expect(wasDelivered(runB)).toBe(false);

    clearDeliveryAck(runA);

    expect(wasDelivered(runA)).toBe(false);
    expect(wasDelivered(runB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run_ledger error observability
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
