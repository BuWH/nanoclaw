#!/usr/bin/env npx tsx
/**
 * X Integration - Scrape Home Timeline
 * Extracts tweets from the authenticated user's home timeline (Following feed).
 * Usage: echo '{"maxTweets":20}' | npx tsx scrape-timeline.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface TimelineInput {
  maxTweets?: number;
}

interface TimelineTweet {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  isRetweet: boolean;
  retweetedBy?: string;
  hasMedia: boolean;
  quotedTweet?: {
    author: string;
    content: string;
  };
}

async function scrapeTimeline(input: TimelineInput): Promise<ScriptResult> {
  const { maxTweets = 20 } = input;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    // Navigate to home timeline
    await page.goto('https://x.com/home', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if logged in - if we see login prompts, auth is expired
    const loginButton = await page.locator('[data-testid="loginButton"]').isVisible().catch(() => false);
    const signupSheet = await page.locator('[data-testid="sheetDialog"]').isVisible().catch(() => false);
    if (loginButton || signupSheet) {
      return { success: false, message: 'Not logged in to X. Please run the setup script to re-authenticate.' };
    }

    // Try to switch to "Following" tab for chronological feed
    const followingTab = page.locator('text=Following').first();
    const hasFollowingTab = await followingTab.isVisible().catch(() => false);
    if (hasFollowingTab) {
      await followingTab.click();
      await page.waitForTimeout(config.timeouts.afterClick);
    }

    // Wait for timeline to load
    await page.locator('article[data-testid="tweet"]').first().waitFor({ timeout: 10000 }).catch(() => {});

    const tweets: TimelineTweet[] = [];
    let scrollAttempts = 0;
    const maxScrolls = 5;

    while (tweets.length < maxTweets && scrollAttempts < maxScrolls) {
      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();

      for (let i = tweets.length; i < Math.min(count, maxTweets); i++) {
        const article = articles.nth(i);

        // Check for "reposted" social context (retweet indicator)
        let isRetweet = false;
        let retweetedBy: string | undefined;
        const socialContext = await article.locator('[data-testid="socialContext"]').innerText().catch(() => '');
        if (socialContext.includes('reposted')) {
          isRetweet = true;
          retweetedBy = socialContext.replace(/\s*reposted$/, '').trim();
        }

        // Extract author
        const authorText = await article.locator('[data-testid="User-Name"]').first().innerText().catch(() => '');
        const parts = authorText.split('\n').filter(Boolean);
        const author = parts[0] || '';
        const handle = parts.find(p => p.startsWith('@')) || '';

        // Extract content
        const content = await article.locator('[data-testid="tweetText"]').first().innerText().catch(() => '');

        // Extract timestamp
        const timestamp = await article.locator('time').first().getAttribute('datetime').catch(() => '') || '';

        // Check for media
        const hasMedia = await article.locator('[data-testid="tweetPhoto"], video').first().isVisible().catch(() => false);

        // Check for quoted tweet
        let quotedTweet: TimelineTweet['quotedTweet'] | undefined;
        const quotedEl = article.locator('[data-testid="quoteTweet"]').first();
        const hasQuote = await quotedEl.isVisible().catch(() => false);
        if (hasQuote) {
          const qAuthor = await quotedEl.locator('[data-testid="User-Name"]').first().innerText().catch(() => '');
          const qContent = await quotedEl.locator('[data-testid="tweetText"]').first().innerText().catch(() => '');
          quotedTweet = { author: qAuthor.split('\n')[0] || '', content: qContent };
        }

        tweets.push({
          author,
          handle,
          content,
          timestamp,
          isRetweet,
          ...(retweetedBy ? { retweetedBy } : {}),
          hasMedia,
          ...(quotedTweet ? { quotedTweet } : {}),
        });
      }

      if (tweets.length >= maxTweets) break;

      // Scroll for more tweets
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(config.timeouts.pageLoad);
      scrollAttempts++;
    }

    if (tweets.length === 0) {
      return { success: false, message: 'No tweets found in timeline. The page may not have loaded correctly.' };
    }

    return {
      success: true,
      message: formatTimelineOutput(tweets),
      data: tweets,
    };

  } finally {
    if (context) await context.close();
  }
}

function formatTimelineOutput(tweets: TimelineTweet[]): string {
  const lines: string[] = [];
  lines.push(`Home Timeline (${tweets.length} tweets)`);
  lines.push('');

  for (const tweet of tweets) {
    const prefix = tweet.isRetweet && tweet.retweetedBy
      ? `[RT by ${tweet.retweetedBy}] `
      : '';
    const media = tweet.hasMedia ? ' [media]' : '';
    lines.push(`${prefix}${tweet.author} (${tweet.handle})${media}`);
    lines.push(tweet.content);
    if (tweet.quotedTweet) {
      lines.push(`  > Quoting ${tweet.quotedTweet.author}: ${tweet.quotedTweet.content}`);
    }
    lines.push(`  ${tweet.timestamp}`);
    lines.push('');
  }

  return lines.join('\n');
}

runScript<TimelineInput>(scrapeTimeline);
