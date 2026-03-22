---
name: codex-review
description: >
  Review a GitHub PR using Codex CLI on the host machine.
  Use when the user shares a PR link and wants code review,
  or after creating a PR via /self-modify.
---

# Codex PR Review

Request an automated code review from Codex CLI (gpt-5.3-codex) running on the host machine.

## When to Use

- User shares a GitHub PR URL and asks for review
- User asks "review this PR" or "check this code"
- After creating a PR via the self-modify skill (to catch issues before merge)
- User explicitly mentions "codex review"

## How It Works

1. Call `codex_review_pr` with the PR URL
2. The host clones the repo, checks out the PR branch
3. Codex analyzes the diff and posts review comments directly on the PR via `gh pr review`
4. Results are returned to you

## Workflow

### Step 1: Request the review

```
codex_review_pr(pr_url: "https://github.com/owner/repo/pull/123")
```

This takes 1-5 minutes. The tool blocks until Codex finishes.

### Step 2: Present results to the user

Show the user what Codex found. Summarize the key issues:
- Bugs or logic errors
- Security concerns
- Performance issues
- Code quality suggestions

### Step 3: Offer to fix

Ask the user if they want you to fix the issues Codex identified.

### Step 4: Fix issues (if user agrees)

1. Clone the repo to `/tmp/`:
   ```bash
   ORIGIN_URL=$(git -C /workspace/extra/code/nanoclaw remote get-url origin 2>/dev/null || echo "")
   # For non-NanoClaw repos, use gh:
   gh repo clone owner/repo /tmp/fix-pr-123
   cd /tmp/fix-pr-123
   gh pr checkout 123
   ```
2. Address each review comment
3. Commit with a descriptive message referencing the review
4. Push the fixes
5. Tell the user fixes have been pushed

### Step 5: Re-check (optional)

After pushing fixes, you can run `codex_review_pr` again to verify the issues are resolved.

## Supported PR URL Formats

- `https://github.com/owner/repo/pull/123`
- `github.com/owner/repo/pull/123`
- `owner/repo#123`

## Limitations

- Main group only (non-main groups cannot trigger reviews)
- Review timeout: 5 minutes
- Codex uses `gh` CLI for all GitHub operations (must be authenticated on host)
- Codex runs in `--full-auto` mode (sandbox: workspace-write, approval: on-failure)
