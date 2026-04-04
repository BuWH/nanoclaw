# Daily Digest Migration: X tools to OpenCLI tools

## Tool Name Changes

| Old Tool Name | New Tool Name |
|---|---|
| `x_search_tweets` | `opencli_twitter_search` |
| `x_scrape_tweet` | `opencli_twitter_scrape` |
| `x_scrape_profile` | `opencli_twitter_profile` |
| `x_timeline` | `opencli_twitter_timeline` |

## New Capabilities

- `opencli_twitter_timeline` provides richer data (replies, retweets, views per tweet)
- `opencli_xhs_search` / `opencli_xhs_note` / `opencli_xhs_user` for Xiaohongshu
- `opencli_run` for generic opencli commands (hackernews, reddit, youtube, weibo, etc.)

## Updated Prompt Template

The daily digest task should use both `opencli_twitter_search` and `opencli_twitter_timeline` for a comprehensive view:

```
1. Use opencli_twitter_timeline (type: for-you, max_tweets: 30) to get the algorithmic feed
2. Use opencli_twitter_search with relevant topic queries to find trending discussions
3. Combine results into a daily digest, deduplicating tweets that appear in both
4. Summarize key themes and notable tweets
```

## Migration Instructions

Update existing scheduled tasks using one of these methods:

### Option A: Replace via schedule_task

Use `schedule_task` with `replace_task_id` set to the old task ID:

```
1. Call list_tasks to find the existing daily digest task ID
2. Call schedule_task with:
   - replace_task_id: <old-task-id>
   - prompt: (updated prompt using new tool names)
   - Same schedule_type and schedule_value as before
```

### Option B: Update prompt via update_task

Use `update_task` to change just the prompt:

```
1. Call list_tasks to find the task ID
2. Call update_task with:
   - task_id: <task-id>
   - prompt: (updated prompt using new tool names)
```

## Notes

- Old `x_*` tool names no longer exist in the container MCP server
- Tasks referencing old tool names will fail until updated
- The underlying opencli binary handles authentication automatically
- All opencli commands append `-f json` for structured output
