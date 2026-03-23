import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  createRun,
  getDeadLetters,
  getErrorsByGroup,
  getRecentErrors,
  getRunHistory,
  getRunStats,
  pruneOldRuns,
  retryDeadLetter,
  transitionRun,
} from './run-ledger.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('createRun', () => {
  it('creates entry with correct defaults', () => {
    const run = createRun('message', 'group@g.us', 'main', 'hello world');
    expect(run.id).toBeTruthy();
    expect(run.type).toBe('message');
    expect(run.group_jid).toBe('group@g.us');
    expect(run.group_folder).toBe('main');
    expect(run.status).toBe('queued');
    expect(run.payload).toBe('hello world');
    expect(run.result).toBeNull();
    expect(run.error).toBeNull();
    expect(run.retry_count).toBe(0);
    expect(run.max_retries).toBe(3);
    expect(run.created_at).toBeTruthy();
    expect(run.updated_at).toBeTruthy();
  });

  it('truncates payload to MAX_PAYLOAD_LENGTH', () => {
    const longPayload = 'x'.repeat(5000);
    const run = createRun('message', 'group@g.us', 'main', longPayload);
    expect(run.payload!.length).toBe(4096);
  });

  it('handles null payload', () => {
    const run = createRun('task', 'group@g.us', 'main', null);
    expect(run.payload).toBeNull();
  });

  it('accepts custom maxRetries', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test', 5);
    expect(run.max_retries).toBe(5);
  });
});

describe('transitionRun', () => {
  it('follows valid transitions: queued -> running -> streaming -> reply_sent -> acked', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test');

    const r1 = transitionRun(run.id, 'running');
    expect(r1!.status).toBe('running');

    const r2 = transitionRun(run.id, 'streaming');
    expect(r2!.status).toBe('streaming');

    const r3 = transitionRun(run.id, 'reply_sent');
    expect(r3!.status).toBe('reply_sent');

    const r4 = transitionRun(run.id, 'acked');
    expect(r4!.status).toBe('acked');
  });

  it('rejects invalid transitions', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test');
    // queued -> acked is not valid
    const result = transitionRun(run.id, 'acked');
    expect(result).toBeNull();
  });

  it('rejects transition from acked (terminal state)', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test');
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'streaming');
    transitionRun(run.id, 'reply_sent');
    transitionRun(run.id, 'acked');

    const result = transitionRun(run.id, 'running');
    expect(result).toBeNull();
  });

  it('allows running -> acked for tasks that complete without streaming', () => {
    const run = createRun('task', 'group@g.us', 'main', 'test');
    transitionRun(run.id, 'running');

    const result = transitionRun(run.id, 'acked');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('acked');
  });

  it('transitions from running to failed on consecutive failure skip path', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test', 0);
    transitionRun(run.id, 'running');

    // Simulates the consecutive-failure skip path in processGroupMessages
    const result = transitionRun(run.id, 'failed', {
      error: 'Consecutive failures — messages skipped to break retry loop',
    });
    // maxRetries=0 so auto-promotes to dead_letter
    expect(result).not.toBeNull();
    expect(result!.status).toBe('dead_letter');
    expect(result!.error).toBe(
      'Consecutive failures — messages skipped to break retry loop',
    );
  });

  it('auto-promotes failed to dead_letter when retryCount >= maxRetries', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test', 0);
    // maxRetries=0, retryCount=0, so 0 >= 0 is true
    transitionRun(run.id, 'running');
    const result = transitionRun(run.id, 'failed', {
      error: 'container crash',
    });
    expect(result!.status).toBe('dead_letter');
    expect(result!.error).toBe('container crash');
  });

  it('stays as failed when retryCount < maxRetries', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test', 3);
    transitionRun(run.id, 'running');
    const result = transitionRun(run.id, 'failed', { error: 'timeout' });
    expect(result!.status).toBe('failed');
    expect(result!.error).toBe('timeout');
  });

  it('returns null for non-existent run', () => {
    const result = transitionRun('non-existent-id', 'running');
    expect(result).toBeNull();
  });

  it('preserves existing result/error when updates not provided', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test');
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'streaming');
    const r = transitionRun(run.id, 'reply_sent', { result: 'some output' });
    expect(r!.result).toBe('some output');

    // Transition to acked without providing updates
    const r2 = transitionRun(run.id, 'acked');
    expect(r2!.result).toBe('some output');
  });
});

describe('getDeadLetters', () => {
  it('returns only dead_letter entries', () => {
    // Create one that ends as dead_letter
    const run1 = createRun('message', 'group@g.us', 'main', 'test1', 0);
    transitionRun(run1.id, 'running');
    transitionRun(run1.id, 'failed', { error: 'crash' });
    // maxRetries=0 => auto-promoted to dead_letter

    // Create one that ends as acked
    const run2 = createRun('message', 'group@g.us', 'main', 'test2');
    transitionRun(run2.id, 'running');
    transitionRun(run2.id, 'streaming');
    transitionRun(run2.id, 'reply_sent');
    transitionRun(run2.id, 'acked');

    const deadLetters = getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].id).toBe(run1.id);
    expect(deadLetters[0].status).toBe('dead_letter');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      const run = createRun('message', 'group@g.us', 'main', `test${i}`, 0);
      transitionRun(run.id, 'running');
      transitionRun(run.id, 'failed');
    }
    const deadLetters = getDeadLetters(2);
    expect(deadLetters).toHaveLength(2);
  });
});

describe('retryDeadLetter', () => {
  it('transitions from dead_letter to queued', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test', 0);
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'failed', { error: 'crash' });
    // Now in dead_letter due to maxRetries=0

    const retried = retryDeadLetter(run.id);
    expect(retried!.status).toBe('queued');
    expect(retried!.retry_count).toBe(1);
    expect(retried!.error).toBeNull();
  });

  it('returns null for non-dead_letter entry', () => {
    const run = createRun('message', 'group@g.us', 'main', 'test');
    const result = retryDeadLetter(run.id);
    expect(result).toBeNull();
  });

  it('returns null for non-existent id', () => {
    const result = retryDeadLetter('non-existent');
    expect(result).toBeNull();
  });
});

describe('getRunHistory', () => {
  it('returns all runs when no groupJid filter', () => {
    createRun('message', 'group1@g.us', 'main', 'test1');
    createRun('message', 'group2@g.us', 'other', 'test2');

    const history = getRunHistory();
    expect(history).toHaveLength(2);
  });

  it('filters by groupJid', () => {
    createRun('message', 'group1@g.us', 'main', 'test1');
    createRun('message', 'group2@g.us', 'other', 'test2');

    const history = getRunHistory('group1@g.us');
    expect(history).toHaveLength(1);
    expect(history[0].group_jid).toBe('group1@g.us');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      createRun('message', 'group@g.us', 'main', `test${i}`);
    }
    const history = getRunHistory(undefined, 2);
    expect(history).toHaveLength(2);
  });
});

describe('getRunStats', () => {
  it('returns correct counts by status', () => {
    // Create 2 runs: one acked, one dead_letter
    const run1 = createRun('message', 'group@g.us', 'main', 'test1');
    transitionRun(run1.id, 'running');
    transitionRun(run1.id, 'streaming');
    transitionRun(run1.id, 'reply_sent');
    transitionRun(run1.id, 'acked');

    const run2 = createRun('message', 'group@g.us', 'main', 'test2', 0);
    transitionRun(run2.id, 'running');
    transitionRun(run2.id, 'failed');
    // auto-promoted to dead_letter

    // One still queued
    createRun('task', 'group@g.us', 'main', 'test3');

    const stats = getRunStats();
    expect(stats.total).toBe(3);
    expect(stats.byStatus['acked']).toBe(1);
    expect(stats.byStatus['dead_letter']).toBe(1);
    expect(stats.byStatus['queued']).toBe(1);
    expect(stats.deadLetterCount).toBe(1);
  });

  it('returns empty stats when no runs exist', () => {
    const stats = getRunStats();
    expect(stats.total).toBe(0);
    expect(stats.deadLetterCount).toBe(0);
    expect(Object.keys(stats.byStatus)).toHaveLength(0);
  });
});

describe('pruneOldRuns', () => {
  it('removes old acked and dead_letter entries', () => {
    // Create old run (manipulate updated_at to be 10 days ago)
    const run1 = createRun('message', 'group@g.us', 'main', 'old1');
    transitionRun(run1.id, 'running');
    transitionRun(run1.id, 'streaming');
    transitionRun(run1.id, 'reply_sent');
    transitionRun(run1.id, 'acked');

    // Manually set updated_at to 10 days ago
    const oldDate = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    getDb()
      .prepare('UPDATE run_ledger SET updated_at = ? WHERE id = ?')
      .run(oldDate, run1.id);

    // Create recent run
    const run2 = createRun('message', 'group@g.us', 'main', 'recent');
    transitionRun(run2.id, 'running');
    transitionRun(run2.id, 'streaming');
    transitionRun(run2.id, 'reply_sent');
    transitionRun(run2.id, 'acked');

    const pruned = pruneOldRuns(7);
    expect(pruned).toBe(1);

    // Recent run should still exist
    const history = getRunHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(run2.id);
  });

  it('does not remove active runs even if old', () => {
    const run = createRun('message', 'group@g.us', 'main', 'active');
    // Still in 'queued' state

    const oldDate = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    getDb()
      .prepare('UPDATE run_ledger SET updated_at = ? WHERE id = ?')
      .run(oldDate, run.id);

    const pruned = pruneOldRuns(7);
    expect(pruned).toBe(0);

    const history = getRunHistory();
    expect(history).toHaveLength(1);
  });

  it('removes old failed entries', () => {
    const run = createRun('message', 'group@g.us', 'main', 'failed-old', 3);
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'failed', { error: 'some error' });

    // Set updated_at to 10 days ago
    const oldDate = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    getDb()
      .prepare('UPDATE run_ledger SET updated_at = ? WHERE id = ?')
      .run(oldDate, run.id);

    const pruned = pruneOldRuns(7);
    expect(pruned).toBe(1);

    const history = getRunHistory();
    expect(history).toHaveLength(0);
  });
});

describe('error observability fields', () => {
  it('stores stderr_excerpt, exit_code, duration_ms, log_file, ipc_delivered on transition', () => {
    const run = createRun('message', 'tg:test', 'test-group', 'test payload');
    transitionRun(run.id, 'running');
    const result = transitionRun(run.id, 'failed', {
      error: 'OOM killed',
      stderr_excerpt: 'Cannot allocate memory',
      exit_code: 137,
      duration_ms: 5000,
      log_file: '/logs/test.log',
    });
    expect(result).not.toBeNull();
    expect(result!.stderr_excerpt).toBe('Cannot allocate memory');
    expect(result!.exit_code).toBe(137);
    expect(result!.duration_ms).toBe(5000);
    expect(result!.log_file).toBe('/logs/test.log');
    expect(result!.ipc_delivered).toBe(0);
  });

  it('stores ipc_delivered flag on acked runs', () => {
    const run = createRun('message', 'tg:test', 'test-group', 'test payload');
    transitionRun(run.id, 'running');
    const result = transitionRun(run.id, 'acked', {
      error: 'crashed after send',
      ipc_delivered: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe('acked');
    expect(result!.ipc_delivered).toBe(1);
    expect(result!.error).toBe('crashed after send');
  });

  it('preserves existing metadata fields when updating only some', () => {
    const run = createRun('message', 'tg:test', 'test-group', 'payload');
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'failed', {
      exit_code: 1,
      stderr_excerpt: 'initial error',
    });
    // The second transition should keep the original fields since failed->dead_letter is invalid
    // but we can verify the stored values directly
    const errors = getRecentErrors(10);
    const found = errors.find((e) => e.id === run.id);
    expect(found).toBeDefined();
    expect(found!.exit_code).toBe(1);
    expect(found!.stderr_excerpt).toBe('initial error');
  });
});

describe('getRecentErrors', () => {
  it('returns runs with errors ordered by updated_at DESC', () => {
    const run1 = createRun('message', 'tg:g1', 'group-1', 'p1');
    transitionRun(run1.id, 'running');
    transitionRun(run1.id, 'failed', { error: 'first' });

    // Force run1 to have an older updated_at so ordering is deterministic
    getDb()
      .prepare('UPDATE run_ledger SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 5000).toISOString(), run1.id);

    const run2 = createRun('message', 'tg:g2', 'group-2', 'p2');
    transitionRun(run2.id, 'running');
    transitionRun(run2.id, 'failed', { error: 'second' });

    const errors = getRecentErrors(10);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    const idx1 = errors.findIndex((e) => e.id === run1.id);
    const idx2 = errors.findIndex((e) => e.id === run2.id);
    expect(idx2).toBeLessThan(idx1); // run2 updated later
  });

  it('includes acked-with-error runs', () => {
    const run = createRun('message', 'tg:g1', 'group-1', 'p1');
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'acked', { error: 'crashed after reply' });

    const errors = getRecentErrors(10);
    const found = errors.find((e) => e.id === run.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('acked');
  });

  it('includes runs with exit_code but no error string', () => {
    const run = createRun('message', 'tg:g1', 'group-1', 'p1');
    transitionRun(run.id, 'running');
    transitionRun(run.id, 'acked', { exit_code: 137 });

    const errors = getRecentErrors(10);
    const found = errors.find((e) => e.id === run.id);
    expect(found).toBeDefined();
    expect(found!.exit_code).toBe(137);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      const run = createRun('message', 'tg:g1', 'group-1', `p${i}`);
      transitionRun(run.id, 'running');
      transitionRun(run.id, 'failed', { error: `err-${i}` });
    }
    const errors = getRecentErrors(3);
    expect(errors).toHaveLength(3);
  });

  it('excludes successful runs without errors', () => {
    const good = createRun('message', 'tg:g1', 'group-1', 'ok');
    transitionRun(good.id, 'running');
    transitionRun(good.id, 'acked');

    const bad = createRun('message', 'tg:g1', 'group-1', 'fail');
    transitionRun(bad.id, 'running');
    transitionRun(bad.id, 'failed', { error: 'oops' });

    const errors = getRecentErrors(10);
    expect(errors.find((e) => e.id === good.id)).toBeUndefined();
    expect(errors.find((e) => e.id === bad.id)).toBeDefined();
  });
});

describe('getErrorsByGroup', () => {
  it('filters errors by group_folder', () => {
    const runA = createRun('message', 'tg:a', 'alpha', 'pa');
    transitionRun(runA.id, 'running');
    transitionRun(runA.id, 'failed', { error: 'alpha-err' });

    const runB = createRun('message', 'tg:b', 'beta', 'pb');
    transitionRun(runB.id, 'running');
    transitionRun(runB.id, 'failed', { error: 'beta-err' });

    expect(getErrorsByGroup('alpha', 10)).toHaveLength(1);
    expect(getErrorsByGroup('beta', 10)).toHaveLength(1);
    expect(getErrorsByGroup('gamma', 10)).toHaveLength(0);
  });
});
