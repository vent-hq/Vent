/**
 * Audio effects pipeline — pure DSP on PCM 16-bit 24kHz mono buffers.
 * Simulates real-world audio conditions: speed, speakerphone, mic distance,
 * clarity, noise, packet loss and jitter.
 */

import { SAMPLE_RATE, clamp16, resample, type CallerAudioEffects } from "@vent/shared";
import {
  generateBabbleNoise,
  generateWhiteNoise,
  generatePinkNoise,
  mixAudio,
} from "./noise.js";

const BYTES_PER_SAMPLE = 2;

/**
 * Time-stretch via resampling. Speed > 1 = faster (fewer samples).
 * Shifts pitch proportionally — realistic for fast/slow talkers.
 */
function applySpeed(pcm: Buffer, speed: number): Buffer {
  if (speed === 1.0) return pcm;
  return resample(pcm, SAMPLE_RATE * speed, SAMPLE_RATE);
}

/**
 * Bandpass 300-3400 Hz — simulates telephone/speakerphone audio.
 * Cascaded single-pole IIR: high-pass at 300 Hz + low-pass at 3400 Hz.
 */
function applySpeakerphone(pcm: Buffer): Buffer {
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

    output.writeInt16LE(clamp16(lpPrevY), i * BYTES_PER_SAMPLE);
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

function applyMicDistance(pcm: Buffer, distance: "close" | "normal" | "far"): Buffer {
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
    output.writeInt16LE(clamp16(lpPrevY), i * BYTES_PER_SAMPLE);
  }

  return output;
}

/**
 * Audio clarity degradation — low-pass filter + light noise.
 * clarity=1.0 = no effect, clarity=0.0 = heavily degraded.
 */
function applyClarity(pcm: Buffer, clarity: number): Buffer {
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
    output.writeInt16LE(clamp16(lpPrevY), i * BYTES_PER_SAMPLE);
  }

  return output;
}

/**
 * Simulated packet loss — zero out random 20ms chunks.
 * lossRate = fraction of chunks to drop (0.05 = 5%).
 */
function applyPacketLoss(pcm: Buffer, lossRate: number): Buffer {
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
function applyJitter(pcm: Buffer, jitterMs: number): Buffer {
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
