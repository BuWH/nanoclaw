import crypto from 'crypto';

import { getDb } from './db.js';
import { logger } from './logger.js';

// Run states
export type RunStatus =
  | 'queued'
  | 'running'
  | 'streaming'
  | 'reply_sent'
  | 'acked'
  | 'failed'
  | 'dead_letter';
export type RunType = 'message' | 'task';

export interface RunEntry {
  id: string;
  type: RunType;
  group_jid: string;
  group_folder: string;
  status: RunStatus;
  payload: string | null;
  result: string | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
}

const MAX_PAYLOAD_LENGTH = 4096;

// Valid state transitions
const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running'],
  running: ['streaming', 'failed'],
  streaming: ['reply_sent', 'failed'],
  reply_sent: ['acked', 'failed'],
  acked: [],
  failed: ['dead_letter', 'queued'],
  dead_letter: ['queued'],
};

export function createRun(
  type: RunType,
  groupJid: string,
  groupFolder: string,
  payload: string | null,
  maxRetries: number = 3,
): RunEntry {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const truncatedPayload = payload
    ? payload.slice(0, MAX_PAYLOAD_LENGTH)
    : null;

  db.prepare(
    `INSERT INTO run_ledger (id, type, group_jid, group_folder, status, payload, result, error, retry_count, max_retries, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, ?, ?, ?)`,
  ).run(
    id,
    type,
    groupJid,
    groupFolder,
    truncatedPayload,
    maxRetries,
    now,
    now,
  );

  return {
    id,
    type,
    group_jid: groupJid,
    group_folder: groupFolder,
    status: 'queued',
    payload: truncatedPayload,
    result: null,
    error: null,
    retry_count: 0,
    max_retries: maxRetries,
    created_at: now,
    updated_at: now,
  };
}

export function transitionRun(
  id: string,
  newStatus: RunStatus,
  updates?: { result?: string; error?: string },
): RunEntry | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM run_ledger WHERE id = ?').get(id) as
    | RunEntry
    | undefined;

  if (!row) {
    logger.warn({ runId: id, newStatus }, 'Run not found for transition');
    return null;
  }

  const currentStatus = row.status as RunStatus;
  const allowed = VALID_TRANSITIONS[currentStatus];

  if (!allowed || !allowed.includes(newStatus)) {
    logger.warn(
      { runId: id, from: currentStatus, to: newStatus },
      'Invalid run state transition',
    );
    return null;
  }

  // Auto-promote failed to dead_letter when retries exhausted
  let finalStatus = newStatus;
  if (newStatus === 'failed' && row.retry_count >= row.max_retries) {
    finalStatus = 'dead_letter';
    logger.info(
      { runId: id, retryCount: row.retry_count, maxRetries: row.max_retries },
      'Auto-promoting failed run to dead_letter (retries exhausted)',
    );
  }

  const now = new Date().toISOString();
  const result = updates?.result ?? row.result;
  const error = updates?.error ?? row.error;

  db.prepare(
    `UPDATE run_ledger SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`,
  ).run(finalStatus, result, error, now, id);

  logger.debug(
    { runId: id, from: currentStatus, to: finalStatus },
    'Run state transition',
  );

  return {
    ...row,
    status: finalStatus,
    result,
    error,
    updated_at: now,
  };
}

export function getDeadLetters(limit: number = 50): RunEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM run_ledger WHERE status = 'dead_letter' ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as RunEntry[];
}

export function retryDeadLetter(id: string): RunEntry | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM run_ledger WHERE id = ?').get(id) as
    | RunEntry
    | undefined;

  if (!row) return null;
  if (row.status !== 'dead_letter') {
    logger.warn(
      { runId: id, status: row.status },
      'Cannot retry: run is not in dead_letter state',
    );
    return null;
  }

  const now = new Date().toISOString();
  const newRetryCount = row.retry_count + 1;

  db.prepare(
    `UPDATE run_ledger SET status = 'queued', retry_count = ?, error = NULL, updated_at = ? WHERE id = ?`,
  ).run(newRetryCount, now, id);

  return {
    ...row,
    status: 'queued',
    retry_count: newRetryCount,
    error: null,
    updated_at: now,
  };
}

export function getRunHistory(
  groupJid?: string,
  limit: number = 100,
): RunEntry[] {
  const db = getDb();
  if (groupJid) {
    return db
      .prepare(
        `SELECT * FROM run_ledger WHERE group_jid = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(groupJid, limit) as RunEntry[];
  }
  return db
    .prepare(`SELECT * FROM run_ledger ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as RunEntry[];
}

export interface RunStats {
  total: number;
  byStatus: Record<string, number>;
  deadLetterCount: number;
}

export function getRunStats(): RunStats {
  const db = getDb();
  const rows = db
    .prepare(`SELECT status, COUNT(*) as count FROM run_ledger GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;

  const byStatus: Record<string, number> = {};
  let total = 0;
  let deadLetterCount = 0;

  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
    if (row.status === 'dead_letter') {
      deadLetterCount = row.count;
    }
  }

  return { total, byStatus, deadLetterCount };
}

export function pruneOldRuns(olderThanDays: number = 7): number {
  const db = getDb();
  const cutoff = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const result = db
    .prepare(
      `DELETE FROM run_ledger WHERE status IN ('acked', 'dead_letter') AND updated_at < ?`,
    )
    .run(cutoff);

  return result.changes;
}
