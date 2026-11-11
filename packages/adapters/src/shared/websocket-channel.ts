/**
 * Shared WebSocket transport for adapters that exchange raw PCM over one
 * socket: binary frames carry audio both ways, text frames carry JSON events.
 */

import WebSocket from "ws";
import { BaseAudioChannel, CONNECT_TIMEOUT_MS } from "./audio-channel.js";

export abstract class WebSocketAudioChannel extends BaseAudioChannel {
  protected ws: WebSocket | null = null;
  /** 2x real-time delivery (Pipecat: chunk_duration / 2). */
  protected override pacingIntervalMs = 10;
  /** Sample rate of the agent's audio frames. */
  protected agentSampleRate = BaseAudioChannel.INPUT_SAMPLE_RATE;
  /** Names the transport in errors. */
  protected abstract readonly label: string;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  override sendAudio(pcm: Buffer): void {
    if (!this.connected) throw new Error(`${this.label} WebSocket not connected`);
    super.sendAudio(pcm);
  }

  protected async writeAudioFrame(samples: Int16Array): Promise<void> {
    if (!this.ws || !this.connected) return;
    this.ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  /**
   * Open the socket and route its frames: binary to agent audio, text to
   * `onText`. Resolves once open — or, with `readyOnFirstText`, once the first
   * text frame arrives. Rejects on error, early close, or CONNECT_TIMEOUT_MS.
   */
  protected openSocket(
    url: string,
    options: WebSocket.ClientOptions,
    onText: (text: string) => void,
    readyOnFirstText = false,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      let settled = false;
      let opened = false;
      /** Settles the connect promise; false if it had already settled. */
      const settle = (error?: Error): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
        return true;
      };
      const timeout = setTimeout(() => {
        if (settle(new Error(`${this.label} WebSocket connection timed out after ${CONNECT_TIMEOUT_MS}ms`))) ws.close();
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        if (settled) return;
        opened = true;
        this.ws = ws;
        if (!readyOnFirstText) settle();
      });

      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (isBinary) {
          this.receiveAgentAudio(buffer, this.agentSampleRate);
          return;
        }
        onText(buffer.toString());
        settle();
      });

      ws.on("error", (err) => {
        if (settle(new Error(`${this.label} WebSocket connection failed: ${err.message}`))) return;
        this._stats.errorEvents.push(err.message);
        this.emit("error", err);
      });

      ws.on("close", () => {
        this.stopComfortNoise();
        this.ws = null;
        if (!settle(new Error(`${this.label} WebSocket closed before the call connected`)) && opened) {
          this.emit("disconnected");
        }
      });
    });
  }
}
