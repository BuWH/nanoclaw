#!/usr/bin/env npx tsx
/**
 * X Integration - Scrape User Profile / Timeline
 * Extracts recent tweets from a user's profile page.
 * Usage: echo '{"username":"elonmusk","maxTweets":10}' | npx tsx scrape-profile.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface ProfileInput {
  username: string;
  maxTweets?: number;
}

interface ProfileTweet {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  isRetweet: boolean;
  isPinned: boolean;
}

interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
  followersCount: string;
  followingCount: string;
  tweets: ProfileTweet[];
}

async function scrapeProfile(input: ProfileInput): Promise<ScriptResult> {
  const { username, maxTweets = 10 } = input;

  if (!username) {
    return { success: false, message: 'Please provide a username' };
  }

  // Strip @ if present
  const cleanUsername = username.replace(/^@/, '');

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto(`https://x.com/${cleanUsername}`, {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if profile exists
    const notFound = await page.locator('text=This account doesn').isVisible().catch(() => false);
    const suspended = await page.locator('text=Account suspended').isVisible().catch(() => false);
    if (notFound || suspended) {
      return { success: false, message: `Profile @${cleanUsername} not found or suspended` };
    }

    // Extract profile info
    const displayName = await page.locator('[data-testid="UserName"]').first().innerText()
      .then(t => t.split('\n')[0] || '')
      .catch(() => '');

    const bio = await page.locator('[data-testid="UserDescription"]').first().innerText().catch(() => '');

    // Extract follower/following counts from the profile header area
    const followingLink = page.locator(`a[href="/${cleanUsername}/following"]`).first();
    const followersLink = page.locator(`a[href="/${cleanUsername}/verified_followers"], a[href="/${cleanUsername}/followers"]`).first();

    const followingCount = await followingLink.innerText().catch(() => '0');
    const followersCount = await followersLink.innerText().catch(() => '0');

    // Scroll to load tweets
    const tweets: ProfileTweet[] = [];
    let scrollAttempts = 0;
    const maxScrolls = 3;

    while (tweets.length < maxTweets && scrollAttempts < maxScrolls) {
      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();

      for (let i = tweets.length; i < Math.min(count, maxTweets); i++) {
        const article = articles.nth(i);

        const authorText = await article.locator('[data-testid="User-Name"]').first().innerText().catch(() => '');
        const parts = authorText.split('\n').filter(Boolean);
        const author = parts[0] || '';
        const handle = parts.find(p => p.startsWith('@')) || '';

        const content = await article.locator('[data-testid="tweetText"]').first().innerText().catch(() => '');
        const timestamp = await article.locator('time').first().getAttribute('datetime').catch(() => '') || '';

        // Check if it's a retweet (different author than profile owner)
        const isRetweet = handle !== `@${cleanUsername}`;

        // Check for pinned indicator
        const isPinned = await article.locator('text=Pinned').isVisible().catch(() => false);

        tweets.push({ author, handle, content, timestamp, isRetweet, isPinned });
      }

      if (tweets.length >= maxTweets) break;

      // Scroll for more
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(config.timeouts.pageLoad);
      scrollAttempts++;
    }

    const profileData: ProfileData = {
      username: cleanUsername,
      displayName,
      bio,
      followersCount,
      followingCount,
      tweets,
    };

    return {
      success: true,
      message: formatProfileOutput(profileData),
      data: profileData,
    };

  } finally {
    if (context) await context.close();
  }
}

function formatProfileOutput(profile: ProfileData): string {
  const lines: string[] = [];
  lines.push(`${profile.displayName} (@${profile.username})`);
  lines.push(profile.bio);
  lines.push(`Following: ${profile.followingCount} | Followers: ${profile.followersCount}`);
  lines.push('');

  for (const tweet of profile.tweets) {
    const prefix = tweet.isPinned ? '[Pinned] ' : tweet.isRetweet ? `[RT ${tweet.handle}] ` : '';
    lines.push(`${prefix}${tweet.content}`);
    lines.push(`  ${tweet.timestamp}`);
    lines.push('');
  }

  return lines.join('\n');
}

runScript<ProfileInput>(scrapeProfile);
