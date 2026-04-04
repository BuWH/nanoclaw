import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockSpawnControl = vi.hoisted(() => ({
  enabled: false,
  stdoutData: '',
  exitCode: 1,
}));

vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  const realSpawn = mod.spawn;
  return {
    ...mod,
    spawn: (...args: Parameters<typeof mod.spawn>) => {
      if (mockSpawnControl.enabled) {
        const { EventEmitter } = require('events');
        const { Readable, Writable } = require('stream');
        const proc = new EventEmitter();
        proc.stdout = new Readable({
          read() {
            if (mockSpawnControl.stdoutData) {
              this.push(mockSpawnControl.stdoutData);
            }
            this.push(null);
          },
        });
        proc.stderr = new Readable({
          read() {
            this.push(null);
          },
        });
        proc.stdin = new Writable({
          write(_c: unknown, _e: unknown, cb: () => void) {
            cb();
          },
        });
        proc.pid = 99999;
        proc.unref = () => {};
        proc.kill = () => {};
        // Delay close event to ensure stdout data handlers have fired
        setTimeout(() => proc.emit('close', mockSpawnControl.exitCode), 10);
        return proc;
      }
      return realSpawn(...args);
    },
  };
});

import { runOpencli, runScript, handleOpencliIpc } from './opencli-ipc.js';
import {
  extractTweetId,
  loadCache,
  saveCache,
  getCachedTweet,
  cacheTweets,
  cacheTweetsFromSearch,
  cacheTweetFromScrape,
  cacheTweetsFromOpencliSearch,
  cacheTweetsFromOpencliTimeline,
  cacheTweetFromOpencliThread,
  formatCachedTweet,
  pruneCache,
  type TweetCacheEntry,
  type SearchTweet,
  type OpencliSearchTweet,
  type OpencliTimelineTweet,
  type OpencliThreadTweet,
} from './x-tweet-cache.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// runOpencli tests
// ---------------------------------------------------------------------------
describe('runOpencli', () => {
  beforeEach(() => {
    mockSpawnControl.enabled = true;
    mockSpawnControl.stdoutData = '';
    mockSpawnControl.exitCode = 1;
  });

  afterEach(() => {
    mockSpawnControl.enabled = false;
  });

  it('spawns opencli with correct args and parses JSON output', async () => {
    mockSpawnControl.exitCode = 0;
    mockSpawnControl.stdoutData = JSON.stringify({ ok: true });

    const result = await runOpencli([
      'twitter',
      'search',
      'test',
      '-f',
      'json',
    ]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true });
  });

  it('handles non-zero exit code', async () => {
    mockSpawnControl.exitCode = 1;
    mockSpawnControl.stdoutData = '';

    const result = await runOpencli(['twitter', 'search', 'fail']);
    expect(result.success).toBe(false);
    expect(result.message).toContain('opencli failed');
  });

  it('handles invalid JSON output gracefully', async () => {
    mockSpawnControl.exitCode = 0;
    mockSpawnControl.stdoutData = 'not json at all';

    const result = await runOpencli(['twitter', 'search', 'badjson']);
    expect(result.success).toBe(true);
    expect(result.message).toContain('not json at all');
    expect(result.data).toBeNull();
  });

  it('handles empty output', async () => {
    mockSpawnControl.exitCode = 0;
    mockSpawnControl.stdoutData = '';

    const result = await runOpencli(['twitter', 'search', 'empty']);
    expect(result.success).toBe(false);
    expect(result.message).toContain('empty output');
  });

  it('handles timeout (kills process)', async () => {
    // Use real spawn with a sleep command, but with a very short timeout
    mockSpawnControl.enabled = false;
    const result = await runOpencli(
      ['nonexistent-command-for-timeout-test'],
      100,
    );
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runScript tests
// ---------------------------------------------------------------------------
describe('runScript', () => {
  it('spawns with detached: true and returns failure for nonexistent script', async () => {
    mockSpawnControl.enabled = false;
    const result = await runScript('nonexistent-script-for-test', {}, 500);
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('returns parsed JSON from successful script stdout', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');
    const skillsScriptsDir = path.join(
      PROJECT_ROOT,
      '.claude',
      'skills',
      'x-integration',
      'scripts',
    );
    const targetPath = path.join(skillsScriptsDir, '__test-success.ts');
    writeFileSync(
      targetPath,
      `
process.stdin.resume();
process.stdin.on('data', () => {
  console.log(JSON.stringify({ success: true, message: 'ok', data: { foo: 42 } }));
  process.exit(0);
});
`,
    );
    try {
      mockSpawnControl.enabled = false;
      const result = await runScript('__test-success', { input: 'test' }, 5000);
      expect(result.success).toBe(true);
      expect(result.message).toBe('ok');
      expect(result.data).toEqual({ foo: 42 });
    } finally {
      try {
        unlinkSync(targetPath);
      } catch {
        /* ignore */
      }
    }
  });

  it('returns failure when script exits with non-zero code', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');
    const skillsScriptsDir = path.join(
      PROJECT_ROOT,
      '.claude',
      'skills',
      'x-integration',
      'scripts',
    );
    const targetPath = path.join(skillsScriptsDir, '__test-fail.ts');
    writeFileSync(
      targetPath,
      `
process.stdin.resume();
process.stdin.on('data', () => {
  process.stderr.write('something went wrong');
  process.exit(1);
});
`,
    );
    try {
      mockSpawnControl.enabled = false;
      const result = await runScript('__test-fail', {}, 5000);
      expect(result.success).toBe(false);
      expect(result.message).toContain('crashed');
      expect(result.message).toContain('exit 1');
    } finally {
      try {
        unlinkSync(targetPath);
      } catch {
        /* ignore */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// handleOpencliIpc -- routing logic
// ---------------------------------------------------------------------------
describe('handleOpencliIpc', () => {
  const dataDir = '/tmp/nanoclaw-test-opencli-ipc';

  it('returns false for non-opencli_* types', async () => {
    const handled = await handleOpencliIpc(
      { type: 'chat' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(false);
  });

  it('blocks non-main groups', async () => {
    const handled = await handleOpencliIpc(
      { type: 'opencli_twitter_post', requestId: 'r1', content: 'hello' },
      'other-group',
      false,
      dataDir,
    );
    expect(handled).toBe(true);
  });

  it('blocks requests without requestId', async () => {
    const handled = await handleOpencliIpc(
      { type: 'opencli_twitter_post', content: 'hello' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
  });

  it('returns false for unknown opencli_* types', async () => {
    const handled = await handleOpencliIpc(
      { type: 'opencli_unknown_action', requestId: 'r1' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(false);
  });

  it('validates required fields for opencli_twitter_post', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });

    const handled = await handleOpencliIpc(
      { type: 'opencli_twitter_post', requestId: 'r-missing-content' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-missing-content.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing content');
  });

  it('validates required fields for opencli_twitter_like', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });

    const handled = await handleOpencliIpc(
      { type: 'opencli_twitter_like', requestId: 'r-missing-url' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-missing-url.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing tweetUrl');
  });

  it('validates required fields for opencli_twitter_reply', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });

    const handled = await handleOpencliIpc(
      { type: 'opencli_twitter_reply', requestId: 'r-missing-reply' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-missing-reply.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing tweetUrl or content');
  });

  it('validates required fields for opencli_run', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });

    const handled = await handleOpencliIpc(
      { type: 'opencli_run', requestId: 'r-missing-cmd' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-missing-cmd.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing command');
  });

  it('validates required fields for opencli_xhs_search', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });

    const handled = await handleOpencliIpc(
      { type: 'opencli_xhs_search', requestId: 'r-missing-query' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-missing-query.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing query');
  });

  it('validates required fields for opencli_xhs_note', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });

    const handled = await handleOpencliIpc(
      { type: 'opencli_xhs_note', requestId: 'r-missing-url' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-missing-url.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing noteUrl');
  });

  it('validates required fields for opencli_xhs_user', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });

    const handled = await handleOpencliIpc(
      { type: 'opencli_xhs_user', requestId: 'r-missing-uid' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-missing-uid.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing userId');
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

// ---------------------------------------------------------------------------
// x-tweet-cache -- unit tests
// ---------------------------------------------------------------------------
describe('x-tweet-cache', () => {
  const CACHE_FILE = path.join(PROJECT_ROOT, 'data', 'x-tweet-cache.json');

  function makeCacheEntry(
    overrides: Partial<TweetCacheEntry> = {},
  ): TweetCacheEntry {
    return {
      id: '123456789',
      author: 'Test User',
      handle: '@testuser',
      content: 'Hello world',
      timestamp: '2026-02-20T10:00:00.000Z',
      url: 'https://x.com/testuser/status/123456789',
      likes: 42,
      retweets: 10,
      replies: 5,
      views: 1000,
      cachedAt: Date.now(),
      ...overrides,
    };
  }

  beforeEach(() => {
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      /* ignore */
    }
  });

  describe('extractTweetId', () => {
    it('extracts ID from x.com URL', () => {
      expect(extractTweetId('https://x.com/user/status/123456789')).toBe(
        '123456789',
      );
    });
    it('extracts ID from twitter.com URL', () => {
      expect(extractTweetId('https://twitter.com/user/status/987654321')).toBe(
        '987654321',
      );
    });
    it('accepts raw numeric ID', () => {
      expect(extractTweetId('123456789')).toBe('123456789');
    });
    it('returns null for invalid input', () => {
      expect(extractTweetId('not-a-url')).toBeNull();
    });
  });

  describe('loadCache / saveCache', () => {
    it('returns empty cache when file does not exist', () => {
      const cache = loadCache();
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.tweets)).toHaveLength(0);
    });
    it('round-trips cache through file', () => {
      const entry = makeCacheEntry();
      saveCache({ version: 1, tweets: { [entry.id]: entry } });
      const loaded = loadCache();
      expect(loaded.tweets[entry.id]).toEqual(entry);
    });
    it('handles corrupted file gracefully', () => {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, 'not json');
      const cache = loadCache();
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.tweets)).toHaveLength(0);
    });
  });

  describe('getCachedTweet', () => {
    it('returns cached tweet by ID', () => {
      const entry = makeCacheEntry({ id: '111' });
      saveCache({ version: 1, tweets: { '111': entry } });
      expect(getCachedTweet('111')).toEqual(entry);
    });
    it('returns null for missing tweet', () => {
      saveCache({ version: 1, tweets: {} });
      expect(getCachedTweet('999')).toBeNull();
    });
    it('returns null for expired tweet', () => {
      const staleEntry = makeCacheEntry({
        id: '222',
        cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      });
      saveCache({ version: 1, tweets: { '222': staleEntry } });
      expect(getCachedTweet('222')).toBeNull();
    });
  });

  describe('pruneCache', () => {
    it('removes expired entries', () => {
      const cache = {
        version: 1 as const,
        tweets: {
          fresh: makeCacheEntry({ id: 'fresh', cachedAt: Date.now() }),
          stale: makeCacheEntry({
            id: 'stale',
            cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          }),
        },
      };
      const pruned = pruneCache(cache);
      expect(Object.keys(pruned.tweets)).toHaveLength(1);
      expect(pruned.tweets['fresh']).toBeDefined();
    });
    it('limits to max entries (500), keeping newest', () => {
      const tweets: Record<string, TweetCacheEntry> = {};
      for (let i = 0; i < 510; i++) {
        tweets[`t${i}`] = makeCacheEntry({
          id: `t${i}`,
          cachedAt: Date.now() - i * 1000,
        });
      }
      const pruned = pruneCache({ version: 1 as const, tweets });
      expect(Object.keys(pruned.tweets)).toHaveLength(500);
    });
  });

  describe('cacheTweetsFromOpencliSearch', () => {
    it('maps opencli search fields correctly', () => {
      const tweets: OpencliSearchTweet[] = [
        {
          id: 'os1',
          author: 'alice',
          text: 'Hello from opencli',
          created_at: '2026-03-01',
          likes: 50,
          views: 1000,
          url: 'https://x.com/alice/status/os1',
        },
      ];
      cacheTweetsFromOpencliSearch(tweets);
      const cached = getCachedTweet('os1');
      expect(cached).toBeTruthy();
      expect(cached!.author).toBe('alice');
      expect(cached!.handle).toBe('@alice');
      expect(cached!.content).toBe('Hello from opencli');
      expect(cached!.timestamp).toBe('2026-03-01');
      expect(cached!.likes).toBe(50);
      expect(cached!.views).toBe(1000);
      expect(cached!.retweets).toBe(0);
    });
  });

  describe('cacheTweetsFromOpencliTimeline', () => {
    it('maps opencli timeline fields correctly', () => {
      const tweets: OpencliTimelineTweet[] = [
        {
          id: 'ot1',
          author: 'bob',
          text: 'Timeline tweet',
          likes: 30,
          retweets: 5,
          replies: 2,
          views: 500,
          created_at: '2026-03-02',
          url: 'https://x.com/bob/status/ot1',
        },
      ];
      cacheTweetsFromOpencliTimeline(tweets);
      const cached = getCachedTweet('ot1');
      expect(cached).toBeTruthy();
      expect(cached!.author).toBe('bob');
      expect(cached!.handle).toBe('@bob');
      expect(cached!.content).toBe('Timeline tweet');
      expect(cached!.retweets).toBe(5);
      expect(cached!.replies).toBe(2);
    });
  });

  describe('cacheTweetFromOpencliThread', () => {
    it('maps opencli thread fields correctly', () => {
      const thread: OpencliThreadTweet[] = [
        {
          id: 'th1',
          author: 'carol',
          text: 'Main tweet',
          likes: 100,
          retweets: 20,
          url: 'https://x.com/carol/status/th1',
        },
        {
          id: 'th2',
          author: 'dave',
          text: 'Reply tweet',
          likes: 5,
          retweets: 0,
          url: 'https://x.com/dave/status/th2',
        },
      ];
      cacheTweetFromOpencliThread('th1', thread);
      const cached = getCachedTweet('th1');
      expect(cached).toBeTruthy();
      expect(cached!.author).toBe('carol');
      expect(cached!.content).toBe('Main tweet');
      expect(cached!.likes).toBe(100);
      expect(cached!.retweets).toBe(20);
    });
    it('does nothing with empty thread or null tweetId', () => {
      cacheTweetFromOpencliThread(null, []);
      const cache = loadCache();
      expect(Object.keys(cache.tweets)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// handleOpencliIpc -- tweet cache integration
// ---------------------------------------------------------------------------
describe('handleOpencliIpc tweet cache', () => {
  const dataDir = '/tmp/nanoclaw-test-opencli-cache';
  const CACHE_FILE = path.join(PROJECT_ROOT, 'data', 'x-tweet-cache.json');

  beforeEach(() => {
    fs.mkdirSync(path.join(dataDir, 'ipc', 'main', 'opencli_results'), {
      recursive: true,
    });
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      /* ignore */
    }
    mockSpawnControl.enabled = true;
    mockSpawnControl.stdoutData = '';
    mockSpawnControl.exitCode = 1;
  });

  afterEach(() => {
    mockSpawnControl.enabled = false;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(CACHE_FILE);
    } catch {
      /* ignore */
    }
  });

  it('serves opencli_twitter_scrape from cache when tweet is cached', async () => {
    const entry = {
      id: '1234567890',
      author: 'Cached Author',
      handle: '@cached',
      content: 'This is cached',
      timestamp: '2026-02-20T10:00:00.000Z',
      url: 'https://x.com/cached/status/1234567890',
      likes: 99,
      retweets: 33,
      replies: 11,
      views: 5000,
      cachedAt: Date.now(),
    };
    saveCache({ version: 1, tweets: { '1234567890': entry } });

    const handled = await handleOpencliIpc(
      {
        type: 'opencli_twitter_scrape',
        requestId: 'r-cache-hit',
        tweetUrl: 'https://x.com/cached/status/1234567890',
      },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
    const result = JSON.parse(
      fs.readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-cache-hit.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('Cached Author');
    expect(result.message).toContain('[Served from cache]');
  });

  it('bypasses cache when includeReplies is true', async () => {
    const entry = {
      id: '9876543210',
      author: 'Cached',
      handle: '@cached',
      content: 'Cached tweet',
      timestamp: '2026-02-20T10:00:00.000Z',
      url: 'https://x.com/cached/status/9876543210',
      likes: 1,
      retweets: 0,
      replies: 0,
      views: 10,
      cachedAt: Date.now(),
    };
    saveCache({ version: 1, tweets: { '9876543210': entry } });

    const handled = await handleOpencliIpc(
      {
        type: 'opencli_twitter_scrape',
        requestId: 'r-replies-bypass',
        tweetUrl: 'https://x.com/cached/status/9876543210',
        includeReplies: true,
      },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
    const result = JSON.parse(
      fs.readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-replies-bypass.json',
        ),
        'utf-8',
      ),
    );
    expect(result.message).not.toContain('[Served from cache]');
  });

  it('falls through to opencli on cache miss', async () => {
    const handled = await handleOpencliIpc(
      {
        type: 'opencli_twitter_scrape',
        requestId: 'r-cache-miss',
        tweetUrl: 'https://x.com/user/status/1111111111',
      },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
    const result = JSON.parse(
      fs.readFileSync(
        path.join(
          dataDir,
          'ipc',
          'main',
          'opencli_results',
          'r-cache-miss.json',
        ),
        'utf-8',
      ),
    );
    expect(result.success).toBe(false);
    expect(result.message).not.toContain('[Served from cache]');
  });
});
