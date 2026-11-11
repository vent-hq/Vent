/**
 * Adaptive silence threshold for end-of-turn detection.
 *
 * Adjusts the silence threshold between conversation turns based on
 * observed agent response cadence — prevents cutting off agents that
 * pause mid-response (thinking, tool calls, multi-sentence answers)
 * while keeping fast agents snappy.
 *
 * Key signal: maxInternalSilenceMs from CollectionStats.
 * If the agent had a mid-response pause that was close to the threshold,
 * we're at risk of premature cutoff on the next turn → increase.
 * If pauses are consistently short → decrease toward base.
 */

import type { CollectionStats } from "./turn-taking.js";

/** The threshold never goes below / above these. */
const MIN_MS = 200;
const MAX_MS = 3000;

export class AdaptiveThreshold {
  private currentMs: number;

  constructor(baseMs: number) {
    this.currentMs = baseMs;
  }

  /** Current threshold to use for the next turn. */
  get thresholdMs(): number {
    return Math.round(this.currentMs);
  }

  /**
   * Update the threshold based on observed collection stats from the last turn.
   * Call this after each agent response is collected.
   */
  update(stats: CollectionStats): void {
    const { maxInternalSilenceMs, speechSegments } = stats;

    // No speech detected — nothing to adapt from
    if (speechSegments === 0) return;

    let adjustment = 1.0;

    // Primary signal: how close was the longest mid-response pause to the threshold?
    // If the agent paused at 70%+ of threshold, it nearly got cut off → increase aggressively
    if (maxInternalSilenceMs > this.currentMs * 0.7) {
      adjustment = 1.4;
    } else if (maxInternalSilenceMs > this.currentMs * 0.5) {
      adjustment = 1.2;
    } else if (maxInternalSilenceMs > this.currentMs * 0.3) {
      // Agent pauses are moderate — slight increase for safety
      adjustment = 1.05;
    } else if (speechSegments === 1 && maxInternalSilenceMs < this.currentMs * 0.1) {
      // Clean single-segment response, no meaningful pauses → drift back toward base
      adjustment = 0.9;
    }

    // Secondary signal: many speech segments = agent speaks in bursts → increase
    if (speechSegments >= 3) {
      adjustment = Math.max(adjustment, 1.15);
    }

    // Apply with EMA smoothing (70% current, 30% new target)
    const target = this.currentMs * adjustment;
    this.currentMs = this.currentMs * 0.7 + target * 0.3;

    // Clamp to bounds
    this.currentMs = Math.max(MIN_MS, Math.min(MAX_MS, this.currentMs));
  }
}
