/** A byte queue of appended Buffers that hands out fixed-size slices without
 *  copying until a slice is taken. */
export class PendingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  get byteLength(): number {
    return this.totalBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  /** Removes and returns up to `byteLength` bytes from the front. */
  take(byteLength: number): Buffer {
    if (byteLength <= 0 || this.totalBytes === 0) return Buffer.alloc(0);

    const parts: Buffer[] = [];
    let remaining = Math.min(byteLength, this.totalBytes);

    while (remaining > 0 && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      if (head.length <= remaining) {
        parts.push(head);
        this.chunks.shift();
        this.totalBytes -= head.length;
        remaining -= head.length;
        continue;
      }

      parts.push(head.subarray(0, remaining));
      this.chunks[0] = head.subarray(remaining);
      this.totalBytes -= remaining;
      remaining = 0;
    }

    return Buffer.concat(parts);
  }

  takeAll(): Buffer {
    return this.take(this.totalBytes);
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
