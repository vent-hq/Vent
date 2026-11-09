/**
 * Audio effects pipeline — pure DSP on PCM 16-bit 24kHz mono buffers.
 * Simulates real-world audio conditions: speed, speakerphone, mic distance,
 * clarity, packet loss, jitter, and accent (via TTS voice selection).
 */

import type { CallerAccent, CallerAudioEffects } from "@vent/shared";
import { resample } from "./format.js";
import {
  generateBabbleNoise,
  generateWhiteNoise,
  generatePinkNoise,
  mixAudio,
} from "./noise.js";

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const MAX_SAMPLE = 32767;
const MIN_SAMPLE = -32768;

function clamp(value: number): number {
  return Math.max(MIN_SAMPLE, Math.min(MAX_SAMPLE, Math.round(value)));
}

// ============================================================
// Accent presets — Deepgram Aura-2 voice IDs
// ============================================================

export const ACCENT_VOICES: Record<CallerAccent, string> = {
  // English accents
  american: "aura-2-thalia-en",
  british: "aura-2-draco-en",
  australian: "aura-2-hyperion-en",
  filipino: "aura-2-amalthea-en",

  // Other languages
  spanish_mexican: "aura-2-javier-es",
  spanish_peninsular: "aura-2-nestor-es",
  spanish_colombian: "aura-2-celeste-es",
  spanish_argentine: "aura-2-antonia-es",
  german: "aura-2-julius-de",
  french: "aura-2-hector-fr",
  italian: "aura-2-elio-it",
  dutch: "aura-2-sander-nl",
  japanese: "aura-2-ebisu-ja",
};

/** Resolve an accent (validated against CALLER_ACCENTS) to a Deepgram voice ID. */
export function resolveAccentVoiceId(accent: CallerAccent): string {
  return ACCENT_VOICES[accent];
}

// ============================================================
// Language defaults — ISO 639-1 → Deepgram Aura-2 voice ID
// ============================================================

export const LANGUAGE_DEFAULT_VOICES: Record<string, string> = {
  en: "aura-2-thalia-en",
  es: "aura-2-javier-es",
  fr: "aura-2-hector-fr",
  de: "aura-2-julius-de",
  it: "aura-2-elio-it",
  nl: "aura-2-sander-nl",
  ja: "aura-2-ebisu-ja",
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  ja: "Japanese",
};

/**
 * Resolve an ISO 639-1 language code to a default Deepgram voice ID.
 * Returns undefined if the language has no TTS voice available.
 */
export function resolveLanguageVoiceId(language: string): string | undefined {
  return LANGUAGE_DEFAULT_VOICES[language];
}

// ============================================================
// Gender presets — English-only male/female toggle
// ============================================================

export const GENDER_VOICE_DEFAULTS: Record<"male" | "female", string> = {
  female: "aura-2-thalia-en",
  male: "aura-2-apollo-en",
};

export function resolveGenderVoiceId(gender: "male" | "female"): string {
  return GENDER_VOICE_DEFAULTS[gender];
}

// ============================================================
// DSP effects
// ============================================================

/**
 * Time-stretch via resampling. Speed > 1 = faster (fewer samples).
 * Shifts pitch proportionally — realistic for fast/slow talkers.
 */
export function applySpeed(pcm: Buffer, speed: number): Buffer {
  if (speed === 1.0) return pcm;
  return resample(pcm, SAMPLE_RATE * speed, SAMPLE_RATE);
}

/**
 * Bandpass 300-3400 Hz — simulates telephone/speakerphone audio.
 * Cascaded single-pole IIR: high-pass at 300 Hz + low-pass at 3400 Hz.
 */
export function applySpeakerphone(pcm: Buffer): Buffer {
  const numSamples = pcm.length / BYTES_PER_SAMPLE;
  const output = Buffer.alloc(pcm.length);

  // High-pass at 300 Hz
  const hpAlpha = 1.0 / (1.0 + (2.0 * Math.PI * 300) / SAMPLE_RATE);

  // Low-pass at 3400 Hz
  const lpRc = 1.0 / (2.0 * Math.PI * 3400);
  const lpDt = 1.0 / SAMPLE_RATE;
  const lpAlpha = lpDt / (lpRc + lpDt);

  let hpPrevX = 0;
  let hpPrevY = 0;
  let lpPrevY = 0;

  for (let i = 0; i < numSamples; i++) {
    const x = pcm.readInt16LE(i * BYTES_PER_SAMPLE);

    // High-pass: y[n] = alpha * (y[n-1] + x[n] - x[n-1])
    hpPrevY = hpAlpha * (hpPrevY + x - hpPrevX);
    hpPrevX = x;

    // Low-pass: y[n] = y[n-1] + alpha * (x[n] - y[n-1])
    lpPrevY = lpPrevY + lpAlpha * (hpPrevY - lpPrevY);

    output.writeInt16LE(clamp(lpPrevY), i * BYTES_PER_SAMPLE);
  }

  return output;
}

/**
 * Simulated microphone distance — gain reduction + low-pass filter.
 */
const MIC_DISTANCE_PROFILES = {
  close: { gainDb: 0, lpCutoff: 0 },
  normal: { gainDb: -3, lpCutoff: 6000 },
  far: { gainDb: -10, lpCutoff: 3000 },
} as const;

export function applyMicDistance(pcm: Buffer, distance: "close" | "normal" | "far"): Buffer {
  if (distance === "close") return pcm;

  const profile = MIC_DISTANCE_PROFILES[distance];
  const gain = Math.pow(10, profile.gainDb / 20);
  const numSamples = pcm.length / BYTES_PER_SAMPLE;
  const output = Buffer.alloc(pcm.length);

  const lpRc = 1.0 / (2.0 * Math.PI * profile.lpCutoff);
  const lpDt = 1.0 / SAMPLE_RATE;
  const lpAlpha = lpDt / (lpRc + lpDt);
  let lpPrevY = 0;

  for (let i = 0; i < numSamples; i++) {
    const x = pcm.readInt16LE(i * BYTES_PER_SAMPLE) * gain;
    lpPrevY = lpPrevY + lpAlpha * (x - lpPrevY);
    output.writeInt16LE(clamp(lpPrevY), i * BYTES_PER_SAMPLE);
  }

  return output;
}

/**
 * Audio clarity degradation — low-pass filter + light noise.
 * clarity=1.0 = no effect, clarity=0.0 = heavily degraded.
 */
export function applyClarity(pcm: Buffer, clarity: number): Buffer {
  if (clarity >= 1.0) return pcm;

  const degradation = 1.0 - clarity;
  const numSamples = pcm.length / BYTES_PER_SAMPLE;
  const output = Buffer.alloc(pcm.length);

  // Low-pass frequency decreases with degradation (12kHz → 2kHz)
  const lpFreq = 12000 - degradation * 10000;
  const lpRc = 1.0 / (2.0 * Math.PI * lpFreq);
  const lpDt = 1.0 / SAMPLE_RATE;
  const lpAlpha = lpDt / (lpRc + lpDt);
  let lpPrevY = 0;

  // Noise amplitude scales with degradation
  const noiseAmp = degradation * 800;

  for (let i = 0; i < numSamples; i++) {
    let x = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    x += (Math.random() * 2 - 1) * noiseAmp;
    lpPrevY = lpPrevY + lpAlpha * (x - lpPrevY);
    output.writeInt16LE(clamp(lpPrevY), i * BYTES_PER_SAMPLE);
  }

  return output;
}

/**
 * Simulated packet loss — zero out random 20ms chunks.
 * lossRate = fraction of chunks to drop (0.05 = 5%).
 */
export function applyPacketLoss(pcm: Buffer, lossRate: number): Buffer {
  if (lossRate <= 0) return pcm;

  const chunkSamples = Math.round((20 / 1000) * SAMPLE_RATE); // 20ms = 480 samples
  const chunkBytes = chunkSamples * BYTES_PER_SAMPLE;
  const output = Buffer.from(pcm);

  for (let offset = 0; offset + chunkBytes <= output.length; offset += chunkBytes) {
    if (Math.random() < lossRate) {
      output.fill(0, offset, offset + chunkBytes);
    }
  }

  return output;
}

/**
 * Simulated network jitter — insert random silence gaps between 20ms chunks.
 * jitterMs = max silence to insert before each chunk (uniform random 0 to jitterMs).
 */
export function applyJitter(pcm: Buffer, jitterMs: number): Buffer {
  if (jitterMs <= 0) return pcm;

  const chunkSamples = Math.round((20 / 1000) * SAMPLE_RATE);
  const chunkBytes = chunkSamples * BYTES_PER_SAMPLE;
  const chunks: Buffer[] = [];

  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, pcm.length);
    // Insert random silence before this chunk
    const silenceMs = Math.random() * jitterMs;
    const silenceSamples = Math.round((silenceMs / 1000) * SAMPLE_RATE);
    if (silenceSamples > 0) {
      chunks.push(Buffer.alloc(silenceSamples * BYTES_PER_SAMPLE));
    }
    chunks.push(pcm.subarray(offset, end));
  }

  return Buffer.concat(chunks);
}

// ============================================================
// Master effects chain
// ============================================================

/**
 * Apply all configured audio effects to a PCM buffer.
 *
 * Order:
 * 1. Speed (changes buffer length — do first)
 * 2. Speakerphone (bandpass filter)
 * 3. Mic distance (gain + low-pass)
 * 4. Clarity (degradation)
 * 5. Noise (mixed last — shouldn't be filtered by prior effects)
 * 6. Packet loss (drop chunks after all audio processing)
 * 7. Jitter (insert silence gaps last)
 */
export function applyEffects(pcm: Buffer, effects: CallerAudioEffects): Buffer {
  let result = pcm;

  if (effects.speed != null && effects.speed !== 1.0) {
    result = applySpeed(result, effects.speed);
  }

  if (effects.speakerphone) {
    result = applySpeakerphone(result);
  }

  if (effects.mic_distance && effects.mic_distance !== "close") {
    result = applyMicDistance(result, effects.mic_distance);
  }

  if (effects.clarity != null && effects.clarity < 1.0) {
    result = applyClarity(result, effects.clarity);
  }

  if (effects.noise) {
    const durationMs = Math.round((result.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000);
    const noiseGen =
      effects.noise.type === "white"
        ? generateWhiteNoise
        : effects.noise.type === "pink"
          ? generatePinkNoise
          : generateBabbleNoise;
    const noise = noiseGen(durationMs);
    result = mixAudio(result, noise, effects.noise.snr_db);
  }

  if (effects.packet_loss != null && effects.packet_loss > 0) {
    result = applyPacketLoss(result, effects.packet_loss);
  }

  if (effects.jitter_ms != null && effects.jitter_ms > 0) {
    result = applyJitter(result, effects.jitter_ms);
  }

  return result;
}
