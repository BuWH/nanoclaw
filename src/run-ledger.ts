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
  stderr_excerpt: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  log_file: string | null;
  ipc_delivered: number;
}

const MAX_PAYLOAD_LENGTH = 4096;

// Valid state transitions
const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running'],
  running: ['streaming', 'acked', 'failed'],
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
    stderr_excerpt: null,
    exit_code: null,
    duration_ms: null,
    log_file: null,
    ipc_delivered: 0,
  };
}

export function transitionRun(
  id: string,
  newStatus: RunStatus,
  updates?: {
    result?: string;
    error?: string;
    stderr_excerpt?: string;
    exit_code?: number;
    duration_ms?: number;
    log_file?: string;
    ipc_delivered?: number;
  },
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
  const stderrExcerpt = updates?.stderr_excerpt ?? row.stderr_excerpt;
  const exitCode = updates?.exit_code ?? row.exit_code;
  const durationMs = updates?.duration_ms ?? row.duration_ms;
  const logFile = updates?.log_file ?? row.log_file;
  const ipcDelivered = updates?.ipc_delivered ?? row.ipc_delivered;

  db.prepare(
    `UPDATE run_ledger SET status = ?, result = ?, error = ?, stderr_excerpt = ?, exit_code = ?, duration_ms = ?, log_file = ?, ipc_delivered = ?, updated_at = ? WHERE id = ?`,
  ).run(
    finalStatus,
    result,
    error,
    stderrExcerpt,
    exitCode,
    durationMs,
    logFile,
    ipcDelivered,
    now,
    id,
  );

  logger.debug(
    { runId: id, from: currentStatus, to: finalStatus },
    'Run state transition',
  );

  return {
    ...row,
    status: finalStatus,
    result,
    error,
    stderr_excerpt: stderrExcerpt,
    exit_code: exitCode,
    duration_ms: durationMs,
    log_file: logFile,
    ipc_delivered: ipcDelivered,
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
    `UPDATE run_ledger SET status = 'queued', retry_count = ?, error = NULL, stderr_excerpt = NULL, exit_code = NULL, duration_ms = NULL, log_file = NULL, ipc_delivered = 0, updated_at = ? WHERE id = ?`,
  ).run(newRetryCount, now, id);

  return {
    ...row,
    status: 'queued',
    retry_count: newRetryCount,
    error: null,
    stderr_excerpt: null,
    exit_code: null,
    duration_ms: null,
    log_file: null,
    ipc_delivered: 0,
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
      `DELETE FROM run_ledger WHERE status IN ('acked', 'dead_letter', 'failed') AND updated_at < ?`,
    )
    .run(cutoff);

  return result.changes;
}

export function getRecentErrors(limit: number = 20): RunEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM run_ledger
       WHERE error IS NOT NULL OR exit_code IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as RunEntry[];
}

export function getErrorsByGroup(
  groupFolder: string,
  limit: number = 20,
): RunEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM run_ledger
       WHERE (error IS NOT NULL OR exit_code IS NOT NULL)
         AND group_folder = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(groupFolder, limit) as RunEntry[];
}
