/**
 * X Integration IPC Handler
 *
 * Handles all x_* IPC messages from container agents.
 * This is the entry point for X integration in the host process.
 */
/**
 * Handle X integration IPC messages
 *
 * @returns true if message was handled, false if not an X message
 */
export declare function handleXIpc(data: Record<string, unknown>, sourceGroup: string, isMain: boolean, dataDir: string): Promise<boolean>;
//# sourceMappingURL=host.d.ts.map