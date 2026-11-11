/**
 * Streaming STT via Deepgram WebSocket — one socket per turn.
 *
 * Deepgram's prescribed end-of-utterance pattern (per docs): enable
 * interim_results + utterance_end_ms + endpointing together. Endpointing
 * emits is_final after 300ms of audio silence; utterance_end_ms provides a
 * word-timing signal for noisy audio. We track the latest interim as a
 * fallback — if the stream ends with an un-finalized tail (noisy audio
 * defeated silence-based endpointing), finalize() appends the interim as
 * the tail. Segments are deduplicated at push-time so overlapping is_finals
 * ("This is our" + "This is our inspection scheduling line.") collapse to
 * the superset. finalize() sends CloseStream and force-closes the socket.
 * resetForNextTurn() opens a fresh socket for the next turn.
 */

import {
  createClient,
  LiveTranscriptionEvents,
  type ListenLiveClient,
  type LiveTranscriptionEvent,
} from "@deepgram/sdk";
import { SAMPLE_RATE } from "@vent/shared";

const MODEL = "nova-3";

export interface TranscriptionResult {
  text: string;
  confidence: number;
}

/** Deepgram emits errors as plain objects ({ error, statusCode, ... }), not Error instances. */
function describeDeepgramError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const { message, error, statusCode } = err as { message?: unknown; error?: unknown; statusCode?: unknown };
    const text = typeof message === "string" ? message : error instanceof Error ? error.message : JSON.stringify(err);
    return statusCode != null ? `${text} (status ${String(statusCode)})` : text;
  }
  return String(err);
}

/** Drop a connection without waiting for it. Disconnecting a socket that is
 *  still opening fires an "error" event, which would crash the process if the
 *  connection had no error listener left. */
function discardConnection(conn: ListenLiveClient): void {
  conn.removeAllListeners();
  conn.on(LiveTranscriptionEvents.Error, () => {});
  conn.disconnect();
}

export class StreamingTranscriber {
  private connection: ListenLiveClient | null = null;

  /** Accumulated final transcript segments for the current turn. */
  private finalSegments: { text: string; confidence: number }[] = [];

  /** Latest interim transcript (not yet promoted to is_final). Used as a
   *  fallback when the stream ends before endpointing silence detects the
   *  tail of the final utterance (e.g. noisy audio). */
  private latestInterim: { text: string; confidence: number } | null = null;

  /** Track whether we've received any audio this turn. */
  private hasFedAudio = false;
  private bytesFed = 0;

  /** Audio buffered while connection is being established. */
  private pendingAudio: Buffer[] = [];

  /** KeepAlive interval to prevent Deepgram's 10s idle timeout. */
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether a reconnection is in progress. */
  private reconnecting = false;

  constructor(private readonly language?: string) {}

  async connect(): Promise<void> {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error("Missing Deepgram API key (env: DEEPGRAM_API_KEY)");
    }

    const deepgram = createClient(apiKey);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.connection = deepgram.listen.live({
        encoding: "linear16",
        sample_rate: SAMPLE_RATE,
        channels: 1,
        model: MODEL,
        punctuate: true,
        // interim_results + utterance_end_ms is Deepgram's prescribed
        // end-of-utterance pattern for noisy audio. endpointing alone is
        // unreliable because it needs actual silence, which platform audio
        // streams often don't have (they send low-level noise frames).
        //
        // Short endpointing (300ms) causes Deepgram to split a multi-sentence
        // agent response into many segments, one per sentence. On each new
        // segment, Deepgram's model needs ~100–200ms to re-lock onto speech
        // and the first word often gets clipped ("Hi." and "This", "How"
        // dropped from real agent greetings). 1200ms keeps a multi-sentence
        // response as a single segment so segmentation doesn't steal the
        // first words — normal inter-sentence pauses (300–800ms) stay part
        // of the same segment.
        interim_results: true,
        utterance_end_ms: 1000,
        endpointing: 1200,
        vad_events: false,
        ...(this.language ? { language: this.language } : {}),
      });

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const rejectOnce = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Deepgram streaming STT connection failed: ${describeDeepgramError(err)}`));
      };

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        // A successful open clears any prior persistent connect-failure flag —
        // a transient blip + recovery shouldn't permanently poison this
        // transcriber's finalize() throw path.
        this.connectionFailureError = null;
        // Send KeepAlive every 5s to prevent Deepgram's 10s idle timeout.
        this.keepAliveInterval = setInterval(() => {
          if (this.connection?.isConnected()) {
            this.connection.keepAlive();
          }
        }, 5000);

        // Replay any audio buffered while connecting
        if (this.pendingAudio.length > 0) {
          console.log(`[STT] Connected — replaying ${this.pendingAudio.length} buffered chunks`);
          for (const buffered of this.pendingAudio) {
            if (this.connection?.isConnected()) {
              const audio = buffered.buffer.slice(
                buffered.byteOffset,
                buffered.byteOffset + buffered.byteLength,
              );
              this.connection.send(audio);
              this.hasFedAudio = true;
            }
          }
          this.pendingAudio = [];
        }

        resolveOnce();
      });

      this.connection.on(
        LiveTranscriptionEvents.Transcript,
        (msg: LiveTranscriptionEvent) => {
          const alt = msg.channel?.alternatives?.[0];
          const text = alt?.transcript ?? "";
          const confidence = alt?.confidence ?? 0;

          if (msg.is_final) {
            if (text.length > 0) {
              this.pushSegmentDeduped({ text, confidence });
              console.log(`[STT] is_final conf=${confidence.toFixed(2)} text="${text.slice(0, 80)}"`);
            } else {
              console.log(`[STT] is_final EMPTY conf=${confidence.toFixed(2)}`);
            }
            // A finalized segment supersedes any pending interim for it.
            this.latestInterim = null;
          } else if (text.length > 0) {
            this.latestInterim = { text, confidence };
          }
        },
      );

      this.connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
        console.warn(`[STT] Deepgram error: ${describeDeepgramError(err)}`);
        rejectOnce(err);
      });

      this.connection.on(LiveTranscriptionEvents.Close, () => {
        this.clearKeepAlive();
        if (settled) {
          console.warn("[STT] Deepgram connection closed — will reconnect on next feedAudio()");
          this.connection?.removeAllListeners();
          this.connection = null;
        } else {
          rejectOnce("socket closed before connection opened");
        }
      });
    });
  }

  /**
   * Feed raw PCM audio into the WebSocket.
   * Buffers audio if the connection isn't ready yet (replayed on Open).
   * Auto-reconnects if the connection was lost.
   */
  feedAudio(chunk: Buffer): void {
    if (this.connection?.isConnected()) {
      const audio = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength,
      );
      this.connection.send(audio);
      this.hasFedAudio = true;
      this.bytesFed += chunk.byteLength;
    } else {
      // Buffer audio so it can be replayed after reconnect
      this.pendingAudio.push(Buffer.from(chunk));

      if (!this.reconnecting) {
        console.warn("[STT] Deepgram connection lost — reconnecting…");
        this.reconnecting = true;
        this.connect()
          .then(() => {
            console.log(`[STT] Reconnected to Deepgram`);
            this.reconnecting = false;
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[STT] Reconnect failed: ${message}`);
            this.reconnecting = false;
            this.pendingAudio = [];
            // Persist the failure so finalize() can surface it instead of
            // silently returning an empty transcript. Without this, a bad
            // DEEPGRAM_API_KEY shows up only as "agent stopped responding"
            // 30s later — operators have no idea STT is broken.
            this.connectionFailureError =
              err instanceof Error ? err : new Error(message);
          });
      }
    }
  }

  /** Set when a reconnect fails terminally (e.g. invalid API key, quota
   *  exceeded). finalize() throws on this so the runner gets the real error. */
  private connectionFailureError: Error | null = null;

  /**
   * Send CloseStream and wait for the socket Close event. Deepgram flushes
   * any buffered interim transcript as is_final before closing, so by the
   * time Close fires every segment for this turn has been pushed into
   * finalSegments. Returns the complete transcript.
   */
  async finalize(): Promise<TranscriptionResult> {
    // Surface a persistent connect/reconnect failure first so callers get
    // the real cause (auth, quota, network) instead of an empty transcript.
    if (this.connectionFailureError) {
      throw new Error(`Deepgram STT unavailable: ${this.connectionFailureError.message}`);
    }
    if (!this.hasFedAudio) {
      return { text: "", confidence: 0 };
    }

    const conn = this.connection;
    if (!conn?.isConnected()) {
      return this.buildTranscript();
    }

    const segmentsBefore = this.finalSegments.length;
    const audioSec = (this.bytesFed / 2 / SAMPLE_RATE).toFixed(1);
    console.log(`[STT] finalize segments=${segmentsBefore} bytesFed=${this.bytesFed} (~${audioSec}s)`);

    const closeStreamAt = Date.now();

    return new Promise<TranscriptionResult>((resolve) => {
      let settled = false;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (reason: string) => {
        if (settled) return;
        settled = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        clearTimeout(deadline);
        this.clearKeepAlive();
        const c = this.connection;
        this.connection = null;
        if (c) {
          try {
            discardConnection(c);
          } catch {}
        }
        // Last-resort tail recovery: if a pending interim was never
        // promoted to is_final (noisy audio defeated endpointing), append
        // it now. Deduped so it doesn't duplicate what's already there.
        if (this.latestInterim && this.latestInterim.text.length > 0) {
          const before = this.finalSegments.length;
          this.pushSegmentDeduped(this.latestInterim);
          const added = this.finalSegments.length > before;
          console.log(
            `[STT] finalize recovered_interim added=${added} text="${this.latestInterim.text.slice(0, 60)}"`,
          );
          this.latestInterim = null;
        }
        const result = this.buildTranscript();
        console.log(
          `[STT] finalize ${reason} segments=${this.finalSegments.length} text="${result.text.slice(0, 100)}"`,
        );
        resolve(result);
      };

      const armDebounce = (ms: number, reason: string) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => finish(reason), ms);
      };

      // After CloseStream, Deepgram flushes any remaining transcripts as
      // is_finals and then sends Close. Wait for Close as the primary signal.
      // The per-is_final debounce exists only for the (rare) case where Close
      // never arrives — in that case we wait for is_finals to stop coming.
      // Buffer timings are generous: chunked TTS audio with pauses can make
      // Deepgram emit is_finals seconds apart; short debounces cut off content.
      armDebounce(2000, "idle");

      conn.on(LiveTranscriptionEvents.Transcript, (msg: LiveTranscriptionEvent) => {
        if (msg.is_final) {
          const elapsed = Date.now() - closeStreamAt;
          const alt = msg.channel?.alternatives?.[0];
          const text = (alt?.transcript ?? "").slice(0, 60);
          console.log(`[STT] finalize is_final t+${elapsed}ms text="${text}"`);
          armDebounce(1500, "flushed");
        }
      });

      // Fast path: server closes cleanly on its own.
      conn.once(LiveTranscriptionEvents.Close, () => finish("closed"));

      // Hard deadline — bound worst-case.
      const deadline = setTimeout(() => finish("deadline"), 5000);

      conn.requestClose();
    });
  }

  /**
   * Reset state and open a fresh WebSocket for the next turn.
   * Must be awaited — the socket is closed by finalize().
   */
  async resetForNextTurn(): Promise<void> {
    this.finalSegments = [];
    this.latestInterim = null;
    this.bytesFed = 0;
    this.hasFedAudio = false;
    this.pendingAudio = [];
    if (!this.connection?.isConnected()) {
      await this.connect();
    }
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.clearKeepAlive();
    if (this.connection) {
      if (this.connection.isConnected()) {
        this.connection.requestClose();
      }
      discardConnection(this.connection);
      this.connection = null;
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /**
   * Append a segment, deduplicating against the previous one. Handles the
   * case where Deepgram emits overlapping is_finals (e.g. "This is our"
   * followed by "This is our inspection scheduling line.") and where a
   * fallback interim covers ground already in the last is_final.
   */
  private pushSegmentDeduped(seg: { text: string; confidence: number }): void {
    const last = this.finalSegments[this.finalSegments.length - 1];
    if (last) {
      const a = normalizeForDedup(last.text);
      const b = normalizeForDedup(seg.text);
      if (a === b) return; // exact duplicate
      if (b.startsWith(a)) {
        // New segment is a superset — replace the earlier partial.
        this.finalSegments[this.finalSegments.length - 1] = seg;
        return;
      }
      if (a.startsWith(b)) return; // new is a prefix of what's already there
    }
    this.finalSegments.push(seg);
  }

  private buildTranscript(): TranscriptionResult {
    if (this.finalSegments.length === 0) {
      return { text: "", confidence: 0 };
    }

    const text = this.finalSegments.map((s) => s.text).join(" ");
    const confidence =
      this.finalSegments.reduce((sum, s) => sum + s.confidence, 0) /
      this.finalSegments.length;

    return { text, confidence };
  }
}

function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[.!?,;:]+$/g, "").trim();
}
