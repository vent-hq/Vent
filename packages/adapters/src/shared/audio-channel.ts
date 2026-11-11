/**
 * AudioChannel — low-level bidirectional audio pipe.
 *
 * Adapters implement this interface to provide raw PCM send/receive
 * over a specific transport (WebSocket, WebRTC). No TTS, STT,
 * or silence detection — that lives in the call executors.
 *
 * All audio is 16-bit signed PCM, 24kHz, mono unless otherwise noted
 * in the adapter (transport-specific resampling happens internally).
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { PendingBuffer, resample, type ObservedToolCall, type ChannelStats, type CallMetadata, type ComponentLatency } from "@vent/shared";

/** What an adapter sends while the caller is silent. */
export type ComfortNoiseMode = "noise" | "silence";

/** Peak of the comfort noise, about -30 dBFS. */
const COMFORT_NOISE_AMPLITUDE = 400;

export interface AudioChannelEvents {
  audio: (chunk: Buffer) => void;
  error: (err: Error) => void;
  disconnected: () => void;
  /** Platform signals that the agent finished speaking (e.g. LiveKit agent state → "listening"). */
  platformEndOfTurn: () => void;
  /** Platform signals that the agent started/resumed speaking. */
  platformSpeechStart: () => void;
  /** Platform signals that a tool call started (true) or completed (false).
   *  When active, collectUntilEndOfTurn suspends VAD end-of-turn to avoid
   *  cutting off the agent's post-tool-call response. */
  toolCallActive: (active: boolean) => void;
}

export interface LiveCallRecording {
  pcm: Readable;
  finalize(): Promise<void>;
  abort(): Promise<void>;
  cleanup(): Promise<void>;
}

/** One stretch of speech as the platform recorded it. A turn may arrive in several pieces. */
export interface PlatformUtterance {
  role: "caller" | "agent";
  text: string;
}

export interface AudioChannel {
  connect(): Promise<void>;
  /** Send raw PCM audio to the agent (16-bit 24kHz mono) */
  sendAudio(pcm: Buffer): void | Promise<void>;
  /** Start sending low-level comfort noise to keep the line active during processing. */
  startComfortNoise?(): void;
  /** Flush any buffered audio, add silence tail, and resume comfort noise.
   *  Call after all sendAudio() calls for a turn are complete. */
  flushAudioBuffer?(): Promise<void>;
  disconnect(): Promise<void>;
  readonly connected: boolean;
  readonly stats: ChannelStats;

  /** Get tool call data after call ends. Platform adapters pull from API, websocket returns collected events. */
  getCallData?(): Promise<ObservedToolCall[]>;
  /** Get platform call metadata (cost, ended reason, recording, analysis) after call ends. */
  getCallMetadata?(): Promise<CallMetadata | null>;
  /** Get the platform's component latencies (STT/LLM/TTS) for the call; the result shows their means. */
  getComponentTimings?(): ComponentLatency[];
  /** Get a live mixed PCM stream so callers can upload while the call is still in progress. */
  getLiveCallRecording?(): LiveCallRecording | null;
  /** Drop any local recording capture state when a fallback artifact is not needed. */
  discardCallRecording?(): Promise<void>;
  /** What the platform recorded, in call order: its STT of the caller, and the text the agent's LLM wrote. */
  getTranscripts?(): PlatformUtterance[];
  /** Whether this adapter emits platformEndOfTurn events.
   *  When true, collectUntilEndOfTurn can defer to the platform signal over VAD. */
  hasPlatformEndOfTurn?: boolean;
  /** Which side should speak first when the call starts. If omitted, executor defaults to agent-first. */
  getOpeningSpeaker?(): Promise<"agent" | "caller" | null>;
  /** Hard platform call limit, if the platform exposes one in its runtime config. */
  getMaxCallDurationSeconds?(): Promise<number | null>;
  /** Optional receive-path diagnostics snapshot. Called by the executor when a
   *  collection times out with no speech detected, to surface adapter-specific
   *  signals that help distinguish "agent went silent" failure modes (no track
   *  vs. all-zero frames vs. no LLM response). Return a short string. */
  getReceiveDiagnostics?(): string;

  on<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  off<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  once<E extends keyof AudioChannelEvents>(event: E, listener: AudioChannelEvents[E]): this;
  emit<E extends keyof AudioChannelEvents>(event: E, ...args: Parameters<AudioChannelEvents[E]>): boolean;
}

/** How long any adapter waits for a call to connect (LiveKit agents can take tens of seconds to join). */
export const CONNECT_TIMEOUT_MS = 45_000;

export abstract class BaseAudioChannel extends EventEmitter implements AudioChannel {
  protected _stats: ChannelStats = {
    bytesSent: 0,
    bytesReceived: 0,
    errorEvents: [],
    connectLatencyMs: 0,
  };

  private _recordingCapture = new CallRecordingCapture();

  constructor() {
    super();
    // No-op error listener so adapter `emit("error", err)` calls don't crash
    // the worker process when no caller-side listener is attached. The runner
    // only attaches a real listener inside collectUntilEndOfTurn — any WS
    // error between turns (LLM phase, TTS gen, idle) would otherwise hit zero
    // listeners and Node throws "Unhandled 'error' event" → process exit.
    // Errors are still recorded in _stats.errorEvents at the emit site.
    this.on("error", () => {});
  }

  get stats(): ChannelStats {
    return this._stats;
  }

  // NOTE: audio emitted during no-listener periods is dropped (standard
  // EventEmitter behavior — zero listeners means no delivery). Buffering and
  // replaying confused Deepgram's live-stream endpointing and returned empty
  // finals for whatever was dumped in the burst. Missing first-word capture
  // on the opening is a downstream issue — addressed by when/how the executor
  // attaches its listeners, NOT by re-introducing a buffer that proved wrong.

  // ── Pipecat-style audio buffer ──────────────────────────────────
  // Accumulates resampled PCM across multiple sendAudio() calls.
  // Drains fixed 20ms frames via writeAudioFrame() in the background.
  // Adapters implement writeAudioFrame() to send one frame to their transport.
  private _audioBuffer = new Int16Array(0);
  private _audioQueue: { samples: Int16Array; sampleRate: number }[] = [];
  private _audioDrainRunning = false;
  private _audioDrainNotify: (() => void) | null = null;
  private _audioDrainStopping = false;

  /** Input sample rate for all adapters (16-bit mono PCM). */
  static readonly INPUT_SAMPLE_RATE = 24000;

  /** Output sample rate — override in subclass if different from 24kHz. */
  protected outputSampleRate = 24000;

  /** Frame duration in ms for chunking. */
  protected frameDurationMs = 20;

  /** Pacing interval between frames (ms). 0 = no pacing (WebRTC backpressure).
   *  WebSocket adapters set to frameDurationMs/2 for 2x real-time delivery
   *  (Pipecat pattern: audio arrives ahead of playback to prevent underruns). */
  protected pacingIntervalMs = 0;

  /** Monotonic clock for self-correcting pacing (Pipecat _write_audio_sleep). */
  private _nextSendTime = 0;

  /** What to send while the caller is silent: faint noise (default) or digital
   *  silence (platforms that hear any noise as the caller talking). */
  protected comfortNoise: ComfortNoiseMode = "noise";
  private _comfortNoiseOn = false;
  /** Incremented to end the running comfort-noise loop. */
  private _comfortNoiseRun = 0;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract get connected(): boolean;

  /**
   * Write a single fixed-size audio frame to the transport.
   * Subclasses implement this for their specific transport (WebRTC, WebSocket).
   * The frame is already resampled to outputSampleRate and sized to frameDurationMs.
   */
  protected abstract writeAudioFrame(samples: Int16Array, sampleRate: number): Promise<void>;

  /**
   * Send PCM audio to the agent. Audio is resampled, buffered, and drained
   * as fixed-size frames via writeAudioFrame(). Safe to call with any buffer
   * size, any number of times (Pipecat-style).
   */
  sendAudio(pcm: Buffer): void {
    this.stopComfortNoise();
    this._stats.bytesSent += pcm.length;
    this._recordingCapture.append("caller", pcm);

    // Resample input → output rate
    const resampled = resample(pcm, BaseAudioChannel.INPUT_SAMPLE_RATE, this.outputSampleRate);
    const newSamples = new Int16Array(
      resampled.buffer,
      resampled.byteOffset,
      resampled.length / 2,
    );

    // Append to persistent buffer
    const merged = new Int16Array(this._audioBuffer.length + newSamples.length);
    merged.set(this._audioBuffer);
    merged.set(newSamples, this._audioBuffer.length);
    this._audioBuffer = merged;

    // Slice fixed frames from the buffer into the queue
    const chunkSamples = Math.floor(this.outputSampleRate * this.frameDurationMs / 1000);
    while (this._audioBuffer.length >= chunkSamples) {
      const chunk = new Int16Array(this._audioBuffer.subarray(0, chunkSamples));
      this._audioQueue.push({ samples: chunk, sampleRate: this.outputSampleRate });
      this._audioBuffer = new Int16Array(this._audioBuffer.subarray(chunkSamples));
    }

    // Wake the drain loop
    this._audioDrainNotify?.();
    this._audioDrainNotify = null;

    // Start drain loop if not running
    if (!this._audioDrainRunning) {
      this._startAudioDrain();
    }
  }

  /**
   * Flush remaining audio buffer, add silence tail, and resume comfort noise.
   * Call after all sendAudio() calls for a turn are complete.
   */
  async flushAudioBuffer(): Promise<void> {
    // Flush remaining samples as a partial frame
    if (this._audioBuffer.length > 0) {
      const chunk = new Int16Array(this._audioBuffer);
      this._audioQueue.push({ samples: chunk, sampleRate: this.outputSampleRate });
      this._audioBuffer = new Int16Array(0);
    }

    // Add silence tail (500ms)
    const silenceSamples = Math.floor(this.outputSampleRate * 0.5);
    const silence = new Int16Array(silenceSamples);
    const silencePcm = Buffer.from(silence.buffer, silence.byteOffset, silence.byteLength);
    this._recordingCapture.append("caller", silencePcm);
    this._audioQueue.push({ samples: silence, sampleRate: this.outputSampleRate });

    // Signal drain loop to exit after processing remaining queue
    this._audioDrainStopping = true;
    this._audioDrainNotify?.();
    this._audioDrainNotify = null;

    // Wait for drain loop to finish
    while (this._audioDrainRunning) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    this._audioDrainStopping = false;

    this.startComfortNoise();
  }

  /**
   * Keep the line alive while the caller is silent. Platforms otherwise treat
   * dead air as the caller leaving ("are you still there?"), and WebRTC's Opus
   * codec goes idle and then misses the start of the caller's next words.
   * Runs until the caller speaks (sendAudio) or stopComfortNoise().
   */
  startComfortNoise(): void {
    if (this._comfortNoiseOn) return;
    this._comfortNoiseOn = true;
    const run = ++this._comfortNoiseRun;
    const frameSamples = Math.round((this.outputSampleRate * this.frameDurationMs) / 1000);
    const silence = new Int16Array(frameSamples);
    // WebSocket transports send without waiting, so pace at real time;
    // WebRTC transports (pacingIntervalMs = 0) wait inside captureFrame.
    const clockPaced = this.pacingIntervalMs > 0;

    void (async () => {
      let next = performance.now();
      try {
        while (run === this._comfortNoiseRun && this.connected) {
          const frame = this.comfortNoise === "silence" ? silence : noiseFrame(frameSamples);
          await this.writeAudioFrame(frame, this.outputSampleRate);
          if (!clockPaced) continue;
          next += this.frameDurationMs;
          const wait = next - performance.now();
          if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
          else next = performance.now();
        }
      } catch {
        // Transport closed
      }
    })();
  }

  stopComfortNoise(): void {
    if (!this._comfortNoiseOn) return;
    this._comfortNoiseOn = false;
    this._comfortNoiseRun++;
    // Drop noise the transport already buffered so speech isn't queued behind it.
    this.clearTransportQueue();
  }

  /** Clear both the audio buffer/queue AND the transport's internal queue.
   *  Call on interruption to stop all pending audio immediately. */
  protected clearAudioBuffer(): void {
    this._audioBuffer = new Int16Array(0);
    this._audioQueue = [];
    this._nextSendTime = 0;
    this._audioDrainStopping = true;
    this._audioDrainNotify?.();
    this._audioDrainNotify = null;
    this.clearTransportQueue();
  }

  /** Clear the transport's internal queue (e.g. LiveKit AudioSource).
   *  Override in subclass. Base implementation is a no-op. */
  protected clearTransportQueue(): void {}

  private _startAudioDrain(): void {
    if (this._audioDrainRunning) return;
    this._audioDrainRunning = true;
    this._audioDrainStopping = false;
    this._nextSendTime = 0;

    (async () => {
      try {
        while (this.connected) {
          if (this._audioQueue.length > 0) {
            const { samples, sampleRate } = this._audioQueue.shift()!;
            await this.writeAudioFrame(samples, sampleRate);

            // Pipecat-style self-correcting clock pacing for WebSocket transports.
            // WebRTC adapters leave pacingIntervalMs = 0 (captureFrame has backpressure).
            if (this.pacingIntervalMs > 0) {
              const now = performance.now();
              const sleep = Math.max(0, this._nextSendTime - now);
              if (sleep > 0) {
                await new Promise<void>((r) => setTimeout(r, sleep));
              }
              this._nextSendTime = sleep === 0
                ? performance.now() + this.pacingIntervalMs
                : this._nextSendTime + this.pacingIntervalMs;
            }
          } else if (this._audioDrainStopping) {
            // Only exit when explicitly told to (flushAudioBuffer or disconnect)
            break;
          } else {
            // Wait for new frames — do NOT exit on empty buffer.
            // Streaming TTS sends chunks with gaps between them.
            await new Promise<void>((r) => {
              this._audioDrainNotify = r;
            });
          }
        }
      } catch {
        // Transport closed — safe to ignore
      }
      this._audioDrainRunning = false;
    })();
  }

  /** Hand agent audio arriving at `sampleRate` to listeners and the recording, as 24kHz PCM. */
  protected receiveAgentAudio(pcm: Buffer, sampleRate: number): void {
    this._stats.bytesReceived += pcm.length;
    const pcm24k = resample(pcm, sampleRate, BaseAudioChannel.INPUT_SAMPLE_RATE);
    this._recordingCapture.append("agent", pcm24k);
    this.emit("audio", pcm24k);
  }

  getLiveCallRecording(): LiveCallRecording | null {
    return this._recordingCapture.getLiveRecording();
  }

  async discardCallRecording(): Promise<void> {
    await this._recordingCapture.discard();
  }
}

type CallSide = "caller" | "agent";
const SILENCE_AMPLITUDE_THRESHOLD = 200;

/**
 * Pipecat-style call recording: two in-memory byte buffers kept in sync
 * via "pad-before-append". Mixed audio is buffered until the live recording
 * stream is requested, then streamed through it.
 */
class CallRecordingCapture {
  private callerChunks = new PendingBuffer();
  private agentChunks = new PendingBuffer();
  private mixedChunks = new PendingBuffer();
  private callerBytes = 0;
  private agentBytes = 0;
  private callerSpeaking = false;
  private agentSpeaking = false;
  private finalized = false;
  private liveRecording: LiveRecordingReadable | null = null;

  append(role: CallSide, pcm: Buffer): void {
    if (this.finalized || pcm.length === 0) return;
    const isSpeech = hasSpeech(pcm);

    if (role === "caller") {
      // Pad agent buffer to match caller position (only if agent is silent)
      if (!this.agentSpeaking && this.callerBytes > this.agentBytes) {
        const pad = Buffer.alloc(this.callerBytes - this.agentBytes);
        this.agentChunks.append(pad);
        this.agentBytes += pad.length;
      }
      this.callerChunks.append(pcm);
      this.callerBytes += pcm.length;
      this.callerSpeaking = isSpeech;
    } else {
      // Pad caller buffer to match agent position (only if caller is silent)
      if (!this.callerSpeaking && this.agentBytes > this.callerBytes) {
        const pad = Buffer.alloc(this.agentBytes - this.callerBytes);
        this.callerChunks.append(pad);
        this.callerBytes += pad.length;
      }
      this.agentChunks.append(pcm);
      this.agentBytes += pcm.length;
      this.agentSpeaking = isSpeech;
    }

    this.flushMixedAudio();
  }

  async discard(): Promise<void> {
    this.finalized = true;
    this.resetBuffers();
    this.liveRecording?.abort();
    this.liveRecording = null;
  }

  getLiveRecording(): LiveCallRecording {
    if (!this.liveRecording) {
      this.liveRecording = new LiveRecordingReadable();
      const bufferedMixed = this.mixedChunks.takeAll();
      if (bufferedMixed.length > 0) {
        this.liveRecording.enqueue(bufferedMixed);
      }
    }

    return {
      pcm: this.liveRecording,
      finalize: async () => {
        this.finalizeOutput();
      },
      abort: async () => {
        this.finalized = true;
        this.liveRecording?.abort();
        this.resetBuffers();
      },
      cleanup: async () => {
        this.liveRecording?.cleanup();
        this.liveRecording = null;
        this.resetBuffers();
      },
    };
  }

  private finalizeOutput(): void {
    if (this.finalized) return;
    this.finalized = true;

    const remaining = this.callerChunks.byteLength - this.agentChunks.byteLength;
    if (remaining > 0) {
      this.agentChunks.append(Buffer.alloc(remaining));
    } else if (remaining < 0) {
      this.callerChunks.append(Buffer.alloc(-remaining));
    }

    this.flushMixedAudio();
    this.liveRecording?.finish();
  }

  private flushMixedAudio(): void {
    const readyBytes = Math.min(this.callerChunks.byteLength, this.agentChunks.byteLength);
    if (readyBytes <= 0) return;

    const callerBuf = this.callerChunks.take(readyBytes);
    const agentBuf = this.agentChunks.take(readyBytes);
    const mixed = mixPcm16(callerBuf, agentBuf, readyBytes);

    if (this.liveRecording) {
      this.liveRecording.enqueue(mixed);
      return;
    }

    this.mixedChunks.append(mixed);
  }

  private resetBuffers(): void {
    this.callerChunks.clear();
    this.agentChunks.clear();
    this.mixedChunks.clear();
    this.callerBytes = 0;
    this.agentBytes = 0;
    this.callerSpeaking = false;
    this.agentSpeaking = false;
  }
}

class LiveRecordingReadable extends Readable {
  private queued: Buffer[] = [];
  private ended = false;
  private streamClosed = false;

  _read(): void {
    this.drain();
  }

  enqueue(chunk: Buffer): void {
    if (this.streamClosed || chunk.length === 0) return;
    this.queued.push(chunk);
    this.drain();
  }

  finish(): void {
    if (this.streamClosed) return;
    this.ended = true;
    this.drain();
  }

  abort(): void {
    if (this.streamClosed) return;
    this.queued = [];
    this.ended = true;
    this.streamClosed = true;
    this.push(null);
  }

  cleanup(): void {
    this.queued = [];
    this.ended = true;
    this.streamClosed = true;
    if (!this.destroyed) {
      this.destroy();
    }
  }

  private drain(): void {
    if (this.streamClosed) return;

    while (this.queued.length > 0) {
      const chunk = this.queued[0]!;
      const accepted = this.push(chunk);
      this.queued.shift();
      if (!accepted) return;
    }

    if (this.ended) {
      this.streamClosed = true;
      this.push(null);
    }
  }
}

function hasSpeech(pcm: Buffer): boolean {
  const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  for (let i = 0; i < int16.length; i++) {
    if (Math.abs(int16[i]!) > SILENCE_AMPLITUDE_THRESHOLD) return true;
  }
  return false;
}

function mixPcm16(a: Buffer, b: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 2) {
    const sa = i < a.length ? a.readInt16LE(i) : 0;
    const sb = i < b.length ? b.readInt16LE(i) : 0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sa + sb)), i);
  }
  return out;
}

/** One frame of faint white noise. */
function noiseFrame(samples: number): Int16Array {
  const frame = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    frame[i] = Math.floor((Math.random() * 2 - 1) * COMFORT_NOISE_AMPLITUDE);
  }
  return frame;
}
