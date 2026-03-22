import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const LOCK_DIR = path.join(DATA_DIR, 'locks');
const GIT_LOCK_FILE = path.join(LOCK_DIR, 'git-operations.lock');
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

interface LockInfo {
  pid: number;
  timestamp: number;
  operation: string;
}

export function acquireGitLock(operation: string): boolean {
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  // Check for stale lock
  if (fs.existsSync(GIT_LOCK_FILE)) {
    try {
      const existing: LockInfo = JSON.parse(
        fs.readFileSync(GIT_LOCK_FILE, 'utf-8'),
      );
      if (Date.now() - existing.timestamp < LOCK_STALE_MS) {
        logger.warn(
          { existingLock: existing, requestedOp: operation },
          'Git lock held by another process',
        );
        return false;
      }
      logger.warn({ staleLock: existing }, 'Removing stale git lock');
    } catch {
      /* corrupted lock file, remove it */
    }
    // Remove stale or corrupted lock before attempting exclusive create
    try {
      fs.unlinkSync(GIT_LOCK_FILE);
    } catch {
      /* already removed */
    }
  }

  // Write lock with O_EXCL for atomicity
  const lockInfo: LockInfo = {
    pid: process.pid,
    timestamp: Date.now(),
    operation,
  };
  try {
    const fd = fs.openSync(
      GIT_LOCK_FILE,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    );
    fs.writeSync(fd, JSON.stringify(lockInfo));
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      // Race condition - another process got the lock between our check and create
      return false;
    }
    throw err;
  }
}

export function releaseGitLock(): void {
  try {
    const content = fs.readFileSync(GIT_LOCK_FILE, 'utf-8');
    const lockInfo: LockInfo = JSON.parse(content);
    if (lockInfo.pid !== process.pid) {
      logger.warn(
        { lockPid: lockInfo.pid, myPid: process.pid },
        'Not releasing git lock owned by another process',
      );
      return;
    }
    fs.unlinkSync(GIT_LOCK_FILE);
  } catch {
    // Lock already released or corrupted — safe to ignore
  }
}

export async function withGitLock<T>(
  operation: string,
  fn: () => T | Promise<T>,
  retries = 3,
  retryDelayMs = 2000,
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (acquireGitLock(operation)) {
      try {
        return await fn();
      } finally {
        releaseGitLock();
      }
    }
    if (attempt < retries - 1) {
      logger.debug({ operation, attempt }, 'Git lock busy, retrying');
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error(
    `Failed to acquire git lock for "${operation}" after ${retries} attempts`,
  );
}

/** Path to the git lock file, exported for observability (health monitor). */
export const GIT_LOCK_FILE_PATH = GIT_LOCK_FILE;

/**
 * Check if a stale lock file exists.
 * Returns the stale lock info if found, null otherwise.
 */
export function getStaleLockInfo(): LockInfo | null {
  try {
    if (!fs.existsSync(GIT_LOCK_FILE)) return null;
    const info: LockInfo = JSON.parse(fs.readFileSync(GIT_LOCK_FILE, 'utf-8'));
    if (Date.now() - info.timestamp >= LOCK_STALE_MS) {
      return info;
    }
  } catch {
    /* corrupted or missing */
  }
  return null;
}
