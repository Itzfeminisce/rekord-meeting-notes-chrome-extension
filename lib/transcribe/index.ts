// Stub entry point for the transcriber; T3 replaces this with the real queue.

/** Queues a saved pending chunk for transcription. */
export function enqueue(_chunkId: string): void {}

/** Resolves once no chunks of `meetingId` are waiting for transcription. */
export async function drain(_meetingId: string): Promise<void> {}
