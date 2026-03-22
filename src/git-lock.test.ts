import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock DATA_DIR to use a temp directory.
// vi.mock is hoisted, so we use os.tmpdir() + process.pid inline.
vi.mock('./config.js', () => ({
  DATA_DIR: path.join(os.tmpdir(), `git-lock-test-${process.pid}`),
}));

import {
  acquireGitLock,
  releaseGitLock,
  withGitLock,
  GIT_LOCK_FILE_PATH,
  getStaleLockInfo,
} from './git-lock.js';
import { logger } from './logger.js';

const testDir = path.join(os.tmpdir(), `git-lock-test-${process.pid}`);
const LOCK_DIR = path.join(testDir, 'locks');
const LOCK_FILE = path.join(LOCK_DIR, 'git-operations.lock');

beforeEach(() => {
  vi.clearAllMocks();
  // Clean up lock directory
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
});

afterEach(() => {
  // Ensure locks are released after each test
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* no lock file */
  }
});

describe('acquireGitLock', () => {
  it('creates lock file and returns true on first acquire', () => {
    const result = acquireGitLock('test-op');
    expect(result).toBe(true);
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
  });

  it('returns false when lock is already held', () => {
    expect(acquireGitLock('first')).toBe(true);
    expect(acquireGitLock('second')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingLock: expect.any(Object),
        requestedOp: 'second',
      }),
      'Git lock held by another process',
    );
  });

  it('lock file contains valid JSON with expected fields', () => {
    acquireGitLock('test-operation');
    const content = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    expect(content).toEqual({
      pid: process.pid,
      timestamp: expect.any(Number),
      operation: 'test-operation',
    });
    expect(content.timestamp).toBeGreaterThan(0);
  });

  it('removes stale lock and acquires successfully', () => {
    // Write a stale lock (timestamp 10 minutes ago)
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    const staleLock = {
      pid: 99999,
      timestamp: Date.now() - 10 * 60 * 1000,
      operation: 'old-op',
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(staleLock));

    const result = acquireGitLock('new-op');
    expect(result).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ staleLock }),
      'Removing stale git lock',
    );
  });

  it('removes corrupted lock file and acquires successfully', () => {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, 'not valid json{{{');

    const result = acquireGitLock('recovery-op');
    expect(result).toBe(true);
  });
});

describe('releaseGitLock', () => {
  it('removes the lock file', () => {
    acquireGitLock('test');
    expect(fs.existsSync(LOCK_FILE)).toBe(true);

    releaseGitLock();
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it('does not throw when no lock file exists', () => {
    expect(() => releaseGitLock()).not.toThrow();
  });

  it('does not delete lock owned by a different PID', () => {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    const foreignLock = {
      pid: process.pid + 9999,
      timestamp: Date.now(),
      operation: 'foreign-op',
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(foreignLock));

    releaseGitLock();

    // Lock file must still exist — owned by another process
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
    const content = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    expect(content.pid).toBe(foreignLock.pid);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ lockPid: foreignLock.pid, myPid: process.pid }),
      'Not releasing git lock owned by another process',
    );
  });
});

describe('withGitLock', () => {
  it('acquires lock, runs function, and releases', async () => {
    let lockExistsDuringFn = false;
    const result = await withGitLock('wrapped-op', () => {
      lockExistsDuringFn = fs.existsSync(LOCK_FILE);
      return 42;
    });

    expect(result).toBe(42);
    expect(lockExistsDuringFn).toBe(true);
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it('releases lock even when function throws', async () => {
    await expect(
      withGitLock('failing-op', () => {
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');

    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it('works with async functions', async () => {
    const result = await withGitLock('async-op', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'async-result';
    });
    expect(result).toBe('async-result');
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it('retries when lock is held and eventually succeeds', async () => {
    // Acquire lock externally
    acquireGitLock('blocker');

    // Release after a short delay
    setTimeout(() => releaseGitLock(), 50);

    const result = await withGitLock(
      'retry-op',
      () => 'got-it',
      3,
      100, // short retry delay for test speed
    );
    expect(result).toBe('got-it');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'retry-op', attempt: 0 }),
      'Git lock busy, retrying',
    );
  });

  it('throws after exhausting retries', async () => {
    // Hold the lock for the entire test
    acquireGitLock('permanent-blocker');

    await expect(withGitLock('doomed-op', () => 'nope', 2, 50)).rejects.toThrow(
      'Failed to acquire git lock for "doomed-op" after 2 attempts',
    );

    // Clean up
    releaseGitLock();
  });
});

describe('GIT_LOCK_FILE_PATH', () => {
  it('points to the expected lock file location', () => {
    expect(GIT_LOCK_FILE_PATH).toBe(LOCK_FILE);
  });
});

describe('getStaleLockInfo', () => {
  it('returns null when no lock file exists', () => {
    expect(getStaleLockInfo()).toBeNull();
  });

  it('returns null when lock is not stale', () => {
    acquireGitLock('fresh-op');
    expect(getStaleLockInfo()).toBeNull();
    releaseGitLock();
  });

  it('returns stale lock info when lock is old', () => {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    const staleLock = {
      pid: 12345,
      timestamp: Date.now() - 10 * 60 * 1000,
      operation: 'stale-op',
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(staleLock));

    const result = getStaleLockInfo();
    expect(result).toEqual(staleLock);
  });

  it('returns null for corrupted lock file', () => {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, 'corrupted{{{');
    expect(getStaleLockInfo()).toBeNull();
  });
});
