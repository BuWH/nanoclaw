# NanoClaw Development Guide

## Architecture

NanoClaw is a multi-channel AI agent orchestrator. Host process (Node.js/TypeScript) manages messaging channels (Telegram, WhatsApp) and spawns Docker containers for each agent task. Containers run the Claude Agent SDK with MCP tools, communicating results via IPC files.

```
Host Process (src/index.ts)
  |-- Channel adapters (Telegram, WhatsApp)
  |-- GroupQueue (concurrency management)
  |-- IPC Watcher (file-based communication)
  |-- Container Runner (Docker spawn)
  |-- Credential Proxy (API key injection)
  |
  v
Docker Container (container/agent-runner/src/index.ts)
  |-- Claude Agent SDK (query loop)
  |-- MCP Server (ipc-mcp-stdio.ts)
  |-- browser-agent (Python/Chromium, optional)
```

Key files:
- `src/index.ts` -- Host entry point, message loop, container orchestration
- `src/container-runner.ts` -- Docker spawn, stdin/stdout protocol, timeout handling
- `src/group-queue.ts` -- Priority queue, concurrency limits, idle management
- `src/ipc.ts` -- File-based IPC watcher, dispatches to handlers
- `src/session-rotation.ts` -- Session lifecycle, JSONL cleanup, rotation
- `container/agent-runner/src/index.ts` -- In-container agent loop
- `container/agent-runner/src/ipc-mcp-stdio.ts` -- Container-side MCP tools

## Critical: Container Memory

Container OOM (exit 137) is the most common failure mode. Read `docs/2026-03-28-oom-crash-investigation.md` for the full investigation.

Key rules:
- **Session continuity is paramount**. A `resume` session uses 2-4GB less peak memory than a `new` session. If the session is lost (crash without save), the container enters a vicious cycle of new-session -> OOM -> new-session.
- **Orphan JSONL cleanup** runs before each spawn (`cleanupOrphanSessionFiles`). Never skip this.
- **Memory limit** is 12GB default (`CONTAINER_MEMORY_LIMIT`). Node.js heap is capped at 67% of this.
- **Host-side IPC** is the pattern for memory-heavy tools. Chromium, Python scripts, etc. should run on the host via IPC, not inside the container. See `src/browser-ipc.ts`, `src/x-ipc.ts`, `src/chrome-ipc.ts`.

## Testing

### Run Tests
```bash
bun test                    # All 511 tests
bun test -- --watch         # Watch mode
bun test -- src/e2e-real-container.test.ts  # Real Docker E2E
npx tsc --noEmit            # Type check only
```

### Test Architecture
- **Unit tests** (`*.test.ts`): Mock-based, fast, no Docker needed
- **E2E tests** (`e2e.test.ts`): Full pipeline with fake channels and mocked containers
- **Real container tests** (`e2e-real-container.test.ts`): Spawns actual Docker containers, auto-skips if Docker unavailable

### What to Test After Changes

| Change area | Required tests |
|-------------|---------------|
| Container runner / spawn args | `container-runner.test.ts`, `e2e-real-container.test.ts` |
| IPC handlers (x_, chrome_, browser_, codex_) | `x-ipc.test.ts`, `ipc-auth.test.ts` |
| Session rotation / cleanup | `session-rotation.test.ts` |
| Message routing / formatting | `routing.test.ts`, `formatting.test.ts` |
| Group queue / concurrency | `group-queue.test.ts`, `e2e-queue.test.ts` |
| Database operations | `db.test.ts` |

### Container Verification (without Telegram)

To verify container behavior without sending messages through a channel:

```bash
# 1. Build the container
bash container/build.sh

# 2. Run the real container E2E test
bun test -- src/e2e-real-container.test.ts

# 3. Manual smoke test: spawn a container directly
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@test","isMain":false}' | \
  docker run -i --rm --memory 12g nanoclaw-agent:latest

# 4. Check memory usage of a running container
docker stats --no-stream

# 5. Check container logs after a run
ls -lt groups/main/logs/ | head -5
cat groups/main/logs/<latest>.log
```

### Missing Tests (TODOs)

- Memory pressure test: verify container survives typical workload at configured limit
- Session resume vs new: verify resume uses less memory
- Orphan JSONL cleanup test: verify files are cleaned before spawn
- Host-side IPC integration: verify browse_web, x_scrape_tweet end-to-end
- Multi-container concurrency: verify no OOM when 2+ containers run simultaneously

## Development Workflow

### Build & Deploy
```bash
npm run build               # Compile TypeScript (host)
bash container/build.sh     # Rebuild Docker image (picks up agent-runner changes)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # Restart service
```

### Key Directories
```
src/              Host-side TypeScript source
container/        Docker image (Dockerfile, agent-runner, browser-agent, skills)
groups/           Per-group workspace (CLAUDE.md, conversations, logs)
data/             Runtime data (sessions, IPC, browser-state, DB)
store/            SQLite database (messages.db)
docs/             Architecture docs, investigation reports
```

### IPC Pattern (for new host-side tools)

When adding a tool that needs resources outside the container (Chromium, native APIs, host filesystem):

1. Add MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts` (container calls this)
2. Create `src/<name>-ipc.ts` handler (host runs the actual work)
3. Register dispatch in `src/ipc.ts` (match on type prefix)
4. Container writes to `/workspace/ipc/tasks/`, host writes result to `/workspace/ipc/<group>/<name>_results/`

Follow `src/browser-ipc.ts` or `src/chrome-ipc.ts` as templates.

## Debugging

```bash
# Service logs (pino JSON format)
tail -f logs/nanoclaw.log | npx pino-pretty

# Container crash logs
ls -lt groups/main/logs/ | head -5
cat groups/main/logs/<file>.log

# Check session state
sqlite3 store/messages.db "SELECT * FROM sessions;"
sqlite3 store/messages.db "SELECT * FROM router_state;"

# Check session transcript size
du -sh data/sessions/main/.claude/projects/

# Check for orphan JSONL files
ls -lh data/sessions/main/.claude/projects/-workspace-group/*.jsonl

# Docker memory
docker stats --no-stream
docker info | grep "Total Memory"
```
