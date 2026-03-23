import { describe, it, expect, beforeEach } from 'vitest';

import {
  recordDeliveryAck,
  wasDelivered,
  clearDeliveryAck,
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
});
