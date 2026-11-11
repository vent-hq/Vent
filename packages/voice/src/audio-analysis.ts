/**
 * Audio signal quality analysis.
 *
 * Pure functions that analyze a raw Int16LE PCM buffer for signal-level issues:
 * clipping, RMS energy consistency, drops/spikes, SNR, clean start/end.
 *
 * Extracted from the former standalone audio_quality infrastructure probe
 * so conversation tests can run the same analysis on captured agent audio.
 */

import { SAMPLE_RATE, pcmRms } from "@vent/shared";

// ============================================================
// Constants
// ============================================================

const CLIPPING_THRESHOLD = 32700;
const WINDOW_MS = 100;
const WINDOW_SAMPLES = Math.floor((SAMPLE_RATE * WINDOW_MS) / 1000);
const SILENCE_RMS_THRESHOLD = 100;
const CLICK_THRESHOLD = 20000;
const DROP_FACTOR = 0.05;
const SPIKE_FACTOR = 3.0;
const DROP_CONSECUTIVE_MIN = 2;

// ============================================================
// Types
// ============================================================

export interface AudioQualityMetrics {
  clipping_ratio: number;
  energy_consistency: number;
  sudden_drops: number;
  sudden_spikes: number;
  clean_start: boolean;
  clean_end: boolean;
  estimated_snr_db: number;
}

// ============================================================
// Main entry point
// ============================================================

/**
 * Analyze a raw Int16LE PCM audio buffer for signal-level quality issues.
 *
 * @param buffer - Raw Int16LE PCM audio at SAMPLE_RATE
 */
export function analyzeAudioQuality(buffer: Buffer): AudioQualityMetrics {
  const totalSamples = buffer.length / 2;
  if (totalSamples === 0) {
    return {
      clipping_ratio: 0,
      energy_consistency: 0,
      sudden_drops: 0,
      sudden_spikes: 0,
      clean_start: true,
      clean_end: true,
      estimated_snr_db: -1,
    };
  }

  // 1. Clipping detection
  let clippedSamples = 0;
  for (let i = 0; i < totalSamples; i++) {
    if (Math.abs(buffer.readInt16LE(i * 2)) >= CLIPPING_THRESHOLD) {
      clippedSamples++;
    }
  }
  const clippingRatio = clippedSamples / totalSamples;

  // 2. RMS energy consistency (windowed analysis)
  const windowCount = Math.floor(totalSamples / WINDOW_SAMPLES);
  const windowRms: number[] = [];

  for (let w = 0; w < windowCount; w++) {
    const start = w * WINDOW_SAMPLES * 2;
    windowRms.push(pcmRms(buffer.subarray(start, start + WINDOW_SAMPLES * 2)));
  }

  const speechWindows = windowRms.filter((r) => r >= SILENCE_RMS_THRESHOLD);
  const silenceWindows = windowRms.filter((r) => r < SILENCE_RMS_THRESHOLD);

  let energyConsistency = 1;
  let suddenDrops = 0;
  let suddenSpikes = 0;
  let meanSpeechRms = 0;

  if (speechWindows.length >= 3) {
    meanSpeechRms = speechWindows.reduce((a, b) => a + b, 0) / speechWindows.length;
    const variance =
      speechWindows.reduce((a, r) => a + (r - meanSpeechRms) ** 2, 0) / speechWindows.length;
    const stddev = Math.sqrt(variance);
    energyConsistency = meanSpeechRms > 0 ? Math.max(0, 1 - stddev / meanSpeechRms) : 0;

    let consecutiveDrops = 0;
    let inDrop = false;
    for (let i = 1; i < windowRms.length - 1; i++) {
      const prev = windowRms[i - 1]!;
      const curr = windowRms[i]!;
      const next = windowRms[i + 1]!;

      const isSpeechRegion = prev >= SILENCE_RMS_THRESHOLD && next >= SILENCE_RMS_THRESHOLD;
      if (isSpeechRegion) {
        if (curr < meanSpeechRms * DROP_FACTOR) {
          consecutiveDrops++;
          if (consecutiveDrops >= DROP_CONSECUTIVE_MIN && !inDrop) {
            suddenDrops++;
            inDrop = true;
          }
        } else {
          consecutiveDrops = 0;
          inDrop = false;
        }
        if (curr > meanSpeechRms * SPIKE_FACTOR) suddenSpikes++;
      } else {
        consecutiveDrops = 0;
        inDrop = false;
      }
    }
  }

  // 3. Clean start/end (check first/last 10ms for clicks)
  const edgeSamples = Math.floor((SAMPLE_RATE * 10) / 1000);
  let cleanStart = true;
  let cleanEnd = true;

  for (let i = 0; i < Math.min(edgeSamples, totalSamples); i++) {
    if (Math.abs(buffer.readInt16LE(i * 2)) > CLICK_THRESHOLD) {
      cleanStart = false;
      break;
    }
  }

  for (let i = totalSamples - 1; i >= Math.max(0, totalSamples - edgeSamples); i--) {
    if (Math.abs(buffer.readInt16LE(i * 2)) > CLICK_THRESHOLD) {
      cleanEnd = false;
      break;
    }
  }

  // 4. SNR estimate
  const noiseFloorRms =
    silenceWindows.length > 0
      ? silenceWindows.reduce((a, b) => a + b, 0) / silenceWindows.length
      : 0;
  const estimatedSnrDb =
    noiseFloorRms > 0 && meanSpeechRms > 0
      ? Math.round(20 * Math.log10(meanSpeechRms / noiseFloorRms) * 10) / 10
      : -1;

  return {
    clipping_ratio: Math.round(clippingRatio * 10000) / 10000,
    energy_consistency: Math.round(energyConsistency * 1000) / 1000,
    sudden_drops: suddenDrops,
    sudden_spikes: suddenSpikes,
    clean_start: cleanStart,
    clean_end: cleanEnd,
    estimated_snr_db: estimatedSnrDb,
  };
}
