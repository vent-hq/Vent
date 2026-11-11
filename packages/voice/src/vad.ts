/**
 * Voice Activity Detection using TEN VAD (WASM).
 * Wraps the vendored TEN VAD WebAssembly module for Node.js usage.
 *
 * TEN VAD expects 16kHz mono PCM int16, 256-sample frames (16ms).
 * This wrapper accepts 24kHz PCM and resamples internally.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_RATE, pcmRms, resample } from "@vent/shared";

export type VADState = "speech" | "silence" | "end_of_turn";

export interface VoiceActivityDetectorConfig {
  /** Silence duration (ms) after speech before returning "end_of_turn". Default: 1500 */
  silenceThresholdMs?: number;
}

/** TEN VAD hop size in samples at 16kHz (16ms frames). */
const HOP_SIZE = 256;
/** TEN VAD detection threshold [0.0, 1.0]. */
const VAD_THRESHOLD = 0.5;
/**
 * Minimum consecutive voice-classified frames required to flip from the
 * "no speech yet" state to "speech". Once in speech state, a single voice
 * frame resets the silence counter — this hysteresis only applies to the
 * initial onset. Filters isolated neural-VAD false positives on comfort
 * noise (observed ~17% single-frame rate) without losing sensitivity to
 * real speech onsets (which last many consecutive frames). 2 ≈ 32ms.
 */
const MIN_SPEECH_ONSET_FRAMES = 2;
/** Duration of one VAD frame on the audio timeline. */
const FRAME_DURATION_MS = (HOP_SIZE / 16000) * 1000;

interface TenVADModule {
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number;
  _ten_vad_process(
    handle: number,
    audioDataPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number
  ): number;
  _ten_vad_destroy(handlePtr: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
}

export class VoiceActivityDetector {
  private module: TenVADModule | null = null;
  private handle = 0;
  /** Silence duration (ms) after speech before returning "end_of_turn". Mutable for adaptive thresholds. */
  silenceThresholdMs: number;
  /** Minimum RMS energy (int16 scale) for a frame to reach the model; quieter
   *  frames count as silence. Set per turn by the caller (see turnTiming). */
  energyFloorRms = 100;

  private hasSpeech = false;
  /** Count of consecutive "voice" frames while hasSpeech is still false.
   *  Reset on any non-voice frame. Used to gate speech-onset transitions
   *  so a single false-positive voice frame can't flip the state. */
  private pendingSpeechFrames = 0;

  // Audio-timeline silence tracking (frame count, not wall-clock).
  // Each frame = HOP_SIZE samples at 16kHz = FRAME_DURATION_MS.
  // Using frame count avoids the wall-clock vs audio-clock mismatch that
  // occurs when the event loop processes audio frames in bursts under CPU
  // contention — Date.now() barely advances between burst-processed frames,
  // so real 800ms silences appear as <10ms of wall-clock time.
  private silenceFrames = 0;

  // Pre-allocated WASM memory pointers
  private audioPtr = 0;
  private probPtr = 0;
  private flagPtr = 0;

  // Accumulation buffer for partial frames
  private readonly sampleBuffer = new Int16Array(HOP_SIZE);
  private sampleBufferOffset = 0;

  constructor(config: VoiceActivityDetectorConfig = {}) {
    this.silenceThresholdMs = config.silenceThresholdMs ?? 1500;
  }

  async init(): Promise<void> {
    // Load WASM binary from vendored file (__dirname available in CJS output)
    const wasmPath = join(__dirname, "ten-vad", "ten_vad.wasm");
    const wasmBuffer = readFileSync(wasmPath);

    // Convert Node Buffer to ArrayBuffer for Emscripten
    const wasmBinary = wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength
    );

    // Dynamic import of the Emscripten-generated loader (.mjs for ESM compat)
    const { default: createVADModule } = await import(
      /* webpackIgnore: true */ "./ten-vad/ten_vad.mjs"
    ) as { default: unknown };
    this.module = await (createVADModule as (opts: { wasmBinary: ArrayBuffer }) => Promise<TenVADModule>)({
      wasmBinary,
    });

    // Create VAD handle (pointer-to-pointer pattern)
    const handlePtr = this.module._malloc(4);
    const result = this.module._ten_vad_create(handlePtr, HOP_SIZE, VAD_THRESHOLD);
    if (result !== 0) {
      this.module._free(handlePtr);
      throw new Error("Failed to create TEN VAD instance");
    }
    this.handle = this.module.HEAP32[handlePtr >> 2]!;
    this.module._free(handlePtr);

    // Pre-allocate WASM memory for processing
    this.audioPtr = this.module._malloc(HOP_SIZE * 2); // int16 = 2 bytes each
    this.probPtr = this.module._malloc(4);  // float32
    this.flagPtr = this.module._malloc(4);  // int32
  }

  /**
   * Process 24kHz mono PCM int16 audio.
   * Resamples to 16kHz internally, accumulates into HOP_SIZE frames,
   * and returns the VAD state after processing all input.
   */
  process(pcm24k: Buffer): VADState {
    if (!this.module) throw new Error("VAD not initialized — call init() first");

    // Resample 24kHz → 16kHz for TEN VAD
    const pcm16k = resample(pcm24k, SAMPLE_RATE, 16000);

    const samples = new Int16Array(
      pcm16k.buffer,
      pcm16k.byteOffset,
      pcm16k.length / 2
    );

    let state = this.currentState();
    let offset = 0;

    while (offset < samples.length) {
      const remaining = HOP_SIZE - this.sampleBufferOffset;
      const toCopy = Math.min(remaining, samples.length - offset);
      this.sampleBuffer.set(
        samples.subarray(offset, offset + toCopy),
        this.sampleBufferOffset
      );
      this.sampleBufferOffset += toCopy;
      offset += toCopy;

      if (this.sampleBufferOffset === HOP_SIZE) {
        state = this.processFrame(this.sampleBuffer);
        this.sampleBufferOffset = 0;
      }
    }

    return state;
  }

  private currentState(): VADState {
    if (!this.hasSpeech) return "silence";
    if (this.silenceFrames > 0) {
      if (this.silenceFrames * FRAME_DURATION_MS >= this.silenceThresholdMs) {
        return "end_of_turn";
      }
    }
    return "silence";
  }

  private processFrame(samples: Int16Array): VADState {
    const mod = this.module!;

    // Energy gate: skip VAD neural network for frames below the noise floor.
    // WebRTC comfort noise (generated when the remote party is silent) has
    // RMS ~30-200 on int16 scale. Without this gate, the neural network
    // sporadically classifies comfort noise as speech (~17% of frames),
    // preventing the silence counter from ever reaching the end-of-turn
    // threshold.
    const rms = pcmRms(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));

    if (rms < this.energyFloorRms) {
      // Below noise floor — treat as silence without consulting the model
      this.pendingSpeechFrames = 0;
      if (!this.hasSpeech) return "silence";
      this.silenceFrames++;
      if (this.silenceFrames * FRAME_DURATION_MS >= this.silenceThresholdMs) {
        return "end_of_turn";
      }
      return "silence";
    }

    // Copy int16 samples into WASM heap
    mod.HEAP16.set(samples, this.audioPtr / 2);

    // Reset output pointers
    mod.HEAPF32[this.probPtr >> 2] = 0;
    mod.HEAP32[this.flagPtr >> 2] = 0;

    const result = mod._ten_vad_process(
      this.handle,
      this.audioPtr,
      HOP_SIZE,
      this.probPtr,
      this.flagPtr
    );

    if (result !== 0) {
      throw new Error("TEN VAD process failed");
    }

    const isVoice = mod.HEAP32[this.flagPtr >> 2] === 1;

    if (isVoice) {
      this.silenceFrames = 0;
      if (this.hasSpeech) {
        // Already in speech state — a single voice frame is enough to stay there.
        return "speech";
      }
      // First-onset hysteresis: require MIN_SPEECH_ONSET_FRAMES consecutive voice
      // frames before flipping to the "speech" state. Filters isolated neural
      // false positives that the energy gate let through.
      this.pendingSpeechFrames++;
      if (this.pendingSpeechFrames >= MIN_SPEECH_ONSET_FRAMES) {
        this.hasSpeech = true;
        return "speech";
      }
      return "silence";
    }

    // Not voice — reset pending onset counter and handle silence
    this.pendingSpeechFrames = 0;
    if (!this.hasSpeech) {
      return "silence";
    }

    // Had speech before, now silence — count frames on audio timeline
    this.silenceFrames++;

    if (this.silenceFrames * FRAME_DURATION_MS >= this.silenceThresholdMs) {
      return "end_of_turn";
    }

    return "silence";
  }

  reset(): void {
    this.hasSpeech = false;
    this.silenceFrames = 0;
    this.pendingSpeechFrames = 0;
    this.sampleBufferOffset = 0;

    // Reset WASM model state by destroying and recreating the VAD handle.
    // TEN VAD's RNN/GRU accumulates hidden state across frames. After
    // processing thousands of silence frames between conversation turns,
    // the hidden state drifts toward silence classification — causing the
    // model to miss real speech on later turns. The WASM module stays
    // loaded (no recompilation), only the model state is reset.
    if (this.module && this.handle) {
      const handlePtr = this.module._malloc(4);
      this.module.HEAP32[handlePtr >> 2] = this.handle;
      this.module._ten_vad_destroy(handlePtr);

      const result = this.module._ten_vad_create(handlePtr, HOP_SIZE, VAD_THRESHOLD);
      if (result !== 0) {
        this.module._free(handlePtr);
        throw new Error("Failed to recreate TEN VAD instance on reset");
      }
      this.handle = this.module.HEAP32[handlePtr >> 2]!;
      this.module._free(handlePtr);
    }
  }

  destroy(): void {
    if (!this.module) return;

    if (this.audioPtr) this.module._free(this.audioPtr);
    if (this.probPtr) this.module._free(this.probPtr);
    if (this.flagPtr) this.module._free(this.flagPtr);

    if (this.handle) {
      const handlePtr = this.module._malloc(4);
      this.module.HEAP32[handlePtr >> 2] = this.handle;
      this.module._ten_vad_destroy(handlePtr);
      this.module._free(handlePtr);
    }

    this.module = null;
    this.handle = 0;
    this.audioPtr = 0;
    this.probPtr = 0;
    this.flagPtr = 0;
  }
}
