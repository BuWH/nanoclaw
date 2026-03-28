import fs from 'fs';
import path from 'path';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// 5MB threshold: rotate before sessions get large enough to cause OOM in
// containers running browser-use (Chromium) alongside the SDK.
// The SDK auto-compacts at ~95% context window usage, but accumulated
// JSONL files still consume memory during container startup.
const SESSION_ROTATION_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Delete JSONL files that do not belong to the current session.
 * After OOM crashes the container creates a new session, but the old
 * session's JSONL files remain on disk.  Over time these orphans accumulate
 * and inflate getSessionTranscriptSize(), eventually triggering an
 * unnecessary rotation that deletes the *current* session too.
 *
 * Call this before each container spawn so only the active session's
 * transcript is present when the SDK loads.
 */
export function cleanupOrphanSessionFiles(
  groupFolder: string,
  currentSessionId: string | undefined,
): number {
  if (!currentSessionId) return 0;

  const sessionProjectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );

  if (!fs.existsSync(sessionProjectsDir)) return 0;

  let deletedCount = 0;
  const currentFile = `${currentSessionId}.jsonl`;

  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.jsonl') && entry.name !== currentFile) {
        try {
          fs.unlinkSync(fullPath);
          deletedCount++;
        } catch {
          /* ignore */
        }
      }
    }
  };

  try {
    walkDir(sessionProjectsDir);
  } catch {
    /* ignore */
  }

  if (deletedCount > 0) {
    logger.info(
      { groupFolder, currentSessionId, deletedCount },
      'Cleaned up orphan session JSONL files',
    );
  }

  return deletedCount;
}

const RECENT_MESSAGES_TO_KEEP = 20;

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RotationResult {
  rotated: boolean;
  previousSessionId?: string;
  summaryPath?: string;
}

/**
 * Measure total size of JSONL transcript files for a group's session.
 * Returns 0 if the session directory doesn't exist.
 */
export function getSessionTranscriptSize(groupFolder: string): number {
  const sessionProjectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );

  if (!fs.existsSync(sessionProjectsDir)) {
    return 0;
  }

  let totalSize = 0;
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        totalSize += fs.statSync(fullPath).size;
      }
    }
  };

  try {
    walkDir(sessionProjectsDir);
  } catch (err) {
    logger.debug(
      { groupFolder, err },
      'Failed to measure session transcript size',
    );
    return 0;
  }

  return totalSize;
}

/**
 * Check whether a group's session transcript exceeds the rotation threshold.
 */
export function shouldRotateSession(groupFolder: string): boolean {
  const size = getSessionTranscriptSize(groupFolder);
  return size > SESSION_ROTATION_THRESHOLD_BYTES;
}

/**
 * Parse JSONL transcript files into user/assistant message pairs.
 * Finds the most recent transcript file and extracts text content.
 */
function findLatestTranscript(groupFolder: string): string | null {
  const sessionProjectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );

  if (!fs.existsSync(sessionProjectsDir)) {
    return null;
  }

  // Find the most recently modified .jsonl file
  let latestPath: string | null = null;
  let latestMtime = 0;

  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestPath = fullPath;
        }
      }
    }
  };

  walkDir(sessionProjectsDir);
  return latestPath;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/**
 * Generate a context summary from the last N messages of a session transcript.
 * Written to the group folder so the agent sees it in its next session.
 */
function writeSessionContext(
  groupFolder: string,
  messages: ParsedMessage[],
): string {
  const recent = messages.slice(-RECENT_MESSAGES_TO_KEEP);
  const groupDir = path.resolve(GROUPS_DIR, groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const contextPath = path.join(groupDir, 'session-context.md');

  const lines: string[] = [];
  lines.push('# Recent Session Context');
  lines.push('');
  lines.push(
    'This file contains the most recent messages from a previous session.',
  );
  lines.push(
    'It was auto-generated during session rotation. Refer to conversations/ for full history.',
  );
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of recent) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant';
    const content =
      msg.content.length > 1500
        ? msg.content.slice(0, 1500) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  fs.writeFileSync(contextPath, lines.join('\n'));
  return contextPath;
}

/**
 * Archive the full conversation transcript to conversations/ before cleanup.
 * This mirrors what createPreCompactHook() does inside the container, ensuring
 * we never lose the full history when rotation happens before SDK compaction.
 */
function archiveFullTranscript(
  groupFolder: string,
  transcriptPath: string,
  messages: ParsedMessage[],
): void {
  if (messages.length === 0) return;

  const groupDir = path.resolve(GROUPS_DIR, groupFolder);
  const conversationsDir = path.join(groupDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const time = new Date();
  const timeStr = `${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
  const filename = `${date}-rotation-${timeStr}.md`;
  const filePath = path.join(conversationsDir, filename);

  const lines: string[] = [];
  lines.push('# Session Transcript (Rotation Archive)');
  lines.push('');
  lines.push(`Archived: ${new Date().toISOString()}`);
  lines.push(`Source: ${path.basename(transcriptPath)}`);
  lines.push(`Messages: ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'));
  logger.debug(
    { groupFolder, filePath, messageCount: messages.length },
    'Archived full transcript before rotation cleanup',
  );
}

/**
 * Delete all JSONL transcript files and their companion directories
 * for a group's session. Called after rotation to free disk space and
 * prevent stale files from inflating getSessionTranscriptSize() on
 * subsequent checks.
 */
function cleanupSessionFiles(groupFolder: string): number {
  const sessionProjectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );

  if (!fs.existsSync(sessionProjectsDir)) {
    return 0;
  }

  let deletedCount = 0;
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
        // Remove empty session subdirectories (companion dirs for JSONL files)
        try {
          const remaining = fs.readdirSync(fullPath);
          if (remaining.length === 0) {
            fs.rmdirSync(fullPath);
          }
        } catch {
          /* ignore */
        }
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          fs.unlinkSync(fullPath);
          deletedCount++;
        } catch (err) {
          logger.debug(
            { file: fullPath, err },
            'Failed to delete session transcript file',
          );
        }
      }
    }
  };

  try {
    walkDir(sessionProjectsDir);
  } catch (err) {
    logger.debug(
      { groupFolder, err },
      'Failed to walk session projects directory during cleanup',
    );
  }

  return deletedCount;
}

/**
 * Rotate a group's session: extract recent context, write a bridge file,
 * and signal that the session should be cleared.
 *
 * Does NOT modify the database or in-memory session map -- the caller is
 * responsible for clearing the sessionId after rotation.
 */
export function rotateSession(
  groupFolder: string,
  sessionId: string,
): RotationResult {
  try {
    const transcriptPath = findLatestTranscript(groupFolder);
    let summaryPath: string | undefined;

    if (transcriptPath) {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length > 0) {
        summaryPath = writeSessionContext(groupFolder, messages);
        // Archive the full transcript to conversations/ before we delete
        // the JSONL files. This ensures no conversation history is lost
        // when rotation happens before the SDK's PreCompact hook fires.
        archiveFullTranscript(groupFolder, transcriptPath, messages);
      }
    }

    const sizeMB = (
      getSessionTranscriptSize(groupFolder) /
      1024 /
      1024
    ).toFixed(1);

    // Delete old transcript files to free disk space and prevent
    // getSessionTranscriptSize() from triggering rotation forever.
    const deletedFiles = cleanupSessionFiles(groupFolder);

    logger.info(
      {
        groupFolder,
        previousSessionId: sessionId,
        sizeMB,
        summaryPath,
        deletedFiles,
      },
      'Session rotated: transcript exceeded threshold',
    );

    return {
      rotated: true,
      previousSessionId: sessionId,
      summaryPath,
    };
  } catch (err) {
    logger.error(
      { groupFolder, err },
      'Failed to rotate session, continuing with existing session',
    );
    return { rotated: false };
  }
}
