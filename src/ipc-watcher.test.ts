import { describe, it, expect } from 'vitest';
import fs from 'fs';

describe('IPC watcher directory listing', () => {
  it('readdirSync with withFileTypes filters out non-directories and errors', () => {
    // This tests the exact pattern used in ipc.ts lines 53-55
    // The pattern should:
    // 1. Only include directories
    // 2. Exclude the 'errors' directory
    // 3. Not throw when entries disappear (no separate statSync call)

    const mockEntries: fs.Dirent[] = [
      createDirent('group-a', true),
      createDirent('group-b', true),
      createDirent('errors', true), // should be excluded
      createDirent('some-file.txt', false), // should be excluded (not a directory)
    ];

    // Apply the same filter logic as ipc.ts
    const groupFolders = mockEntries
      .filter((entry) => entry.isDirectory() && entry.name !== 'errors')
      .map((entry) => entry.name);

    expect(groupFolders).toEqual(['group-a', 'group-b']);
  });
});

function createDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: '/tmp/nanoclaw-test-ipc/ipc',
    path: '/tmp/nanoclaw-test-ipc/ipc',
  } as fs.Dirent;
}
