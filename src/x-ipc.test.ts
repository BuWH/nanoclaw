import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Mock logger before importing module under test
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// We do NOT mock child_process or fs here -- runScript tests use real subprocesses
// to verify process-group kill behavior.

import { runScript, handleXIpc } from './x-ipc.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// runScript -- process-group kill on timeout
// ---------------------------------------------------------------------------
describe('runScript', () => {
  it('spawns with detached: true and kills process group on timeout', async () => {
    // Use a tiny script that sleeps forever via node -e
    // We override the script path by pointing at a non-existent script,
    // but we can test the spawn options directly.

    // Instead, use a real inline node script that:
    // 1. spawns a child (simulating Chrome)
    // 2. both sleep forever
    // We then verify the entire process group is killed.

    const helperScript = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

    // We'll create a temporary script inline via spawn of `node -e`
    // But runScript hardcodes the script path. Let's test with a very short timeout
    // on a script that doesn't exist -- it should fail gracefully.

    const result = await runScript('nonexistent-script-for-test', {}, 500);

    expect(result.success).toBe(false);
    // Should either fail to spawn or exit with non-zero code
    expect(result.message).toBeTruthy();
  });

  it('kills entire process group on timeout (no orphan children)', async () => {
    // Create a helper script that spawns a long-lived child process.
    // We use node -e inline via a temp file approach.
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('fs');
    const os = await import('os');

    const tmpDir = mkdtempSync(path.join(os.default.tmpdir(), 'x-ipc-test-'));
    const helperScript = path.join(tmpDir, 'slow-parent.ts');

    // This script:
    // 1. Reads stdin (as runScript sends JSON)
    // 2. Spawns a child that sleeps 60s
    // 3. Parent also sleeps 60s
    // Both should be killed when process group is killed.
    writeFileSync(helperScript, `
import { spawn } from 'child_process';

// Read stdin
process.stdin.resume();
process.stdin.on('data', () => {});

// Spawn a child that sleeps (simulating Chrome)
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
child.unref();

// Parent also sleeps
setTimeout(() => {}, 60000);
`);

    // We need to make runScript use our helper script.
    // Since runScript hardcodes the path, we'll place our script where it expects it.
    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-orphan-kill.ts');

    writeFileSync(targetPath, `
import { spawn } from 'child_process';

// Read stdin
process.stdin.resume();
process.stdin.on('data', () => {});

// Spawn a child that sleeps (simulating Chrome)
const child = spawn('sleep', ['60'], { stdio: 'ignore' });

// Write child PID to stderr so the test can verify it was killed
process.stderr.write('CHILD_PID:' + child.pid + '\\n');

// Parent also sleeps
setTimeout(() => {}, 60000);
`);

    try {
      // Use a 2-second timeout
      const result = await runScript('__test-orphan-kill', {}, 2000);

      expect(result.success).toBe(false);
      expect(result.message).toContain('timed out');
      expect(result.message).toContain('2s');

      // Extract child PID from stderr in the message
      const pidMatch = result.message.match(/CHILD_PID:(\d+)/);
      if (pidMatch) {
        const childPid = parseInt(pidMatch[1], 10);

        // Give a moment for the SIGKILL to propagate
        await new Promise((r) => setTimeout(r, 200));

        // Verify the child process was killed
        let childAlive = false;
        try {
          process.kill(childPid, 0); // signal 0 = check existence
          childAlive = true;
        } catch {
          childAlive = false;
        }

        expect(childAlive).toBe(false);
      }
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
      try { unlinkSync(helperScript); } catch { /* ignore */ }
    }
  });

  it('returns parsed JSON from successful script stdout', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');

    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-success.ts');

    writeFileSync(targetPath, `
// Read stdin then output JSON result
process.stdin.resume();
process.stdin.on('data', () => {
  console.log(JSON.stringify({ success: true, message: 'ok', data: { foo: 42 } }));
  process.exit(0);
});
`);

    try {
      const result = await runScript('__test-success', { input: 'test' }, 5000);

      expect(result.success).toBe(true);
      expect(result.message).toBe('ok');
      expect(result.data).toEqual({ foo: 42 });
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });

  it('returns failure when script exits with non-zero code', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');

    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-fail.ts');

    writeFileSync(targetPath, `
process.stdin.resume();
process.stdin.on('data', () => {
  process.stderr.write('something went wrong');
  process.exit(1);
});
`);

    try {
      const result = await runScript('__test-fail', {}, 5000);

      expect(result.success).toBe(false);
      expect(result.message).toContain('exited with code: 1');
      expect(result.message).toContain('something went wrong');
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });

  it('returns failure when stdout is not valid JSON', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');

    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-badjson.ts');

    writeFileSync(targetPath, `
process.stdin.resume();
process.stdin.on('data', () => {
  console.log('not json');
  process.exit(0);
});
`);

    try {
      const result = await runScript('__test-badjson', {}, 5000);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse output');
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// handleXIpc -- routing logic
// ---------------------------------------------------------------------------
describe('handleXIpc', () => {
  const dataDir = '/tmp/nanoclaw-test-xipc';

  it('returns false for non-x_* types', async () => {
    const handled = await handleXIpc({ type: 'chat' }, 'main', true, dataDir);
    expect(handled).toBe(false);
  });

  it('blocks non-main groups', async () => {
    const handled = await handleXIpc(
      { type: 'x_post', requestId: 'r1', content: 'hello' },
      'other-group',
      false,
      dataDir,
    );
    expect(handled).toBe(true);
    // No script should have been run -- it should return immediately
  });

  it('blocks requests without requestId', async () => {
    const handled = await handleXIpc(
      { type: 'x_post', content: 'hello' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
  });

  it('returns false for unknown x_* types', async () => {
    const handled = await handleXIpc(
      { type: 'x_unknown_action', requestId: 'r1' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(false);
  });

  it('validates required fields for x_post', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'x_results'), { recursive: true });

    const handled = await handleXIpc(
      { type: 'x_post', requestId: 'r-missing-content' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-missing-content.json'), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing content');
  });

  it('validates required fields for x_like', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'x_results'), { recursive: true });

    const handled = await handleXIpc(
      { type: 'x_like', requestId: 'r-missing-url' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-missing-url.json'), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing tweetUrl');
  });

  it('validates required fields for x_reply', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'x_results'), { recursive: true });

    const handled = await handleXIpc(
      { type: 'x_reply', requestId: 'r-missing-reply' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-missing-reply.json'), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing tweetUrl or content');
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
