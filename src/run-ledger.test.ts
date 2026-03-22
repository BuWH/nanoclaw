import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  createRun,
  getDeadLetters,
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
});
