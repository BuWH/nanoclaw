/**
 * X Tweet Cache
 *
 * Caches tweets from search and profile results so x_scrape_tweet
 * can serve from cache instead of hitting the X API again.
 *
 * Cache is a simple JSON file at data/x-tweet-cache.json.
 * TTL: 7 days. Max entries: 500.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const CACHE_FILE = path.join(PROJECT_ROOT, 'data', 'x-tweet-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TweetCacheEntry {
  id: string;
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  url: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  quotedTweet?: { author: string; content: string };
  cachedAt: number;
}

interface TweetCache {
  version: 1;
  tweets: Record<string, TweetCacheEntry>;
}

// ---------------------------------------------------------------------------
// Search result types (from search-tweets.ts)
// ---------------------------------------------------------------------------

export interface SearchTweet {
  id: string;
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  url: string;
  isRetweet: boolean;
  retweetedBy?: string;
  hasMedia: boolean;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  quotedTweet?: { author: string; content: string };
}

// ---------------------------------------------------------------------------
// Profile result types (from scrape-profile.ts)
// ---------------------------------------------------------------------------

export interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
  followersCount: string;
  followingCount: string;
  tweets: Array<{
    author: string;
    handle: string;
    content: string;
    timestamp: string;
    isRetweet: boolean;
    isPinned: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Scrape-tweet result types (from scrape-tweet.ts)
// ---------------------------------------------------------------------------

export interface ScrapedTweetData {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  metrics: {
    replies: string;
    reposts: string;
    likes: string;
    views: string;
    bookmarks: string;
  };
  replies: Array<{ author: string; handle: string; content: string }>;
  quotedTweet?: { author: string; content: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract tweet ID from URL or raw ID string.
 * Duplicated from .claude/skills/x-integration/lib/browser.ts to avoid
 * cross-module-context imports.
 */
export function extractTweetId(input: string): string | null {
  const urlMatch = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

export function loadCache(): TweetCache {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as TweetCache;
      if (parsed.version === 1 && parsed.tweets) {
        return parsed;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load tweet cache, starting fresh');
  }
  return { version: 1, tweets: {} };
}

export function saveCache(cache: TweetCache): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to save tweet cache');
  }
}

// ---------------------------------------------------------------------------
// Cache operations
// ---------------------------------------------------------------------------

export function pruneCache(cache: TweetCache): TweetCache {
  const now = Date.now();
  const entries = Object.entries(cache.tweets);

  // Remove expired entries
  const valid = entries.filter(([, entry]) => now - entry.cachedAt < CACHE_TTL_MS);

  // If still over limit, keep newest
  const sorted = valid.sort(([, a], [, b]) => b.cachedAt - a.cachedAt);
  const kept = sorted.slice(0, CACHE_MAX_ENTRIES);

  return {
    version: 1,
    tweets: Object.fromEntries(kept),
  };
}

export function cacheTweets(entries: readonly TweetCacheEntry[]): void {
  const cache = loadCache();

  for (const entry of entries) {
    if (entry.id) {
      cache.tweets[entry.id] = entry;
    }
  }

  saveCache(pruneCache(cache));
}

export function getCachedTweet(tweetId: string): TweetCacheEntry | null {
  const cache = loadCache();
  const entry = cache.tweets[tweetId];
  if (!entry) return null;

  const age = Date.now() - entry.cachedAt;
  if (age >= CACHE_TTL_MS) return null;

  return entry;
}

// ---------------------------------------------------------------------------
// Adapter functions (convert script output shapes -> TweetCacheEntry)
// ---------------------------------------------------------------------------

export function cacheTweetsFromSearch(tweets: readonly SearchTweet[]): void {
  const now = Date.now();
  const entries: TweetCacheEntry[] = tweets
    .filter((t) => t.id)
    .map((t) => ({
      id: t.id,
      author: t.author,
      handle: t.handle,
      content: t.content,
      timestamp: t.timestamp,
      url: t.url,
      likes: t.likes,
      retweets: t.retweets,
      replies: t.replies,
      views: t.views,
      ...(t.quotedTweet ? { quotedTweet: t.quotedTweet } : {}),
      cachedAt: now,
    }));

  if (entries.length > 0) {
    logger.info({ count: entries.length }, 'Caching tweets from search results');
    cacheTweets(entries);
  }
}

export function cacheTweetsFromProfile(profileData: ProfileData): void {
  // Profile tweets lack IDs, URLs, and metrics -- not cacheable for scrape-tweet lookups.
  // This is a no-op but kept as a hook for future enrichment.
  logger.debug({ username: profileData.username }, 'Profile tweets lack IDs, skipping cache');
}

export function cacheTweetFromScrape(tweetId: string | null, data: ScrapedTweetData): void {
  if (!tweetId) return;

  const now = Date.now();
  const entry: TweetCacheEntry = {
    id: tweetId,
    author: data.author,
    handle: data.handle,
    content: data.content,
    timestamp: data.timestamp,
    url: `https://x.com/i/status/${tweetId}`,
    likes: parseInt(data.metrics.likes, 10) || 0,
    retweets: parseInt(data.metrics.reposts, 10) || 0,
    replies: parseInt(data.metrics.replies, 10) || 0,
    views: parseInt(data.metrics.views, 10) || 0,
    ...(data.quotedTweet ? { quotedTweet: data.quotedTweet } : {}),
    cachedAt: now,
  };

  logger.info({ tweetId }, 'Caching freshly scraped tweet');
  cacheTweets([entry]);
}

// ---------------------------------------------------------------------------
// Format cached tweet for display (matches scrape-tweet output format)
// ---------------------------------------------------------------------------

export function formatCachedTweet(entry: TweetCacheEntry): string {
  const lines: string[] = [];
  lines.push(`${entry.author} (${entry.handle})`);
  lines.push(entry.content);
  lines.push(`Time: ${entry.timestamp}`);
  lines.push(`Replies: ${entry.replies} | Reposts: ${entry.retweets} | Likes: ${entry.likes} | Views: ${entry.views}`);

  if (entry.quotedTweet) {
    lines.push(`\nQuoting ${entry.quotedTweet.author}:`);
    lines.push(entry.quotedTweet.content);
  }

  lines.push('\n[Served from cache]');

  return lines.join('\n');
}
