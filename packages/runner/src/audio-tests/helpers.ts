/**
 * Shared helpers for audio call executors.
 */

import type { AudioChannel } from "@vent/adapters";
import { VoiceActivityDetector, type VADState, transcribe as sttTranscribe, concatPcm } from "@vent/voice";

/** Longest a platform may report a tool call as running before Vent stops waiting on it. */
const TOOL_CALL_MAX_MS = 30_000;
/** After a platform's end-of-turn signal, how long to wait in case the agent keeps talking. */
const PLATFORM_EOT_SETTLE_MS = 500;

/**
 * How patiently Vent waits for the agent to finish its turn. Platforms that
 * report when the agent stops talking (hasPlatformEndOfTurn) can be trusted
 * quickly. On the rest, Vent's own voice detection decides, so it waits out
 * the agent's natural pauses: mid-reply, and right after a tool result.
 */
export function turnTiming(hasPlatformEndOfTurn: boolean) {
  return hasPlatformEndOfTurn
    ? { silenceThresholdMs: 400, postVadContinuationMs: 0, postToolCallContinuationMs: 0 }
    : { silenceThresholdMs: 1200, postVadContinuationMs: 1000, postToolCallContinuationMs: 2000 };
}
/**
 * Stats about audio collection — used by adaptive threshold to tune silence detection.
 */
export interface CollectionStats {
  /** Number of distinct speech segments (speech→silence→speech = 2 segments) */
  speechSegments: number;
  /** Longest mid-response silence in ms (silence between speech segments, NOT the final silence) */
  maxInternalSilenceMs: number;
  /** Total time spent in speech state (ms) */
  totalSpeechMs: number;
  /** Timestamp (Date.now()) when the first audio chunk was received, or null if none */
  firstChunkAt: number | null;
  /** Timestamp (Date.now()) when VAD first detected speech, or null if no speech detected */
  speechOnsetAt: number | null;
}

/**
 * Collect audio from the channel until VAD detects end-of-turn or timeout.
 * Returns the concatenated PCM buffer of all received audio plus collection stats
 * for adaptive threshold tuning.
 */
export async function collectUntilEndOfTurn(
  channel: AudioChannel,
  opts: {
    timeoutMs?: number;
    silenceThresholdMs?: number;
    /** Debug label for collector logs. */
    debugLabel?: string;
    /** Pre-initialized VAD instance — reused across turns to avoid WASM reload. */
    vad?: VoiceActivityDetector;
    /** Abort signal — resolves collection early, returning audio collected so far. */
    signal?: AbortSignal;
    /** When true, VAD end-of-turn waits for platformEndOfTurn confirmation (up to 3s).
     *  Prevents cutting off the agent mid-sentence when VAD triggers on a pause. */
    preferPlatformEOT?: boolean;
  } = {}
): Promise<{ audio: Buffer; timedOut: boolean; aborted: boolean; stats: CollectionStats }> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const silenceThresholdMs = opts.silenceThresholdMs ?? 800;
  const debugLabel = opts.debugLabel ?? "collect";
  const { postToolCallContinuationMs, postVadContinuationMs } = turnTiming(!!opts.preferPlatformEOT);
  // Noise gate for "audible audio arrived — extending turn" checks. Real
  // speech on 16-bit PCM sits at RMS 500–5000; platform noise floors
  // (Retell/Twilio/etc.) are typically 50–200. 500 lands in the gap so
  // background noise stops resetting the defer window.
  const audibleDrainRmsThreshold = 500;
  const continuationSettleMs = 150;
  // Safety net: if noise still spikes above the gate repeatedly, cap the
  // total defer/extension loop at this budget so the turn can't get stuck
  // forever and trigger a platform inactivity hangup.
  const extensionBudgetMs = 8000;

  const ownsVAD = !opts.vad;
  const vad = opts.vad ?? new VoiceActivityDetector({ silenceThresholdMs });
  if (ownsVAD) await vad.init();
  else vad.reset();

  const chunks: Buffer[] = [];
  let timedOut = false;
  let aborted = false;

  // State transition tracking for adaptive thresholds
  let prevState: VADState = "silence";
  let speechSegments = 0;
  let maxInternalSilenceMs = 0;
  let totalSpeechMs = 0;
  let silenceStartedAt: number | null = null;
  let speechStartedAt: number | null = null;
  let firstChunkAt: number | null = null;
  let speechOnsetAt: number | null = null;
  let lastAudibleAudioAt: number | null = null;
  let lastChunkAt: number | null = null;

  // Energy diagnostics: track RMS distribution to understand what audio the VAD sees
  const energyBuckets = { below100: 0, r100_250: 0, r250_500: 0, r500_1000: 0, r1000_3000: 0, above3000: 0 };
  let maxRms = 0;
  let speechChunkRmsSum = 0;
  let speechChunkCount = 0;

  try {
    await new Promise<void>((resolve) => {
      console.log(
        `    [collect:${debugLabel}] start timeout=${timeoutMs}ms silenceThreshold=${vad.silenceThresholdMs}ms ` +
        `preferPlatformEOT=${!!opts.preferPlatformEOT} ` +
        `postToolContinuation=${postToolCallContinuationMs}ms postVadContinuation=${postVadContinuationMs}ms`
      );
      let platformEOTFired = false;
      let vadEOTFired = false;
      let platformEOTResolveTimer: ReturnType<typeof setTimeout> | null = null;
      let vadDeferTimer: ReturnType<typeof setTimeout> | null = null;
      let toolCallInProgress = false;
      /** Ends a tool call the platform never reports as finished. */
      let toolCallCapTimer: ReturnType<typeof setTimeout> | null = null;
      let lastToolCallCompletedAt: number | null = null;
      let platformSpeechStartedAt: number | null = null;
      /** True when platform confirmed agent silence and no platformSpeechStart has fired since. */
      let platformConfirmedSilent = false;
      /** Wall-clock time when VAD first fired EOT in this turn. Reset on genuine
       *  speech resumption. Used to cap how long noise can extend the turn. */
      let firstEOTAt: number | null = null;
      /** Wall-clock time of the most recent platformEndOfTurn signal from the
       *  adapter. Lets the VAD silence path treat a recent platform EOT as
       *  authoritative (resolve via drain) instead of waiting 3s for another
       *  platform EOT that won't come — Retell only sends one final
       *  agent_stop_talking, then goes silent waiting for the user. */
      let lastPlatformEOTAt: number | null = null;
      const PLATFORM_EOT_FRESH_MS = 5000;

      const clearDeferredEndOfTurn = () => {
        if (!vadDeferTimer) return;
        clearTimeout(vadDeferTimer);
        vadDeferTimer = null;
      };

      const clearPlatformResolve = () => {
        if (!platformEOTResolveTimer) return;
        clearTimeout(platformEOTResolveTimer);
        platformEOTResolveTimer = null;
      };

      const resolveNow = (reason: string) => {
        console.log(`    [vad] ${reason} — resolving`);
        cleanup();
        resolve();
      };

      const shouldWaitForPostToolContinuation = (now: number) => {
        return (
          postToolCallContinuationMs > 0 &&
          !toolCallInProgress &&
          lastToolCallCompletedAt !== null &&
          now - lastToolCallCompletedAt <= postToolCallContinuationMs
        );
      };

      const scheduleContinuationResolve = (reason: string) => {
        clearDeferredEndOfTurn();
        vadDeferTimer = setTimeout(() => {
          vadDeferTimer = null;
          if (platformSpeechStartedAt !== null && Date.now() - platformSpeechStartedAt <= continuationSettleMs) {
            console.log(`    [vad] ${reason} but platform speech resumed — extending turn`);
            vad.reset();
            return;
          }
          console.log(`    [vad] ${reason} elapsed — resolving`);
          cleanup();
          resolve();
        }, continuationSettleMs);
      };

      const onAudio = (chunk: Buffer) => {
        chunks.push(chunk);

        // Compute chunk-level RMS for diagnostics
        const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
        let sumSq = 0;
        for (let i = 0; i < int16.length; i++) sumSq += int16[i]! * int16[i]!;
        const rms = Math.sqrt(sumSq / int16.length);
        if (rms > maxRms) maxRms = rms;
        if (rms < 100) energyBuckets.below100++;
        else if (rms < 250) energyBuckets.r100_250++;
        else if (rms < 500) energyBuckets.r250_500++;
        else if (rms < 1000) energyBuckets.r500_1000++;
        else if (rms < 3000) energyBuckets.r1000_3000++;
        else energyBuckets.above3000++;

        const state = vad.process(chunk);
        const now = Date.now();
        if (firstChunkAt === null) firstChunkAt = now;
        if (lastChunkAt === null) {
          console.log(`    [collect:${debugLabel}] first_audio_chunk`);
        }
        lastChunkAt = now;
        if (rms > audibleDrainRmsThreshold) {
          lastAudibleAudioAt = now;
          const budgetExhausted =
            firstEOTAt !== null && now - firstEOTAt > extensionBudgetMs;
          // Audio is ground truth; cancel the continuation window regardless of
          // whether the platform marked itself silent — the acoustic signal can
          // be wrong mid-phrase and the audio bus is authoritative.
          if (vadDeferTimer) {
            if (budgetExhausted) {
              console.log(
                `    [vad] audible audio during continuation window but extension budget exhausted (${extensionBudgetMs}ms) — letting defer resolve`
              );
            } else {
              console.log(`    [vad] Audible audio arrived during continuation window — extending turn`);
              clearDeferredEndOfTurn();
              clearPlatformResolve();
              vadEOTFired = false;
              platformEOTFired = false;
              platformConfirmedSilent = false;
              // Real speech (RMS > audibleDrainRmsThreshold) resumed — this is a
              // legitimate continuation, not noise. Reset the extension budget so
              // the next pause-then-resume cycle gets a fresh window. Without this,
              // chunked TTS responses with multiple tool-call pauses (Retell, etc.)
              // accumulate against an 8s cap and resolve mid-response.
              firstEOTAt = null;
              vad.reset();
            }
          }
          // Platform EOT settle window: audible audio means agent resumed.
          // Cancel the settle regardless of whether platform "confirmed silent" —
          // the platform's acoustic signal can be wrong mid-list.
          if (platformEOTResolveTimer) {
            if (budgetExhausted) {
              console.log(
                `    [vad] audible audio during platform EOT settle but extension budget exhausted — letting settle resolve`
              );
            } else {
              console.log(`    [vad] Audible audio arrived during platform EOT settle — extending turn`);
              clearPlatformResolve();
              clearDeferredEndOfTurn();
              vadEOTFired = false;
              platformEOTFired = false;
              platformConfirmedSilent = false;
              firstEOTAt = null;
              vad.reset();
            }
          }
        }

        if (state === "speech") {
          speechChunkRmsSum += rms;
          speechChunkCount++;
        }

        // Track speech → silence transition
        if (state === "silence" && prevState === "speech") {
          silenceStartedAt = now;
          if (speechStartedAt !== null) {
            totalSpeechMs += now - speechStartedAt;
            speechStartedAt = null;
          }
        }

        // Track silence → speech transition (mid-response pause resolved)
        if (state === "speech" && prevState !== "speech") {
          speechSegments++;
          startTimeout(); // Agent is still active — reset the safety timeout
          if (speechOnsetAt === null) speechOnsetAt = now;
          if (speechOnsetAt === now) {
            console.log(`    [collect:${debugLabel}] speech_onset rms=${Math.round(rms)}`);
          }
          speechStartedAt = now;
          if (silenceStartedAt !== null) {
            const silenceDurationMs = now - silenceStartedAt;
            maxInternalSilenceMs = Math.max(maxInternalSilenceMs, silenceDurationMs);
            silenceStartedAt = null;
          }

          // VAD detected new speech after it already fired end_of_turn —
          // the agent resumed speaking. Cancel the deferred resolve.
          // But if the platform confirmed silence, trust it over VAD fluctuations —
          // only onPlatformSpeechStart should override platform EOT.
          if ((vadEOTFired || platformEOTFired) && !platformConfirmedSilent) {
            clearDeferredEndOfTurn();
            clearPlatformResolve();
            vadEOTFired = false;
            platformEOTFired = false;
            firstEOTAt = null;
            vad.reset();
          }
        }

        prevState = state;

        if (state === "end_of_turn") {
          const now = Date.now();
          if (toolCallInProgress) {
            // Agent is executing a tool — don't end the turn.
            // Reset VAD so it can detect the post-tool-call speech.
            clearDeferredEndOfTurn();
            clearPlatformResolve();
            console.log(`    [vad] Suppressed end_of_turn — tool call in progress`);
            vadEOTFired = false;
            platformEOTFired = false;
            firstEOTAt = null;
            vad.reset();
          } else if (shouldWaitForPostToolContinuation(now)) {
            if (!vadDeferTimer) {
              vadEOTFired = true;
              if (firstEOTAt === null) firstEOTAt = now;
              console.log(
                `    [vad] end_of_turn detected shortly after tool completion — waiting ` +
                `${postToolCallContinuationMs}ms for assistant continuation`
              );
              vadDeferTimer = setTimeout(() => {
                scheduleContinuationResolve("post-tool continuation window");
              }, postToolCallContinuationMs);
            }
          } else if (postVadContinuationMs > 0) {
            if (!vadDeferTimer) {
              vadEOTFired = true;
              if (firstEOTAt === null) firstEOTAt = now;
              console.log(
                `    [vad] end_of_turn detected — waiting ${postVadContinuationMs}ms ` +
                `for assistant continuation`
              );
              vadDeferTimer = setTimeout(() => {
                scheduleContinuationResolve("continuation window");
              }, postVadContinuationMs);
            }
          } else if (opts.preferPlatformEOT && !platformEOTFired) {
            // If the platform recently fired EOT (within FRESH window) and audible
            // tail audio reset platformEOTFired, trust the platform signal — the
            // tail was the agent finishing, not resuming. Resolve via drain
            // instead of waiting 3s for a phantom new platform EOT (Retell only
            // emits one final agent_stop_talking, then goes silent).
            const platformAgeMs = lastPlatformEOTAt !== null ? now - lastPlatformEOTAt : Infinity;
            if (platformAgeMs < PLATFORM_EOT_FRESH_MS) {
              console.log(
                `    [vad] end_of_turn detected (platformEndOfTurn was ${platformAgeMs}ms ago) — resolving via drain`
              );
              resolveNow("end_of_turn after recent platformEndOfTurn");
            } else if (!vadDeferTimer) {
              vadEOTFired = true;
              if (firstEOTAt === null) firstEOTAt = now;
              console.log(`    [vad] end_of_turn detected — waiting up to 3000ms for platformEndOfTurn`);
              vadDeferTimer = setTimeout(() => {
                vadDeferTimer = null;
                console.log(`    [vad] deferred end_of_turn elapsed — resolving without platformEndOfTurn`);
                cleanup();
                resolve();
              }, 3000);
            }
          } else {
            resolveNow("end_of_turn detected");
          }
        }
      };

      const onPlatformSpeechStart = () => {
        platformSpeechStartedAt = Date.now();
        platformConfirmedSilent = false;
        if (!vadDeferTimer && !platformEOTResolveTimer && !vadEOTFired && !platformEOTFired) {
          return;
        }
        console.log(`    [vad] platform speech resumed during continuation window — extending turn`);
        clearDeferredEndOfTurn();
        clearPlatformResolve();
        vadEOTFired = false;
        platformEOTFired = false;
        firstEOTAt = null;
        vad.reset();
      };

      const onError = (err: Error) => {
        timedOut = true;
        cleanup();
        resolve();
      };

      const onToolCallActive = (active: boolean) => {
        if (toolCallCapTimer) clearTimeout(toolCallCapTimer);
        toolCallCapTimer = active
          ? setTimeout(() => {
            console.log(`    [vad] No tool result after ${TOOL_CALL_MAX_MS / 1000}s — treating the tool call as finished`);
            onToolCallActive(false);
          }, TOOL_CALL_MAX_MS)
          : null;
        toolCallInProgress = active;
        console.log(`    [vad] toolCallActive=${active} vadEOTFired=${vadEOTFired}`);
        if (active) {
          lastToolCallCompletedAt = null;
          clearDeferredEndOfTurn();
          clearPlatformResolve();
          vadEOTFired = false;
          platformEOTFired = false;
          vad.reset();
          return;
        }
        lastToolCallCompletedAt = Date.now();
        if (!active && vadEOTFired) {
          // Tool call completed and VAD had already fired — agent may speak now.
          // Reset VAD to detect the post-tool-call response.
          clearDeferredEndOfTurn();
          clearPlatformResolve();
          console.log(`    [vad] Tool call completed, resetting VAD for post-tool speech`);
          vadEOTFired = false;
          platformEOTFired = false;
          vad.reset();
        }
      };

      // Platform-level end-of-turn signal (e.g. LiveKit agent state → "listening").
      // Fires when the platform knows the agent finished speaking — more reliable
      // than VAD for streaming TTS which produces audio in tiny bursts.
      const onPlatformEOT = () => {
        if (!opts.preferPlatformEOT) return;
        platformEOTFired = true;
        platformConfirmedSilent = true;
        lastPlatformEOTAt = Date.now();
        console.log(`    [vad] platformEndOfTurn fired vadEOTFired=${vadEOTFired} toolCallInProgress=${toolCallInProgress}`);
        if (toolCallInProgress) {
          console.log(`    [vad] platformEndOfTurn ignored while tool call is active`);
          return;
        }
        // Clear the 3s VAD defer timer if VAD already fired — platform has confirmed.
        if (vadEOTFired) {
          clearDeferredEndOfTurn();
        }
        // Always use settle timer regardless of vadEOTFired. VAD end_of_turn can
        // trigger on brief TTS gaps between sentences — not true end of response.
        // The settle window lets agent_start_talking cancel via onPlatformSpeechStart.
        if (!platformEOTResolveTimer) {
          console.log(`    [vad] platformEndOfTurn — waiting ${PLATFORM_EOT_SETTLE_MS}ms settle (vadEOTFired=${vadEOTFired})`);
          platformEOTResolveTimer = setTimeout(() => {
            platformEOTResolveTimer = null;
            resolveNow("platformEndOfTurn after settle");
          }, PLATFORM_EOT_SETTLE_MS);
        }
      };

      // Resettable timeout — resets on every speech segment so we only
      // time out after prolonged silence, never mid-speech.
      let timeout: ReturnType<typeof setTimeout>;
      const startTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          timedOut = true;
          const avgSpeechRms = speechChunkCount > 0 ? Math.round(speechChunkRmsSum / speechChunkCount) : 0;
          console.log(
            `    [collect:${debugLabel}] timeout firstChunk=${firstChunkAt !== null} speechOnset=${speechOnsetAt !== null} ` +
            `lastChunkAge=${lastChunkAt != null ? Date.now() - lastChunkAt : "n/a"}ms ` +
            `lastAudibleAge=${lastAudibleAudioAt != null ? Date.now() - lastAudibleAudioAt : "n/a"}ms`
          );
          console.log(`    [vad-diag] collection timed out: chunks=${chunks.length} speechSegments=${speechSegments} speechOnset=${speechOnsetAt !== null}`);
          console.log(`    [vad-diag] energy: <100=${energyBuckets.below100} 100-250=${energyBuckets.r100_250} 250-500=${energyBuckets.r250_500} 500-1k=${energyBuckets.r500_1000} 1k-3k=${energyBuckets.r1000_3000} >3k=${energyBuckets.above3000} maxRms=${Math.round(maxRms)} avgSpeechRms=${avgSpeechRms}`);
          cleanup();
          resolve();
        }, timeoutMs);
      };
      startTimeout();

      const onDisconnected = () => {
        console.log(`    [collect:${debugLabel}] channel_disconnected`);
        console.log(`    [vad] Channel disconnected during collection — ending turn`);
        cleanup();
        resolve();
      };

      function cleanup() {
        clearTimeout(timeout);
        if (toolCallCapTimer) clearTimeout(toolCallCapTimer);
        clearDeferredEndOfTurn();
        clearPlatformResolve();
        channel.off("audio", onAudio);
        channel.off("error", onError);
        channel.off("platformEndOfTurn", onPlatformEOT);
        channel.off("platformSpeechStart", onPlatformSpeechStart);
        channel.off("toolCallActive", onToolCallActive);
        channel.off("disconnected", onDisconnected);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      }

      const onAbort = () => {
        aborted = true;
        cleanup();
        resolve();
      };

      // If the channel already disconnected before we started collecting, resolve immediately.
      if (!channel.connected) {
        console.log(`    [collect:${debugLabel}] channel_already_disconnected`);
        console.log(`    [vad] Channel already disconnected — skipping collection`);
        resolve();
        return;
      }

      channel.on("audio", onAudio);
      channel.on("error", onError);
      channel.on("platformEndOfTurn", onPlatformEOT);
      channel.on("platformSpeechStart", onPlatformSpeechStart);
      channel.on("toolCallActive", onToolCallActive);
      channel.on("disconnected", onDisconnected);
      if (opts.signal) {
        if (opts.signal.aborted) { aborted = true; resolve(); return; }
        opts.signal.addEventListener("abort", onAbort);
      }
    });
  } finally {
    // Account for speech that was still ongoing at end
    if (speechStartedAt !== null) {
      totalSpeechMs += Date.now() - speechStartedAt;
    }
    if (ownsVAD) vad.destroy();
  }

  console.log(
    `    [collect:${debugLabel}] done bytes=${chunks.reduce((sum, chunk) => sum + chunk.length, 0)} timedOut=${timedOut} aborted=${aborted} ` +
    `speechSegments=${speechSegments} totalSpeechMs=${totalSpeechMs} firstChunkAt=${firstChunkAt ?? "n/a"} ` +
    `speechOnsetAt=${speechOnsetAt ?? "n/a"} lastChunkAt=${lastChunkAt ?? "n/a"} lastAudibleAt=${lastAudibleAudioAt ?? "n/a"}`
  );

  return {
    audio: concatPcm(chunks),
    timedOut,
    aborted,
    stats: { speechSegments, maxInternalSilenceMs, totalSpeechMs, firstChunkAt, speechOnsetAt },
  };
}

/**
 * Collect audio from the channel for a fixed duration.
 */
export async function collectForDuration(
  channel: AudioChannel,
  durationMs: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve) => {
    const onAudio = (chunk: Buffer) => {
      chunks.push(chunk);
    };

    const onError = () => {
      clearTimeout(timeout);
      channel.off("audio", onAudio);
      channel.off("error", onError);
      resolve();
    };

    const timeout = setTimeout(() => {
      channel.off("audio", onAudio);
      channel.off("error", onError);
      resolve();
    }, durationMs);

    channel.on("audio", onAudio);
    channel.on("error", onError);
  });

  return concatPcm(chunks);
}

/**
 * Wait until VAD detects the first speech in the channel audio,
 * or timeout. Returns the timestamp when speech was first detected.
 */
export async function waitForSpeech(
  channel: AudioChannel,
  timeoutMs = 10000
): Promise<{ detectedAt: number; timedOut: boolean }> {
  const vad = new VoiceActivityDetector({ silenceThresholdMs: 500 });
  await vad.init();

  let timedOut = false;
  let detectedAt = 0;

  try {
    await new Promise<void>((resolve) => {
      const onAudio = (chunk: Buffer) => {
        const state = vad.process(chunk);
        if (state === "speech") {
          detectedAt = Date.now();
          clearTimeout(timeout);
          channel.off("audio", onAudio);
          channel.off("error", onError);
          resolve();
        }
      };

      const onError = () => {
        timedOut = true;
        clearTimeout(timeout);
        channel.off("audio", onAudio);
        channel.off("error", onError);
        resolve();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        channel.off("audio", onAudio);
        channel.off("error", onError);
        resolve();
      }, timeoutMs);

      channel.on("audio", onAudio);
      channel.on("error", onError);
    });
  } finally {
    vad.destroy();
  }

  return { detectedAt, timedOut };
}

/**
 * Transcribe a PCM audio buffer using Deepgram batch STT.
 * Returns the transcribed text, or empty string if audio is too short.
 */
export async function transcribeAudio(audio: Buffer): Promise<string> {
  if (audio.length < 4800) return ""; // < 100ms of audio
  const { text } = await sttTranscribe(audio);
  return text;
}

/**
 * Jaccard token overlap similarity (0-1).
 * Used to compare clean vs degraded responses.
 */
export function textSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Simple linear regression slope for drift detection.
 * Returns ms-per-turn drift rate.
 */
export function linearRegressionSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
