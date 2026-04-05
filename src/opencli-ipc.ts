/**
 * OpenCLI Integration IPC Handler
 *
 * Handles all opencli_* IPC messages from container agents.
 * Uses the opencli CLI for Twitter, Xiaohongshu, and other platforms.
 * Legacy Playwright scripts are kept for retweet and quote only
 * (no opencli equivalents).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';
import {
  extractTweetId,
  getCachedTweet,
  formatCachedTweet,
  cacheTweetsFromOpencliSearch,
  cacheTweetsFromOpencliTimeline,
  cacheTweetFromOpencliThread,
  type OpencliSearchTweet,
  type OpencliTimelineTweet,
  type OpencliThreadTweet,
} from './x-tweet-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 120_000;
const OPENCLI_BIN = process.env.OPENCLI_BIN || 'opencli';

// Run an opencli CLI command and parse JSON output
export async function runOpencli(
  args: readonly string[],
  timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<SkillResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(OPENCLI_BIN, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.stdin.end();

    const timer = setTimeout(() => {
      const durationMs = Date.now() - startTime;
      proc.kill('SIGKILL');
      logger.error(
        { args, durationMs, timeoutMs, stderrTail: stderr.slice(-500) },
        'opencli command timed out',
      );
      resolve({
        success: false,
        message: `opencli timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      const stdoutTrimmed = stdout.trim();

      if (code !== 0) {
        logger.error(
          {
            args,
            code,
            durationMs,
            stdoutTail: stdout.slice(-300),
            stderrTail: stderr.slice(-500),
          },
          'opencli command failed',
        );
        resolve({
          success: false,
          message: `opencli failed (exit ${code}): ${stderr.slice(-300) || stdout.slice(-200) || '(no output)'}`,
        });
        return;
      }

      if (!stdoutTrimmed) {
        logger.warn({ args, durationMs }, 'opencli returned empty output');
        resolve({
          success: false,
          message: 'opencli returned empty output',
        });
        return;
      }

      try {
        const data = JSON.parse(stdoutTrimmed);
        logger.debug(
          { args: args.slice(0, 3), durationMs },
          'opencli command completed',
        );
        resolve({ success: true, message: '', data });
      } catch {
        logger.warn(
          { args, durationMs, stdoutTail: stdoutTrimmed.slice(-300) },
          'opencli returned non-JSON output',
        );
        // Return the raw text as message (some opencli commands return plain text)
        resolve({ success: true, message: stdoutTrimmed, data: null });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      logger.error({ args, durationMs, err }, 'opencli spawn error');
      resolve({
        success: false,
        message: `Failed to spawn opencli: ${err.message}`,
      });
    });
  });
}

// Run a legacy skill script as subprocess with process-group cleanup on timeout.
// Kept only for retweet and quote which have no opencli equivalents.
export async function runScript(
  script: string,
  args: object,
  timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<SkillResult> {
  const scriptPath = path.join(
    PROJECT_ROOT,
    '.claude',
    'skills',
    'x-integration',
    'scripts',
    `${script}.ts`,
  );
  const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(tsxBin, [scriptPath], {
      cwd: PROJECT_ROOT,
      detached: true,
      env: {
        ...process.env,
        NANOCLAW_ROOT: PROJECT_ROOT,
        PATH: `${path.join(PROJECT_ROOT, 'node_modules', '.bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Prevent the detached process group from keeping the parent alive
    proc.unref();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      const durationMs = Date.now() - startTime;
      // Kill the entire process group (tsx + all children like Chrome)
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
      logger.error(
        { script, durationMs, timeoutMs, stderrTail: stderr.slice(-500) },
        'Legacy script timed out',
      );
      resolve({
        success: false,
        message: `Script timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      // Try to parse structured result from stdout regardless of exit code.
      // Scripts write JSON to stdout via writeResult() even on error paths,
      // so we should always attempt to parse it.
      const stdoutTrimmed = stdout.trim();
      if (stdoutTrimmed) {
        try {
          const lines = stdoutTrimmed.split('\n');
          const parsed: SkillResult = JSON.parse(lines[lines.length - 1]);
          if (code !== 0) {
            logger.warn(
              {
                script,
                code,
                durationMs,
                parsed: parsed.message?.slice(0, 200),
                stderrTail: stderr.slice(-300),
              },
              'Legacy script exited non-zero but produced parseable output',
            );
          } else {
            logger.debug(
              { script, durationMs, success: parsed.success },
              'Legacy script completed',
            );
          }
          resolve(parsed);
          return;
        } catch {
          // stdout wasn't valid JSON, fall through
        }
      }

      if (code !== 0) {
        logger.error(
          {
            script,
            code,
            durationMs,
            stdoutTail: stdout.slice(-300),
            stderrTail: stderr.slice(-500),
          },
          'Legacy script crashed with no parseable output',
        );
        resolve({
          success: false,
          message: `Script ${script} crashed (exit ${code}). stderr: ${stderr.slice(-300) || '(empty)'}. stdout: ${stdout.slice(-200) || '(empty)'}`,
        });
        return;
      }

      logger.warn(
        { script, durationMs, stdoutLength: stdout.length },
        'Legacy script exited 0 but produced no parseable output',
      );
      resolve({ success: false, message: `No output from script ${script}` });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      logger.error({ script, durationMs, err }, 'Legacy script spawn error');
      resolve({
        success: false,
        message: `Failed to spawn ${script}: ${err.message}`,
      });
    });
  });
}

// Write result to IPC results directory
function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: SkillResult,
  originalType?: string,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'opencli_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const payload = JSON.stringify(result);
  fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), payload);

  // Backward compatibility: also write to x_results/ if the original request
  // came via a legacy x_* type so old containers can find the result.
  if (originalType?.startsWith('x_')) {
    const legacyDir = path.join(dataDir, 'ipc', sourceGroup, 'x_results');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, `${requestId}.json`), payload);
  }
}

// ---------------------------------------------------------------------------
// Format helpers for opencli output
// ---------------------------------------------------------------------------

function formatSearchTweets(tweets: readonly OpencliSearchTweet[]): string {
  if (tweets.length === 0) return 'No tweets found.';

  return tweets
    .map((t, i) => {
      const lines = [
        `[${i + 1}] @${t.author}`,
        t.text,
        `Time: ${t.created_at}`,
        `Likes: ${t.likes ?? 0} | Views: ${t.views ?? 0}`,
        `URL: ${t.url}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

function formatTimelineTweets(tweets: readonly OpencliTimelineTweet[]): string {
  if (tweets.length === 0) return 'No tweets found.';

  return tweets
    .map((t, i) => {
      const lines = [
        `[${i + 1}] @${t.author}`,
        t.text,
        `Time: ${t.created_at}`,
        `Replies: ${t.replies ?? 0} | Retweets: ${t.retweets ?? 0} | Likes: ${t.likes ?? 0} | Views: ${t.views ?? 0}`,
        `URL: ${t.url}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

function formatThreadTweet(
  mainTweet: OpencliThreadTweet,
  replies: readonly OpencliThreadTweet[],
): string {
  const lines: string[] = [
    `@${mainTweet.author}`,
    mainTweet.text,
    `Likes: ${mainTweet.likes ?? 0} | Retweets: ${mainTweet.retweets ?? 0}`,
    `URL: ${mainTweet.url}`,
  ];

  if (replies.length > 0) {
    lines.push('', `--- Replies (${replies.length}) ---`);
    for (const r of replies) {
      lines.push('', `@${r.author}`, r.text);
    }
  }

  return lines.join('\n');
}

// Map an opencli_* IPC type to opencli CLI arguments with input validation.
interface OpencliMapping {
  args?: string[];
  error?: string;
}
function mapTypeToOpencliArgs(
  type: string,
  data: Record<string, unknown>,
): OpencliMapping | null {
  if (type === 'opencli_twitter_scrape') {
    if (!data.tweetUrl) return { error: 'Missing tweetUrl' };
    const tweetId = extractTweetId((data.tweetUrl as string) || '');
    const limit = data.includeReplies
      ? ((data.maxReplies as number) ?? 10) + 1
      : 1;
    return {
      args: [
        'twitter',
        'thread',
        tweetId || (data.tweetUrl as string),
        '--limit',
        String(limit),
        '-f',
        'json',
      ],
    };
  }
  if (type === 'opencli_twitter_profile') {
    if (!data.username) return { error: 'Missing username' };
    return {
      args: [
        'twitter',
        'profile',
        (data.username as string).replace(/^@/, ''),
        '-f',
        'json',
      ],
    };
  }
  if (type === 'opencli_twitter_post') {
    if (!data.content) return { error: 'Missing content' };
    return { args: ['twitter', 'post', data.content as string, '-f', 'json'] };
  }
  if (type === 'opencli_twitter_like') {
    if (!data.tweetUrl) return { error: 'Missing tweetUrl' };
    return { args: ['twitter', 'like', data.tweetUrl as string, '-f', 'json'] };
  }
  if (type === 'opencli_twitter_reply') {
    if (!data.tweetUrl || !data.content)
      return { error: 'Missing tweetUrl or content' };
    return {
      args: [
        'twitter',
        'reply',
        data.tweetUrl as string,
        data.content as string,
        '-f',
        'json',
      ],
    };
  }
  if (type === 'opencli_xhs_search') {
    if (!data.query) return { error: 'Missing query' };
    return {
      args: [
        'xiaohongshu',
        'search',
        data.query as string,
        '--limit',
        String((data.maxNotes as number) ?? 20),
        '-f',
        'json',
      ],
    };
  }
  if (type === 'opencli_xhs_note') {
    if (!data.noteUrl) return { error: 'Missing noteUrl' };
    return {
      args: ['xiaohongshu', 'note', data.noteUrl as string, '-f', 'json'],
    };
  }
  if (type === 'opencli_xhs_user') {
    if (!data.userId) return { error: 'Missing userId' };
    return {
      args: [
        'xiaohongshu',
        'user',
        data.userId as string,
        '--limit',
        String((data.maxNotes as number) ?? 20),
        '-f',
        'json',
      ],
    };
  }
  return null;
}

/**
 * Handle OpenCLI integration IPC messages.
 *
 * @returns true if the message was handled, false if not an opencli_ message
 */
export async function handleOpencliIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  let type = data.type as string;
  const originalType = type;

  // Backward compatibility: remap legacy x_* types to opencli_twitter_*
  const X_COMPAT_MAP: Record<string, string> = {
    x_post: 'opencli_twitter_post',
    x_like: 'opencli_twitter_like',
    x_reply: 'opencli_twitter_reply',
    x_retweet: 'opencli_twitter_retweet',
    x_quote: 'opencli_twitter_quote',
    x_scrape_tweet: 'opencli_twitter_scrape',
    x_scrape_profile: 'opencli_twitter_profile',
    x_search_tweets: 'opencli_twitter_search',
  };
  if (type && X_COMPAT_MAP[type]) {
    logger.info(
      { oldType: type, newType: X_COMPAT_MAP[type] },
      'Remapped legacy x_* IPC type to opencli_*',
    );
    type = X_COMPAT_MAP[type];
  }

  // Handle opencli_* types (and remapped x_* types)
  if (!type?.startsWith('opencli_')) {
    return false;
  }

  // Only main group can use OpenCLI integration
  if (!isMain) {
    logger.warn(
      { sourceGroup, type },
      'OpenCLI integration blocked: not main group',
    );
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'OpenCLI integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing OpenCLI request');
  const requestStart = Date.now();

  let result: SkillResult;

  switch (type) {
    // ----- Generic opencli command -----
    case 'opencli_run':
      if (!data.command) {
        result = { success: false, message: 'Missing command' };
        break;
      }
      {
        const command = data.command as string;
        const cmdArgs = Array.isArray(data.args) ? (data.args as string[]) : [];
        const allArgs = [command, ...cmdArgs];
        // Append -f json if not already present
        if (!allArgs.includes('-f') && !allArgs.includes('--format')) {
          allArgs.push('-f', 'json');
        }
        const timeout = (data.timeoutMs as number) ?? SCRIPT_TIMEOUT_MS;
        result = await runOpencli(allArgs, timeout);
        // Serialize data into message so MCP callers see the output
        if (result.success && !result.message && result.data != null) {
          result.message = JSON.stringify(result.data, null, 2);
        }
      }
      break;

    // ----- Twitter: search -----
    case 'opencli_twitter_search':
      if (!data.query) {
        result = {
          success: false,
          message:
            'Missing query parameter. Provide a search query to find tweets.',
        };
        break;
      }
      {
        const searchMode = (data.searchMode as string) ?? 'top';
        const filter = searchMode === 'latest' ? 'live' : 'top';
        const maxTweets = (data.maxTweets as number) ?? 20;

        const searchResult = await runOpencli([
          'twitter',
          'search',
          data.query as string,
          '--filter',
          filter,
          '--limit',
          String(maxTweets),
          '-f',
          'json',
        ]);

        if (!searchResult.success) {
          result = searchResult;
          break;
        }

        const tweets = (
          Array.isArray(searchResult.data) ? searchResult.data : []
        ) as OpencliSearchTweet[];

        cacheTweetsFromOpencliSearch(tweets);

        result = {
          success: true,
          message: formatSearchTweets(tweets),
          data: tweets,
        };
      }
      break;

    // ----- Twitter: timeline -----
    case 'opencli_twitter_timeline':
      {
        const timelineType = (data.timelineType as string) ?? 'for-you';
        const maxTweets = (data.maxTweets as number) ?? 20;

        const timelineResult = await runOpencli([
          'twitter',
          'timeline',
          '--type',
          timelineType,
          '--limit',
          String(maxTweets),
          '-f',
          'json',
        ]);

        if (!timelineResult.success) {
          result = timelineResult;
          break;
        }

        const tweets = (
          Array.isArray(timelineResult.data) ? timelineResult.data : []
        ) as OpencliTimelineTweet[];

        cacheTweetsFromOpencliTimeline(tweets);

        result = {
          success: true,
          message: formatTimelineTweets(tweets),
          data: tweets,
        };
      }
      break;

    // ----- Catch-all for non-dedicated opencli types -----
    default: {
      if (type === 'opencli_twitter_retweet') {
        if (!data.tweetUrl) {
          result = { success: false, message: 'Missing tweetUrl' };
          break;
        }
        result = await runScript('retweet', { tweetUrl: data.tweetUrl });
        break;
      }
      if (type === 'opencli_twitter_quote') {
        if (!data.tweetUrl || !data.comment) {
          result = { success: false, message: 'Missing tweetUrl or comment' };
          break;
        }
        result = await runScript('quote', {
          tweetUrl: data.tweetUrl,
          comment: data.comment,
        });
        break;
      }
      if (type === 'opencli_twitter_scrape' && data.tweetUrl) {
        const tweetId = extractTweetId(data.tweetUrl as string);
        if (tweetId && !data.includeReplies) {
          const cached = getCachedTweet(tweetId);
          if (cached) {
            logger.info({ tweetId, requestId }, 'Tweet cache hit');
            result = {
              success: true,
              message: formatCachedTweet(cached),
              data: cached,
            };
            break;
          }
        }
      }
      const mapped = mapTypeToOpencliArgs(type, data);
      if (!mapped) {
        return false;
      }
      if (mapped.error) {
        result = { success: false, message: mapped.error };
        break;
      }
      result = await runOpencli(mapped.args!);
      if (result.success && !result.message && result.data != null) {
        result.message = JSON.stringify(result.data, null, 2);
      }
      break;
    }
  }

  writeResult(dataDir, sourceGroup, requestId, result, originalType);
  const requestDurationMs = Date.now() - requestStart;
  if (result.success) {
    logger.info(
      { type, requestId, requestDurationMs },
      'OpenCLI request completed',
    );
  } else {
    logger.error(
      { type, requestId, requestDurationMs, error: result.message },
      'OpenCLI request failed',
    );
  }
  return true;
}
