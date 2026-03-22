---
name: self-modify
description: >
  Create a pull request to modify NanoClaw's own source code.
  Use when the user asks to change NanoClaw's behavior, add features,
  fix bugs, or update configuration. NEVER push directly to main.
---

# Self-Modify -- Create a PR to modify NanoClaw

## Prerequisites

NanoClaw source code is at `/workspace/extra/code/nanoclaw/` with read-write access.
Git and gh CLI are authenticated.

## Rules

1. NEVER push to main. Always create a feature branch.
2. NEVER merge your own PR. The user must review and merge.
3. Always create a PR, even for small changes.
4. Branch protection and a pre-push hook enforce this -- direct pushes to main will be rejected.

## Workflow

### Step 1: Sync and branch

```bash
cd /workspace/extra/code/nanoclaw
git fetch origin main
git checkout -b agent/<descriptive-name> origin/main
```

Branch naming: `agent/<verb>-<noun>` (e.g., `agent/add-discord-channel`, `agent/fix-scheduler-drift`).

### Step 2: Make changes

Edit files as needed. Source is in `src/`. After editing:

```bash
# Verify TypeScript compiles
npx tsc --noEmit

# Run tests
npx vitest run

# Format
npx prettier --write "src/**/*.ts"
```

### Step 3: Commit

```bash
git add <specific-files>
git commit -m "feat: <description>"
```

Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`.

### Step 4: Push and create PR

```bash
git push origin agent/<branch-name>
gh pr create \
  --title "<Short title>" \
  --body "## What
<Description of changes>

## Why
<Motivation>

## Testing
<How it was tested>

---
Created by NanoClaw agent via /self-modify" \
  --base main
```

### Step 5: Report to user

Tell the user:
- What was changed and why
- Link to the PR
- That they need to review and merge
- NanoClaw will auto-restart within 60 seconds after merge

### Step 6: Clean up

```bash
git checkout main
git branch -d agent/<branch-name>
```

## After Merge

NanoClaw polls origin/main every 60 seconds. After the user merges:
1. Auto-detects new commits
2. Runs `git pull --ff-only`
3. Runs `npm run build`
4. Restarts (launchd respawns)

No manual action needed from the user after merging.
