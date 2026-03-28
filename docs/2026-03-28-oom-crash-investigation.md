# OOM Crash Investigation Report (2026-03-28)

## Timeline

| Period | Status | Session Behavior | Memory Limit |
|--------|--------|-----------------|--------------|
| Feb 21 - Mar 21 | Stable (1 crash in 30 days) | Session `fd1a3c1d` reused across runs | 4GB |
| Mar 22 - Mar 28 | Persistent crashes (22 OOM kills) | `Session ID: new` every time | 4GB -> 8GB -> 12GB |

## Root Cause Analysis

### The Vicious Cycle

The crash pattern was not caused by a single bug, but by a **self-reinforcing feedback loop**:

```
1. Cumulative feature additions (Chrome cookies, browser-state, Codex review,
   more MCP tools) pushed container startup memory past the 4GB threshold
2. First OOM crash (exit 137) killed the container before session could be saved
3. Next container starts with Session ID: new (no resume possible)
4. New sessions cost significantly more memory than resume:
   - Full directory scanning (CLAUDE.md discovery across all mounts)
   - All MCP servers initialized from scratch (nanoclaw, tavily, notion, things)
   - TypeScript compilation (npx tsc) on every startup
   - All tools registered and loaded
5. Higher startup memory -> more likely to OOM -> crash -> new session again
6. Meanwhile, orphan JSONL files from crashed sessions accumulate on disk
   (8 files / 2.6MB), inflating getSessionTranscriptSize()
7. Orphan accumulation risks triggering unnecessary session rotation,
   which would delete the current valid session too
```

### Evidence

**Before the cycle (3/21, working)**:
```
container-2026-03-21T14-11-51-012Z.log
  Exit Code: 0
  Session ID: fd1a3c1d-971f-47df-8f85-b2e13aa0c7bc  <- REUSED
  Duration: 182970ms
```

**After the cycle started (3/22+, crashing)**:
```
container-2026-03-28T14-57-25-743Z.log
  Exit Code: 137
  Session ID: new  <- ALWAYS NEW
  Duration: 532247ms
  Messages processed: 65 (result sent at msg #65, then OOM)
```

### Contributing Factors (not root causes)

| Factor | Impact | Why it's not the root cause |
|--------|--------|-----------------------------|
| `additionalDirectories` passing entire ~/code (22GB) | High startup memory | Reduced to 5 CLAUDE.md-containing subdirs |
| Subagent spawning (Task/Team) with browser-agent | +3-5GB per subagent | Mitigated via host-side `browse_web` MCP tool |
| Container memory limit too low (4GB -> 8GB -> 12GB) | Hard ceiling for OOM kill | Increased to 12GB but doesn't fix the cycle |
| No NODE_OPTIONS heap cap | Silent SIGKILL instead of JS error | Added dynamic 67% cap |

## Fixes Applied

### 1. Orphan Session Cleanup (Root cause fix)

**File**: `src/session-rotation.ts` + `src/index.ts`

Added `cleanupOrphanSessionFiles()` that deletes JSONL files not belonging to the current session, called before each container spawn. This breaks the vicious cycle by:
- Preventing orphan accumulation
- Keeping `getSessionTranscriptSize()` accurate
- Ensuring session rotation only triggers when genuinely needed

### 2. additionalDirectories Filter

**File**: `container/agent-runner/src/index.ts`

Changed from passing entire mount roots (e.g., `/workspace/extra/code` = 22GB) to only subdirectories containing `CLAUDE.md` files. The SDK uses `additionalDirectories` for CLAUDE.md loading, not tool access restriction (tools can still access all mounted paths via Read/Bash/Edit with `bypassPermissions`).

### 3. Memory Limit Increase (8GB -> 12GB)

**File**: `src/config.ts`

Provides headroom for legitimate multi-process workloads (SDK + MCP servers + potential browser-agent).

### 4. Dynamic Node.js Heap Cap

**File**: `src/container-runner.ts`

`NODE_OPTIONS=--max-old-space-size` is now derived as 67% of `CONTAINER_MEMORY_LIMIT`, leaving 33% for Chromium, Python, and OS overhead. V8 will trigger GC or throw a JS-level OOM error instead of a silent SIGKILL 137.

### 5. Host-side Browser Agent (`browse_web` MCP tool)

**Files**: `src/browser-ipc.ts`, `src/ipc.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`

New MCP tool that runs browser-agent on the HOST via IPC (same pattern as `x_scrape_tweet`). Container agent calls `browse_web`, host spawns Chromium with `uv run`, result returns via IPC file polling. Zero container memory impact.

### 6. CLAUDE.md Agent Guidance

**File**: `groups/main/CLAUDE.md`

Added X/Twitter content section directing the agent to use MCP tools instead of browser-agent, plus memory constraints section.

## Codex Review Cross-Validation

Codex CLI reviewed PR #32 and raised two findings:

| Finding | Severity | Assessment |
|---------|----------|------------|
| P1: Removing dirs from `additionalDirectories` breaks tool access | Claimed regression | **False positive** -- `additionalDirectories` controls CLAUDE.md loading, not tool access. With `bypassPermissions`, tools access any path. |
| P2: Hard-coded NODE_OPTIONS ignores CONTAINER_MEMORY_LIMIT overrides | Valid issue | **Fixed** -- now derives 67% of container limit dynamically |

## Key Architectural Insight

The Claude Agent SDK's `resume` vs `new` session has dramatically different memory profiles:

- **Resume**: SDK loads existing session state, skips directory scanning, MCP servers may already be warm
- **New**: Full initialization -- scan all directories, load all CLAUDE.md files, start all MCP servers, compile TypeScript, register all tools

In a container with 12GB limit running multiple MCP servers (nanoclaw, tavily, notion, things), the difference between resume and new session can be 2-4GB of peak memory. This is why session continuity is critical for container stability.

## Prevention: What We Need

### Automated Container Memory Testing

The current test suite (511 tests, 17 files) has extensive unit and E2E coverage but lacks:

1. **Memory pressure tests**: Verify a container can handle typical workloads without OOM at the configured memory limit
2. **Session resume tests**: Verify that resuming an existing session uses less memory than starting a new one
3. **Orphan cleanup tests**: Verify that orphan JSONL files are cleaned up before each spawn
4. **MCP tool integration tests**: Verify that host-side IPC tools (x_scrape_tweet, browse_web) work end-to-end

The existing `src/e2e-real-container.test.ts` already spawns real Docker containers. Extend it with:

```typescript
it('container survives typical MCP workload at configured memory limit', async () => {
  // Spawn container with production memory limit
  // Send a prompt that triggers MCP tool usage
  // Verify exit code is 0 (not 137)
  // Verify output markers are present
});

it('orphan JSONL files are cleaned before spawn', async () => {
  // Create fake orphan JSONL files
  // Run container
  // Verify orphans were deleted
});
```

See `src/e2e-real-container.test.ts` for the existing Docker spawn pattern.
