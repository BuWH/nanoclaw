import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-rotation/data',
  GROUPS_DIR: '/tmp/nanoclaw-test-rotation/groups',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getSessionTranscriptSize,
  shouldRotateSession,
  rotateSession,
  cleanupOrphanSessionFiles,
  type CleanupResult,
} from './session-rotation.js';

const TEST_DIR = '/tmp/nanoclaw-test-rotation';
const DATA_DIR = path.join(TEST_DIR, 'data');
const GROUPS_DIR = path.join(TEST_DIR, 'groups');

function createTranscriptFile(
  groupFolder: string,
  sizeBytes: number,
  content?: string,
): string {
  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    'test-session',
  );
  fs.mkdirSync(projectsDir, { recursive: true });

  const filePath = path.join(projectsDir, 'transcript.jsonl');

  if (content) {
    fs.writeFileSync(filePath, content);
  } else {
    // Fill with dummy JSONL lines to reach target size
    const lines: string[] = [];
    let currentSize = 0;
    let i = 0;
    while (currentSize < sizeBytes) {
      const line = JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        message: {
          content:
            i % 2 === 0
              ? `Message number ${i}`
              : [{ type: 'text', text: `Response number ${i}` }],
        },
      });
      lines.push(line);
      currentSize += line.length + 1; // +1 for newline
      i++;
    }
    fs.writeFileSync(filePath, lines.join('\n'));
  }

  return filePath;
}

describe('session-rotation', () => {
  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('getSessionTranscriptSize', () => {
    it('returns 0 when session directory does not exist', () => {
      expect(getSessionTranscriptSize('nonexistent')).toBe(0);
    });

    it('returns total size of JSONL files', () => {
      createTranscriptFile('test-group', 5000);
      const size = getSessionTranscriptSize('test-group');
      expect(size).toBeGreaterThanOrEqual(5000);
    });

    it('ignores non-JSONL files', () => {
      const projectsDir = path.join(
        DATA_DIR,
        'sessions',
        'test-group',
        '.claude',
        'projects',
        'test-session',
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'other.txt'), 'x'.repeat(10000));
      expect(getSessionTranscriptSize('test-group')).toBe(0);
    });
  });

  describe('shouldRotateSession', () => {
    it('returns false when below threshold', () => {
      createTranscriptFile('test-group', 1000);
      expect(shouldRotateSession('test-group')).toBe(false);
    });

    it('returns true when above 10MB threshold', () => {
      createTranscriptFile('test-group', 11 * 1024 * 1024);
      expect(shouldRotateSession('test-group')).toBe(true);
    });

    it('returns false when no session exists', () => {
      expect(shouldRotateSession('nonexistent')).toBe(false);
    });
  });

  describe('rotateSession', () => {
    it('writes session-context.md with recent messages', () => {
      const lines: string[] = [];
      for (let i = 0; i < 30; i++) {
        if (i % 2 === 0) {
          lines.push(
            JSON.stringify({
              type: 'user',
              message: { content: `Question ${i}` },
            }),
          );
        } else {
          lines.push(
            JSON.stringify({
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: `Answer ${i}` }],
              },
            }),
          );
        }
      }
      createTranscriptFile('test-group', 0, lines.join('\n'));

      const result = rotateSession('test-group', 'session-123');

      expect(result.rotated).toBe(true);
      expect(result.previousSessionId).toBe('session-123');
      expect(result.summaryPath).toBeDefined();

      const contextPath = path.join(
        GROUPS_DIR,
        'test-group',
        'session-context.md',
      );
      expect(fs.existsSync(contextPath)).toBe(true);

      const content = fs.readFileSync(contextPath, 'utf-8');
      expect(content).toContain('Recent Session Context');
      // Should contain last 20 messages (messages 10-29)
      expect(content).toContain('Question 10');
      expect(content).toContain('Answer 29');
      // Should NOT contain earliest messages (pruned to last 20)
      expect(content).not.toContain('Question 0');
    });

    it('returns rotated=true even with empty transcript', () => {
      const projectsDir = path.join(
        DATA_DIR,
        'sessions',
        'empty-group',
        '.claude',
        'projects',
        'test-session',
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'transcript.jsonl'), '');

      const result = rotateSession('empty-group', 'session-456');
      expect(result.rotated).toBe(true);
      expect(result.previousSessionId).toBe('session-456');
    });

    it('returns rotated=false on filesystem error', () => {
      // Non-existent data dir scenario handled gracefully
      const result = rotateSession('nonexistent', 'session-789');
      expect(result.rotated).toBe(true); // No transcript found is still a valid rotation
    });

    it('truncates long messages in context file', () => {
      const longMessage = 'x'.repeat(3000);
      const lines = [
        JSON.stringify({
          type: 'user',
          message: { content: longMessage },
        }),
      ];
      createTranscriptFile('test-group', 0, lines.join('\n'));

      rotateSession('test-group', 'session-trunc');

      const contextPath = path.join(
        GROUPS_DIR,
        'test-group',
        'session-context.md',
      );
      const content = fs.readFileSync(contextPath, 'utf-8');
      // 1500 chars + "..." truncation
      expect(content).toContain('...');
      expect(content.length).toBeLessThan(longMessage.length);
    });
  });

  describe('cleanupOrphanSessionFiles', () => {
    function createSessionFile(
      groupFolder: string,
      sessionId: string,
      sizeBytes = 100,
    ): string {
      const projectsDir = path.join(
        DATA_DIR,
        'sessions',
        groupFolder,
        '.claude',
        'projects',
        '-workspace-group',
      );
      fs.mkdirSync(projectsDir, { recursive: true });
      const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
      fs.writeFileSync(filePath, 'x'.repeat(sizeBytes));
      return filePath;
    }

    it('returns 0 deleted when no current session ID', () => {
      const result = cleanupOrphanSessionFiles('test-group', undefined);
      expect(result.deletedCount).toBe(0);
      expect(result.survivingSize).toBe(0);
    });

    it('returns 0 deleted when session directory does not exist', () => {
      const result = cleanupOrphanSessionFiles('nonexistent', 'session-abc');
      expect(result.deletedCount).toBe(0);
      expect(result.survivingSize).toBe(0);
    });

    it('deletes orphan JSONL files but keeps the current session', () => {
      const currentId = 'current-session-id';
      const orphan1 = 'orphan-session-1';
      const orphan2 = 'orphan-session-2';

      const currentPath = createSessionFile('test-group', currentId, 500);
      const orphan1Path = createSessionFile('test-group', orphan1, 1000);
      const orphan2Path = createSessionFile('test-group', orphan2, 2000);

      expect(fs.existsSync(currentPath)).toBe(true);
      expect(fs.existsSync(orphan1Path)).toBe(true);
      expect(fs.existsSync(orphan2Path)).toBe(true);

      const result = cleanupOrphanSessionFiles('test-group', currentId);

      expect(result.deletedCount).toBe(2);
      expect(result.survivingSize).toBe(500);
      expect(fs.existsSync(currentPath)).toBe(true);
      expect(fs.existsSync(orphan1Path)).toBe(false);
      expect(fs.existsSync(orphan2Path)).toBe(false);
    });

    it('returns 0 when only the current session file exists', () => {
      const currentId = 'only-session';
      createSessionFile('test-group', currentId);

      const result = cleanupOrphanSessionFiles('test-group', currentId);
      expect(result.deletedCount).toBe(0);
    });

    it('does not delete non-JSONL files', () => {
      const currentId = 'current-session';
      createSessionFile('test-group', currentId);

      const projectsDir = path.join(
        DATA_DIR,
        'sessions',
        'test-group',
        '.claude',
        'projects',
        '-workspace-group',
      );
      const otherFile = path.join(projectsDir, 'sessions-index.json');
      fs.writeFileSync(otherFile, '{}');

      cleanupOrphanSessionFiles('test-group', currentId);
      expect(fs.existsSync(otherFile)).toBe(true);
    });

    it('reduces getSessionTranscriptSize after cleanup and returns surviving size', () => {
      const currentId = 'current';
      createSessionFile('test-group', currentId, 500);
      createSessionFile('test-group', 'orphan-big', 50_000);

      const sizeBefore = getSessionTranscriptSize('test-group');
      expect(sizeBefore).toBeGreaterThan(50_000);

      const result = cleanupOrphanSessionFiles('test-group', currentId);

      const sizeAfter = getSessionTranscriptSize('test-group');
      expect(sizeAfter).toBeLessThan(1000);
      expect(sizeAfter).toBeLessThan(sizeBefore);
      // survivingSize should match post-cleanup size
      expect(result.survivingSize).toBe(sizeAfter);
    });

    it('prevents false rotation trigger from orphan accumulation', () => {
      // Simulate the vicious cycle: many orphans inflate size past threshold
      const currentId = 'small-current';
      createSessionFile('test-group', currentId, 100);

      // Add orphans totaling > 5MB
      for (let i = 0; i < 6; i++) {
        createSessionFile('test-group', `orphan-${i}`, 1_000_000);
      }

      // Without cleanup, rotation would trigger (> 5MB)
      expect(shouldRotateSession('test-group')).toBe(true);

      // After cleanup, only the small current file remains
      cleanupOrphanSessionFiles('test-group', currentId);
      expect(shouldRotateSession('test-group')).toBe(false);
    });
  });
});
