/**
 * Call-level roll-up of per-turn agent audio signal quality.
 */

import type { SignalQualityMetrics } from "@vent/shared";
import type { AudioQualityMetrics } from "@vent/voice";

export function summarizeSignalQuality(turns: AudioQualityMetrics[]): SignalQualityMetrics | undefined {
  if (turns.length === 0) return undefined;
  return {
    mean_snr_db: Math.round(
      turns.reduce((a, q) => a + q.estimated_snr_db, 0) / turns.length * 10,
    ) / 10,
    max_clipping_ratio: Math.max(...turns.map((q) => q.clipping_ratio)),
    energy_consistency: Math.round(
      turns.reduce((a, q) => a + q.energy_consistency, 0) / turns.length * 1000,
    ) / 1000,
    sudden_drops: turns.reduce((a, q) => a + q.sudden_drops, 0),
    sudden_spikes: turns.reduce((a, q) => a + q.sudden_spikes, 0),
    clean_edges: turns.every((q) => q.clean_start && q.clean_end),
  };
}
