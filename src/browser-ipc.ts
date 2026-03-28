/**
 * Browser Agent IPC Handler
 *
 * Handles browser_* IPC messages from container agents.
 * Runs browser-agent on the HOST machine so Chromium memory does not
 * count against the container's cgroup limit, preventing OOM kills.
 *
 * The container agent calls the `browse_web` MCP tool, which writes
 * an IPC request file. This handler picks it up, spawns browser-agent
 * on the host, and writes the result back for the container to poll.
 */

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

function uvAvailable(): boolean {
  try {
    execFileSync('uv', ['--version'], { timeout: 5_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface BrowserResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: BrowserResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'browser_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

const BROWSER_TIMEOUT_MS = 180_000;

async function runBrowserTask(
  dataDir: string,
  task: string,
  options: {
    maxSteps?: number;
    model?: string;
    useVision?: boolean;
  },
): Promise<BrowserResult> {
  if (!uvAvailable()) {
    return {
      success: false,
      message:
        'uv is not installed on the host. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh',
    };
  }

  const projectRoot = path.resolve(dataDir, '..');
  const scriptPath = path.join(
    projectRoot,
    'container',
    'browser-agent',
    'browser_agent.py',
  );

  if (!fs.existsSync(scriptPath)) {
    return {
      success: false,
      message: `browser_agent.py not found: ${scriptPath}`,
    };
  }

  // Build browser-agent CLI args
  const cliArgs = ['run', task];
  if (options.maxSteps) {
    cliArgs.push('--max-steps', String(options.maxSteps));
  }
  if (options.model) {
    cliArgs.push('--model', options.model);
  }
  if (options.useVision === false) {
    cliArgs.push('--no-vision');
  }

  // Use saved browser state if available
  const storagePath = path.join(dataDir, 'browser-state', 'storage.json');
  if (fs.existsSync(storagePath)) {
    cliArgs.push('--storage-state', storagePath);
  }

  const uvArgs = [
    'run',
    '--with',
    'browser-use>=0.12.0',
    '--with',
    'click>=8.0.0',
    scriptPath,
    ...cliArgs,
  ];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('uv', uvArgs, {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        // Use host Chrome (macOS) instead of container Chromium
        BROWSER_EXECUTABLE_PATH:
          process.env.BROWSER_EXECUTABLE_PATH ||
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // LiteLLM proxy for the browser LLM (same as container config)
        BROWSER_LLM_BASE_URL:
          process.env.BROWSER_LLM_BASE_URL || 'http://localhost:4000/v1',
        BROWSER_LLM_API_KEY: process.env.BROWSER_LLM_API_KEY || 'sk-local',
        BROWSER_LLM_MODEL: process.env.BROWSER_LLM_MODEL || 'gpt-5.4',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.unref();

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
      logger.error(
        {
          task: task.slice(0, 200),
          stderrTail: stderr.slice(-500),
        },
        'Browser agent timed out',
      );
      resolve({
        success: false,
        message: `Browser agent timed out after ${BROWSER_TIMEOUT_MS / 1000}s`,
      });
    }, BROWSER_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);

      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          const lines = trimmed.split('\n');
          const parsed = JSON.parse(lines[lines.length - 1]);
          resolve({
            success: parsed.success ?? false,
            message: parsed.result || parsed.error || 'Browser task completed',
            data: parsed,
          });
          return;
        } catch {
          // stdout wasn't valid JSON
        }
      }

      if (code !== 0) {
        resolve({
          success: false,
          message: `Browser agent exited with code ${code}: ${stderr.slice(-300) || stdout.slice(-200) || '(no output)'}`,
        });
        return;
      }

      resolve({
        success: false,
        message: 'Browser agent produced no parseable output',
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        message: `Failed to spawn browser agent: ${err.message}`,
      });
    });
  });
}

/**
 * Handle browser IPC messages from container agents.
 *
 * @returns true if message was handled, false if not a browser_* message
 */
export async function handleBrowserIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('browser_')) {
    return false;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Browser IPC: missing requestId');
    return true;
  }

  if (type !== 'browser_run') {
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      message: `Unknown browser IPC type: ${type}`,
    });
    return true;
  }

  const task = data.task as string;
  if (!task) {
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      message: 'Missing task parameter',
    });
    return true;
  }

  logger.info(
    { type, requestId, task: task.slice(0, 200) },
    'Processing browser agent request',
  );
  const requestStart = Date.now();

  const result = await runBrowserTask(dataDir, task, {
    maxSteps: (data.maxSteps as number) || undefined,
    model: (data.model as string) || undefined,
    useVision: data.useVision !== false,
  });

  writeResult(dataDir, sourceGroup, requestId, result);
  const durationMs = Date.now() - requestStart;

  if (result.success) {
    logger.info(
      { type, requestId, durationMs },
      'Browser agent request completed',
    );
  } else {
    logger.error(
      { type, requestId, durationMs, error: result.message },
      'Browser agent request failed',
    );
  }

  return true;
}
