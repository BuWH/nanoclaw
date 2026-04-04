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
const OPENCLI_BIN = '/Users/wenhe/.nvm/versions/node/v20.9.0/bin/opencli';

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
        PATH: `/Users/wenhe/.nvm/versions/node/v20.9.0/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
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
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'opencli_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${requestId}.json`),
    JSON.stringify(result),
  );
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
  const type = data.type as string;

  // Only handle opencli_* types
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

    // ----- Twitter: scrape tweet (with cache) -----
    case 'opencli_twitter_scrape':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      {
        const tweetId = extractTweetId(data.tweetUrl as string);
        // Serve from cache when not requesting replies (replies are never cached)
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

        // Use opencli twitter thread to fetch the tweet
        const maxReplies = (data.maxReplies as number) ?? 10;
        const limit = data.includeReplies ? maxReplies + 1 : 1;
        const threadResult = await runOpencli([
          'twitter',
          'thread',
          tweetId || (data.tweetUrl as string),
          '--limit',
          String(limit),
          '-f',
          'json',
        ]);

        if (!threadResult.success) {
          result = threadResult;
          break;
        }

        const thread = (
          Array.isArray(threadResult.data) ? threadResult.data : []
        ) as OpencliThreadTweet[];

        if (thread.length === 0) {
          result = { success: false, message: 'No tweet data returned.' };
          break;
        }

        const mainTweet = thread[0];
        const replies = thread.slice(1);

        // Cache the main tweet
        cacheTweetFromOpencliThread(tweetId, thread);

        result = {
          success: true,
          message: formatThreadTweet(
            mainTweet,
            data.includeReplies ? replies : [],
          ),
          data: { mainTweet, replies },
        };
      }
      break;

    // ----- Twitter: profile -----
    case 'opencli_twitter_profile':
      if (!data.username) {
        result = { success: false, message: 'Missing username' };
        break;
      }
      {
        const username = (data.username as string).replace(/^@/, '');
        const profileResult = await runOpencli([
          'twitter',
          'profile',
          username,
          '-f',
          'json',
        ]);

        if (!profileResult.success) {
          result = profileResult;
          break;
        }

        const profileData = profileResult.data as Record<string, unknown>;
        const msg = profileData
          ? [
              `@${profileData.screen_name || username}`,
              profileData.name ? `Name: ${profileData.name}` : null,
              profileData.bio ? `Bio: ${profileData.bio}` : null,
              profileData.location ? `Location: ${profileData.location}` : null,
              profileData.url ? `URL: ${profileData.url}` : null,
              `Followers: ${profileData.followers ?? 0} | Following: ${profileData.following ?? 0}`,
              `Tweets: ${profileData.tweets ?? 0} | Likes: ${profileData.likes ?? 0}`,
              profileData.verified ? 'Verified: Yes' : null,
              profileData.created_at
                ? `Joined: ${profileData.created_at}`
                : null,
            ]
              .filter(Boolean)
              .join('\n')
          : 'Profile data not available.';

        result = { success: true, message: msg, data: profileData };
      }
      break;

    // ----- Twitter: post -----
    case 'opencli_twitter_post':
      if (!data.content) {
        result = { success: false, message: 'Missing content' };
        break;
      }
      result = await runOpencli([
        'twitter',
        'post',
        data.content as string,
        '-f',
        'json',
      ]);
      if (result.success) {
        result.message = result.message || 'Tweet posted successfully.';
      }
      break;

    // ----- Twitter: like -----
    case 'opencli_twitter_like':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runOpencli([
        'twitter',
        'like',
        data.tweetUrl as string,
        '-f',
        'json',
      ]);
      if (result.success) {
        result.message = result.message || 'Tweet liked successfully.';
      }
      break;

    // ----- Twitter: reply -----
    case 'opencli_twitter_reply':
      if (!data.tweetUrl || !data.content) {
        result = { success: false, message: 'Missing tweetUrl or content' };
        break;
      }
      result = await runOpencli([
        'twitter',
        'reply',
        data.tweetUrl as string,
        data.content as string,
        '-f',
        'json',
      ]);
      if (result.success) {
        result.message = result.message || 'Reply posted successfully.';
      }
      break;

    // ----- Twitter: retweet (legacy Playwright script) -----
    case 'opencli_twitter_retweet':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('retweet', { tweetUrl: data.tweetUrl });
      break;

    // ----- Twitter: quote (legacy Playwright script) -----
    case 'opencli_twitter_quote':
      if (!data.tweetUrl || !data.comment) {
        result = { success: false, message: 'Missing tweetUrl or comment' };
        break;
      }
      result = await runScript('quote', {
        tweetUrl: data.tweetUrl,
        comment: data.comment,
      });
      break;

    // ----- Xiaohongshu: search -----
    case 'opencli_xhs_search':
      if (!data.query) {
        result = { success: false, message: 'Missing query' };
        break;
      }
      {
        const maxNotes = (data.maxNotes as number) ?? 20;
        result = await runOpencli([
          'xiaohongshu',
          'search',
          data.query as string,
          '--limit',
          String(maxNotes),
          '-f',
          'json',
        ]);
      }
      break;

    // ----- Xiaohongshu: note -----
    case 'opencli_xhs_note':
      if (!data.noteUrl) {
        result = { success: false, message: 'Missing noteUrl' };
        break;
      }
      result = await runOpencli([
        'xiaohongshu',
        'note',
        data.noteUrl as string,
        '-f',
        'json',
      ]);
      break;

    // ----- Xiaohongshu: user -----
    case 'opencli_xhs_user':
      if (!data.userId) {
        result = { success: false, message: 'Missing userId' };
        break;
      }
      {
        const maxNotes = (data.maxNotes as number) ?? 20;
        result = await runOpencli([
          'xiaohongshu',
          'user',
          data.userId as string,
          '--limit',
          String(maxNotes),
          '-f',
          'json',
        ]);
      }
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
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
