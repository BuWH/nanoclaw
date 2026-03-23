import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  recordDeliveryAck,
  wasDelivered,
  clearDeliveryAck,
  checkPendingIpcFiles,
  _resetForTest,
} from './delivery-ack.js';

describe('delivery-ack', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('records and detects a delivery', () => {
    const runId = 'run-abc-123';
    expect(wasDelivered(runId)).toBe(false);

    recordDeliveryAck(runId);
    expect(wasDelivered(runId)).toBe(true);
  });

  it('returns false for unknown runId', () => {
    expect(wasDelivered('nonexistent')).toBe(false);
  });

  it('clears a delivery record', () => {
    const runId = 'run-def-456';
    recordDeliveryAck(runId);
    expect(wasDelivered(runId)).toBe(true);

    clearDeliveryAck(runId);
    expect(wasDelivered(runId)).toBe(false);
  });

  it('different runIds do not interfere', () => {
    const runA = 'run-a';
    const runB = 'run-b';

    recordDeliveryAck(runA);

    expect(wasDelivered(runA)).toBe(true);
    expect(wasDelivered(runB)).toBe(false);

    clearDeliveryAck(runA);
    expect(wasDelivered(runA)).toBe(false);
  });

  it('recording the same runId twice is idempotent', () => {
    const runId = 'run-dup';
    recordDeliveryAck(runId);
    recordDeliveryAck(runId);
    expect(wasDelivered(runId)).toBe(true);

    clearDeliveryAck(runId);
    expect(wasDelivered(runId)).toBe(false);
  });

  it('evicts stale entries when map exceeds 100', () => {
    const baseTime = 1_700_000_000_000;
    let currentTime = baseTime;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    // Fill 101 entries at base time
    for (let i = 0; i < 101; i++) {
      recordDeliveryAck(`stale-${i}`);
    }

    // Advance past MAX_AGE_MS (10 minutes)
    currentTime = baseTime + 11 * 60 * 1000;

    // Next record triggers eviction
    recordDeliveryAck('fresh');

    for (let i = 0; i < 101; i++) {
      expect(wasDelivered(`stale-${i}`)).toBe(false);
    }
    expect(wasDelivered('fresh')).toBe(true);

    vi.restoreAllMocks();
  });

  it('checkPendingIpcFiles finds matching runId in pending IPC files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    const messagesDir = path.join(tmpDir, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });

    // Write a fake IPC message file
    fs.writeFileSync(
      path.join(messagesDir, '123-abc.json'),
      JSON.stringify({ type: 'message', runId: 'run-xyz', text: 'hello' }),
    );

    expect(checkPendingIpcFiles(tmpDir, 'run-xyz')).toBe(true);
    expect(checkPendingIpcFiles(tmpDir, 'run-other')).toBe(false);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });
});
