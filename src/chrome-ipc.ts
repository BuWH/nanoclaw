/**
 * Chrome Cookie Export IPC Handler
 *
 * Handles chrome_* IPC messages from container agents.
 * Exports Chrome cookies from the host browser to Playwright storage_state
 * format, writing to data/browser-state/storage.json so the container's
 * browser-agent can use authenticated sessions.
 *
 * Security:
 * - Only main group can trigger cookie export
 * - Reads only from Chrome's local cookie database (read-only)
 * - Output is written to the shared browser-state directory
 */

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/** Check whether `uv` is available on the host PATH. */
function uvAvailable(): boolean {
  try {
    execFileSync('uv', ['--version'], { timeout: 5_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface ChromeResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: ChromeResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'chrome_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

async function exportCookies(
  dataDir: string,
  domains?: string,
  profile?: string,
): Promise<ChromeResult> {
  if (!uvAvailable()) {
    return {
      success: false,
      message:
        'uv is not installed on the host. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh',
    };
  }

  // Resolve the Python script path relative to the project root.
  // dataDir is typically <project>/data, so the project root is one level up.
  const projectRoot = path.resolve(dataDir, '..');
  const scriptPath = path.join(
    projectRoot,
    'tools',
    'export-chrome-cookies.py',
  );

  if (!fs.existsSync(scriptPath)) {
    return {
      success: false,
      message: `Script not found: ${scriptPath}`,
    };
  }

  const outputPath = path.join(dataDir, 'browser-state', 'storage.json');
  const args = [
    'run',
    '--with',
    'rookiepy',
    scriptPath,
    '--output',
    outputPath,
  ];

  if (domains) {
    args.push('--domains', domains);
  }
  if (profile) {
    args.push('--profile', profile);
  }

  return new Promise((resolve) => {
    execFile('uv', args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr?.trim() || err.message;
        resolve({
          success: false,
          message: `Cookie export failed: ${detail}`,
        });
        return;
      }

      try {
        const output = JSON.parse(stdout.trim());
        resolve({
          success: output.success,
          message: output.message,
          data: {
            count: output.count,
            domains: output.domains,
            path: output.path,
          },
        });
      } catch {
        resolve({
          success: false,
          message: `Failed to parse script output: ${stdout.trim()}`,
        });
      }
    });
  });
}

/**
 * Handle Chrome cookie IPC messages from container agents.
 *
 * @returns true if message was handled, false if not a chrome_* message
 */
export async function handleChromeIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('chrome_')) {
    return false;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Chrome IPC: missing requestId');
    return true;
  }

  // Only main group can export host Chrome cookies
  if (!isMain) {
    logger.warn({ sourceGroup, type }, 'Chrome IPC blocked: not main group');
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      message: 'Chrome cookie export is restricted to main group only',
    });
    return true;
  }

  if (type !== 'chrome_export_cookies') {
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      message: `Unknown Chrome IPC type: ${type}`,
    });
    return true;
  }

  const domains = data.domains as string | undefined;
  const profile = data.profile as string | undefined;

  logger.info(
    { type, requestId, domains, profile },
    'Processing Chrome cookie export request',
  );
  const requestStart = Date.now();

  const result = await exportCookies(dataDir, domains, profile);

  writeResult(dataDir, sourceGroup, requestId, result);
  const durationMs = Date.now() - requestStart;

  if (result.success) {
    logger.info(
      { type, requestId, durationMs, data: result.data },
      'Chrome cookie export completed',
    );
  } else {
    logger.error(
      { type, requestId, durationMs, error: result.message },
      'Chrome cookie export failed',
    );
  }

  return true;
}
