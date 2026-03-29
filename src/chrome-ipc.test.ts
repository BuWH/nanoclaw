import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create mock functions that can be accessed in tests
const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();

// Mock logger before importing module under test
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process to avoid actually calling `uv`
vi.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

import { handleChromeIpc } from './chrome-ipc.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('handleChromeIpc', () => {
  /** Isolated project root so sibling `tools/` dir cannot leak across tests. */
  let projectRoot: string;
  let dataDir: string;

  beforeEach(() => {
    // Create a unique project root with a nested `data` subdirectory.
    // chrome-ipc.ts resolves the project root as `path.resolve(dataDir, '..')`,
    // so `projectRoot/data` ensures the `tools/` sibling stays isolated.
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-ipc-test-'));
    dataDir = path.join(projectRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    vi.clearAllMocks();
    // By default, uv is available
    mockExecFileSync.mockReturnValue(Buffer.from('uv 0.6.0'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Helper: create the tools/ directory so the script path check passes. */
  function setupScriptPath(): void {
    const toolsDir = path.join(projectRoot, 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(toolsDir, 'export-chrome-cookies.py'),
      '#!/usr/bin/env python3\n',
    );
  }

  /** Helper: read the result JSON for a given requestId. */
  function readResult(
    group: string,
    requestId: string,
  ): {
    success: boolean;
    message: string;
    data?: unknown;
  } {
    const resultPath = path.join(
      dataDir,
      'ipc',
      group,
      'chrome_results',
      `${requestId}.json`,
    );
    return JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  it('returns false for non-chrome_* types', async () => {
    const handled = await handleChromeIpc(
      { type: 'op_get_item' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(false);
  });

  it('blocks requests without requestId', async () => {
    const handled = await handleChromeIpc(
      { type: 'chrome_export_cookies' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
    // No result written since there's no requestId to name the file
  });

  it('blocks non-main groups', async () => {
    const handled = await handleChromeIpc(
      { type: 'chrome_export_cookies', requestId: 'r1' },
      'other-group',
      false,
      dataDir,
    );
    expect(handled).toBe(true);

    const result = readResult('other-group', 'r1');
    expect(result.success).toBe(false);
    expect(result.message).toContain('main group');
  });

  it('rejects unknown chrome_* subtypes', async () => {
    const handled = await handleChromeIpc(
      { type: 'chrome_unknown', requestId: 'r2' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const result = readResult('main', 'r2');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown Chrome IPC type');
  });

  // -------------------------------------------------------------------------
  // uv availability check
  // -------------------------------------------------------------------------

  it('returns error when uv is not installed', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const handled = await handleChromeIpc(
      { type: 'chrome_export_cookies', requestId: 'r3' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const result = readResult('main', 'r3');
    expect(result.success).toBe(false);
    expect(result.message).toContain('uv is not installed');
  });

  // -------------------------------------------------------------------------
  // Script path check
  // -------------------------------------------------------------------------

  it('returns error when script is not found', async () => {
    // Don't create the tools/ directory so the script check fails

    const handled = await handleChromeIpc(
      { type: 'chrome_export_cookies', requestId: 'r4' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const result = readResult('main', 'r4');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Script not found');
  });

  // -------------------------------------------------------------------------
  // Successful export
  // -------------------------------------------------------------------------

  it('handles chrome_export_cookies successfully', async () => {
    setupScriptPath();

    const scriptOutput = JSON.stringify({
      success: true,
      message: 'Exported 42 cookies for 5 domains',
      count: 42,
      domains: ['github.com', 'google.com'],
      path: '/tmp/storage.json',
    });

    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, scriptOutput, '');
        return {} as any;
      },
    );

    const handled = await handleChromeIpc(
      { type: 'chrome_export_cookies', requestId: 'r5' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    // Verify `uv` was called with correct args
    expect(mockExecFile).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining([
        'run',
        '--with',
        'rookiepy',
        expect.stringContaining('export-chrome-cookies.py'),
        '--output',
        expect.stringContaining('storage.json'),
      ]),
      { timeout: 30_000 },
      expect.any(Function),
    );

    const result = readResult('main', 'r5');
    expect(result.success).toBe(true);
    expect(result.message).toContain('42 cookies');
    expect(result.data).toEqual({
      count: 42,
      domains: ['github.com', 'google.com'],
      path: '/tmp/storage.json',
    });
  });

  it('passes --domains and --profile to the script', async () => {
    setupScriptPath();

    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(
          null,
          JSON.stringify({
            success: true,
            message: 'OK',
            count: 5,
            domains: ['github.com'],
            path: '/tmp/s.json',
          }),
          '',
        );
        return {} as any;
      },
    );

    await handleChromeIpc(
      {
        type: 'chrome_export_cookies',
        requestId: 'r6',
        domains: 'github.com,google.com',
        profile: 'Profile 1',
      },
      'main',
      true,
      dataDir,
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      'uv',
      expect.arrayContaining([
        '--domains',
        'github.com,google.com',
        '--profile',
        'Profile 1',
      ]),
      expect.anything(),
      expect.any(Function),
    );
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('handles uv execution errors', async () => {
    setupScriptPath();

    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(new Error('exit code 1'), '', 'rookiepy import failed');
        return {} as any;
      },
    );

    const handled = await handleChromeIpc(
      { type: 'chrome_export_cookies', requestId: 'r7' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const result = readResult('main', 'r7');
    expect(result.success).toBe(false);
    expect(result.message).toContain('rookiepy import failed');
  });

  it('handles malformed script output', async () => {
    setupScriptPath();

    mockExecFile.mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, 'not-json', '');
        return {} as any;
      },
    );

    const handled = await handleChromeIpc(
      { type: 'chrome_export_cookies', requestId: 'r8' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);

    const result = readResult('main', 'r8');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to parse');
  });
});
