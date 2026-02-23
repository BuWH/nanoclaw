#!/usr/bin/env npx tsx
/**
 * X Integration - Scrape Tweet
 * Extracts tweet content, author, metrics, and replies from a tweet page.
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx scrape-tweet.ts
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';

interface ScrapeInput {
  tweetUrl: string;
  includeReplies?: boolean;
  maxReplies?: number;
}

interface TweetData {
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
  replies: Array<{
    author: string;
    handle: string;
    content: string;
  }>;
  quotedTweet?: {
    author: string;
    content: string;
  };
}

async function scrapeTweet(input: ScrapeInput): Promise<ScriptResult> {
  const { tweetUrl, includeReplies = false, maxReplies = 10 } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      return { success: false, message: error || 'Navigation failed' };
    }

    // Wait for tweet content to load
    const mainTweet = page.locator('article[data-testid="tweet"]').first();
    await mainTweet.waitFor({ timeout: config.timeouts.elementWait });

    // Extract author info
    const authorName = await mainTweet.locator('[data-testid="User-Name"]').first().innerText().catch(() => '');
    const parts = authorName.split('\n').filter(Boolean);
    const author = parts[0] || '';
    const handle = parts.find(p => p.startsWith('@')) || '';

    // Extract tweet text
    const tweetTextEl = mainTweet.locator('[data-testid="tweetText"]').first();
    const content = await tweetTextEl.innerText().catch(() => '');

    // Extract timestamp
    const timeEl = mainTweet.locator('time').first();
    const timestamp = await timeEl.getAttribute('datetime').catch(() => '') || '';

    // Extract metrics from the tweet detail page
    // On detail pages, metrics appear below the tweet as text spans
    const metricsText = await page.locator('[role="group"][aria-label]').first().getAttribute('aria-label').catch(() => '');
    const metrics = {
      replies: extractMetric(metricsText || '', /(\d[\d,.]*)\s*repl/i),
      reposts: extractMetric(metricsText || '', /(\d[\d,.]*)\s*repost/i),
      likes: extractMetric(metricsText || '', /(\d[\d,.]*)\s*like/i),
      views: extractMetric(metricsText || '', /(\d[\d,.]*)\s*view/i),
      bookmarks: extractMetric(metricsText || '', /(\d[\d,.]*)\s*bookmark/i),
    };

    // Extract quoted tweet if present
    let quotedTweet: TweetData['quotedTweet'] | undefined;
    const quotedEl = mainTweet.locator('[data-testid="quoteTweet"]').first();
    const hasQuote = await quotedEl.isVisible().catch(() => false);
    if (hasQuote) {
      const qAuthor = await quotedEl.locator('[data-testid="User-Name"]').first().innerText().catch(() => '');
      const qContent = await quotedEl.locator('[data-testid="tweetText"]').first().innerText().catch(() => '');
      quotedTweet = { author: qAuthor.split('\n')[0] || '', content: qContent };
    }

    // Extract replies if requested
    const replies: TweetData['replies'] = [];
    if (includeReplies) {
      // Scroll down to load replies
      await page.waitForTimeout(config.timeouts.pageLoad);

      // Get all tweet articles after the main one
      const allTweets = page.locator('article[data-testid="tweet"]');
      const count = await allTweets.count();

      // Skip first (main tweet), take up to maxReplies
      for (let i = 1; i < Math.min(count, maxReplies + 1); i++) {
        const reply = allTweets.nth(i);
        const rAuthorText = await reply.locator('[data-testid="User-Name"]').first().innerText().catch(() => '');
        const rParts = rAuthorText.split('\n').filter(Boolean);
        const rContent = await reply.locator('[data-testid="tweetText"]').first().innerText().catch(() => '');

        replies.push({
          author: rParts[0] || '',
          handle: rParts.find(p => p.startsWith('@')) || '',
          content: rContent,
        });
      }
    }

    const tweetData: TweetData = {
      author,
      handle,
      content,
      timestamp,
      metrics,
      replies,
      ...(quotedTweet ? { quotedTweet } : {}),
    };

    return {
      success: true,
      message: formatTweetOutput(tweetData),
      data: tweetData,
    };

  } finally {
    if (context) await context.close();
  }
}

function extractMetric(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  return match ? match[1] : '0';
}

function formatTweetOutput(tweet: TweetData): string {
  const lines: string[] = [];
  lines.push(`${tweet.author} (${tweet.handle})`);
  lines.push(tweet.content);
  lines.push(`Time: ${tweet.timestamp}`);
  lines.push(`Replies: ${tweet.metrics.replies} | Reposts: ${tweet.metrics.reposts} | Likes: ${tweet.metrics.likes} | Views: ${tweet.metrics.views}`);

  if (tweet.quotedTweet) {
    lines.push(`\nQuoting ${tweet.quotedTweet.author}:`);
    lines.push(tweet.quotedTweet.content);
  }

  if (tweet.replies.length > 0) {
    lines.push(`\n--- Replies (${tweet.replies.length}) ---`);
    for (const reply of tweet.replies) {
      lines.push(`\n${reply.author} (${reply.handle}):`);
      lines.push(reply.content);
    }
  }

  return lines.join('\n');
}

runScript<ScrapeInput>(scrapeTweet);
