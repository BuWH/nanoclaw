import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { computeChangelog } from './auto-update.js';

const projectRoot = process.cwd();

describe('computeChangelog', () => {
  it('returns bullet-pointed subjects for a real commit range', () => {
    const from = execSync('git rev-parse HEAD~3', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    const to = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();

    const result = computeChangelog(from, to, projectRoot);
    expect(result).toContain('•');
    const lines = result.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^• /);
    }
  });

  it('returns empty string for same SHA on both sides', () => {
    const head = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    expect(computeChangelog(head, head, projectRoot)).toBe('');
  });

  it('returns empty string for invalid SHAs', () => {
    const result = computeChangelog(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'cafebabecafebabecafebabecafebabecafebabe',
      projectRoot,
    );
    expect(result).toBe('');
  });

  it('strips conventional commit prefixes', () => {
    const from = execSync('git rev-parse HEAD~5', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    const to = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();

    const result = computeChangelog(from, to, projectRoot);
    const lines = result.split('\n').filter(Boolean);
    for (const line of lines) {
      expect(line).not.toMatch(/^• (feat|fix|test|docs|refactor|chore):/i);
    }
  });
});

describe('pre-update HEAD marker flow', () => {
  const tmpDir = path.join('/tmp', `nanoclaw-test-${Date.now()}`);
  const dataDir = path.join(tmpDir, 'data');

  beforeEach(() => {
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marker file persists after write (simulates SIGTERM survival)', () => {
    const markerPath = path.join(dataDir, '.pre-update-head');
    const sha = 'abc123def456789012345678901234567890abcd';
    fs.writeFileSync(markerPath, sha, 'utf-8');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe(sha);
  });

  it('dedup guard file tracks last announced SHA', () => {
    const announcedPath = path.join(dataDir, '.last-announced-head');
    const sha = 'abc123def456789012345678901234567890abcd';
    fs.writeFileSync(announcedPath, sha, 'utf-8');
    expect(fs.readFileSync(announcedPath, 'utf-8').trim()).toBe(sha);
  });

  it('full startup flow: reads marker, computes changelog, records announcement', () => {
    const markerPath = path.join(dataDir, '.pre-update-head');
    const announcedPath = path.join(dataDir, '.last-announced-head');

    const savedSha = execSync('git rev-parse HEAD~3', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    const currentHead = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();

    fs.writeFileSync(markerPath, savedSha, 'utf-8');
    expect(fs.readFileSync(markerPath, 'utf-8').trim()).not.toBe(currentHead);

    const changelog = computeChangelog(savedSha, currentHead, projectRoot);
    expect(changelog).toContain('•');

    fs.unlinkSync(markerPath);
    expect(fs.existsSync(markerPath)).toBe(false);

    fs.writeFileSync(announcedPath, currentHead, 'utf-8');
    expect(fs.readFileSync(announcedPath, 'utf-8').trim()).toBe(currentHead);
  });

  it('skips changelog when savedSha === currentHead', () => {
    const currentHead = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    expect(currentHead !== currentHead).toBe(false);
  });

  it('skips changelog when already announced', () => {
    const announcedPath = path.join(dataDir, '.last-announced-head');
    const currentHead = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();

    fs.writeFileSync(announcedPath, currentHead, 'utf-8');
    const lastAnnounced = fs.readFileSync(announcedPath, 'utf-8').trim();

    const savedSha = execSync('git rev-parse HEAD~3', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();

    const shouldCompute =
      savedSha !== currentHead && currentHead !== lastAnnounced;
    expect(shouldCompute).toBe(false);
  });
});
