/**
 * Codex PR Review IPC Handler
 *
 * Handles codex_* IPC messages from container agents.
 * Spawns Codex CLI on the host to review GitHub PRs and post comments.
 *
 * Any group can trigger reviews -- Codex only reads the PR diff and posts
 * comments, so there is no privilege escalation risk.
 *
 * Security:
 * - Codex runs in --full-auto sandbox (workspace-write, approval on-failure)
 * - Repo cloned to /tmp/ (isolated from NanoClaw source)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface CodexResult {
  success: boolean;
  message: string;
  data?: unknown;
}

const CODEX_BIN = '/opt/homebrew/bin/codex';
const CODEX_MODEL = 'gpt-5.3-codex';
const REVIEW_TIMEOUT_MS = 300_000; // 5 minutes
const CLONE_TIMEOUT_MS = 60_000; // 1 minute for git operations

/**
 * Parse a GitHub PR URL into owner, repo, and PR number.
 * Supports:
 * - https://github.com/owner/repo/pull/123
 * - github.com/owner/repo/pull/123
 * - owner/repo#123
 */
function parsePrUrl(prUrl: string): {
  owner: string;
  repo: string;
  number: number;
} | null {
  // Full URL: https://github.com/owner/repo/pull/123
  const urlMatch = prUrl.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      number: parseInt(urlMatch[3], 10),
    };
  }

  // Shorthand: owner/repo#123
  const shortMatch = prUrl.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      number: parseInt(shortMatch[3], 10),
    };
  }

  return null;
}

/**
 * Run a shell command as a Promise with timeout.
 */
function execCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { cwd, timeout = CLONE_TIMEOUT_MS } = options;

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      detached: true,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.unref();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.stdin.end();

    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
      resolve({ stdout, stderr, code: -1 });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: -1 });
    });
  });
}

/**
 * Clone the repo and check out the PR branch into a temporary directory.
 * The caller is responsible for cleaning up the directory after use.
 */
async function prepareRepo(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ repoDir: string } | { error: string }> {
  const repoDir = `/tmp/codex-review-${owner}-${repo}-${Date.now()}`;

  // Remove stale clone if it somehow exists
  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  logger.info({ owner, repo, repoDir }, 'Cloning repository for Codex review');
  const clone = await execCommand(
    'gh',
    ['repo', 'clone', `${owner}/${repo}`, repoDir],
    { timeout: CLONE_TIMEOUT_MS },
  );
  if (clone.code !== 0) {
    return { error: `Failed to clone ${owner}/${repo}: ${clone.stderr}` };
  }

  const checkout = await execCommand(
    'gh',
    ['pr', 'checkout', String(prNumber), '--force'],
    { cwd: repoDir },
  );
  if (checkout.code !== 0) {
    // Clean up failed clone
    fs.rmSync(repoDir, { recursive: true, force: true });
    return {
      error: `Failed to checkout PR #${prNumber}: ${checkout.stderr}`,
    };
  }

  return { repoDir };
}

/**
 * Run Codex CLI to review a PR.
 */
async function runCodexReview(
  repoDir: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<CodexResult> {
  const resultFile = `/tmp/codex-review-result-${Date.now()}.txt`;

  const prompt = [
    `You are reviewing Pull Request #${prNumber} in the ${owner}/${repo} repository.`,
    '',
    'Steps:',
    `1. Run \`gh pr diff ${prNumber}\` to see all changes in this PR.`,
    `2. Read the changed files to understand the full context.`,
    '3. Analyze the changes for: bugs, security issues, performance problems, logic errors, and code quality.',
    '4. If you find issues, post a review using:',
    `   \`gh pr review ${prNumber} --comment --body "<your detailed review>"\``,
    '   Include specific file names and line references in your review.',
    '5. If the code looks good with no issues, post a brief approval comment.',
    '',
    'Rules:',
    '- Do NOT approve or request changes (--approve / --request-changes). Only use --comment.',
    '- Be specific: reference file names, line numbers, and code snippets.',
    '- Focus on substantive issues, not style nits.',
    '- If there are multiple issues, list them all in one review comment.',
  ].join('\n');

  return new Promise((resolve) => {
    const proc = spawn(
      CODEX_BIN,
      [
        'exec',
        '-m',
        CODEX_MODEL,
        '--full-auto',
        '--output-last-message',
        resultFile,
        '-C',
        repoDir,
        prompt,
      ],
      {
        detached: true,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    proc.unref();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.stdin.end();

    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
      logger.error(
        { prNumber, owner, repo, timeoutMs: REVIEW_TIMEOUT_MS },
        'Codex review timed out',
      );
      resolve({
        success: false,
        message: `Codex review timed out after ${REVIEW_TIMEOUT_MS / 1000}s`,
      });
    }, REVIEW_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Read the last message file if available
      let lastMessage = '';
      try {
        if (fs.existsSync(resultFile)) {
          lastMessage = fs.readFileSync(resultFile, 'utf-8').trim();
          fs.unlinkSync(resultFile);
        }
      } catch {
        // Ignore file read errors
      }

      if (code !== 0 && !lastMessage) {
        logger.error(
          {
            prNumber,
            owner,
            repo,
            code,
            stderrTail: stderr.slice(-500),
          },
          'Codex review failed',
        );
        resolve({
          success: false,
          message: `Codex review failed (exit ${code}): ${stderr.slice(-300) || '(no stderr)'}`,
        });
        return;
      }

      const resultMessage = lastMessage || stdout.slice(-2000) || '(no output)';
      logger.info(
        { prNumber, owner, repo, code, resultLength: resultMessage.length },
        'Codex review completed',
      );

      resolve({
        success: true,
        message: resultMessage,
        data: { prNumber, owner, repo },
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.error({ prNumber, owner, repo, err }, 'Codex spawn error');
      resolve({
        success: false,
        message: `Failed to spawn Codex: ${err.message}`,
      });
    });
  });
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: CodexResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'codex_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
}

/**
 * Handle Codex integration IPC messages from container agents.
 *
 * @returns true if message was handled, false if not a codex_* message
 */
export async function handleCodexIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  // Only handle codex_* types
  if (!type?.startsWith('codex_')) {
    return false;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Codex integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing Codex request');
  const requestStart = Date.now();

  let result: CodexResult;

  switch (type) {
    case 'codex_review_pr': {
      const prUrl = data.prUrl as string;
      if (!prUrl) {
        result = { success: false, message: 'Missing prUrl' };
        break;
      }

      const parsed = parsePrUrl(prUrl);
      if (!parsed) {
        result = {
          success: false,
          message: `Invalid PR URL: "${prUrl}". Expected format: https://github.com/owner/repo/pull/123 or owner/repo#123`,
        };
        break;
      }

      const { owner, repo, number: prNumber } = parsed;

      // Prepare the repo (clone + checkout PR branch)
      const prep = await prepareRepo(owner, repo, prNumber);
      if ('error' in prep) {
        result = { success: false, message: prep.error };
        break;
      }

      // Run the Codex review
      result = await runCodexReview(prep.repoDir, owner, repo, prNumber);

      // Clean up the temporary clone -- it is only needed during the review
      try {
        fs.rmSync(prep.repoDir, { recursive: true, force: true });
        logger.debug(
          { repoDir: prep.repoDir },
          'Cleaned up temporary repo clone',
        );
      } catch (err) {
        logger.warn(
          { repoDir: prep.repoDir, err },
          'Failed to clean up temporary repo clone',
        );
      }
      break;
    }

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  const requestDurationMs = Date.now() - requestStart;
  if (result.success) {
    logger.info(
      { type, requestId, requestDurationMs },
      'Codex request completed',
    );
  } else {
    logger.error(
      { type, requestId, requestDurationMs, error: result.message },
      'Codex request failed',
    );
  }
  return true;
}
