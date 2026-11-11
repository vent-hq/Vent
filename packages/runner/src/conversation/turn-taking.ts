/**
 * Turn-taking for conversation calls: collecting the agent's audio until it
 * finishes its turn, and how long to wait before deciding it has.
 */

import type { AudioChannel } from "@vent/adapters";
import { concatPcm, pcmRms } from "@vent/shared";
import type { VoiceActivityDetector, VADState } from "@vent/voice";

/** Longest a platform may report a tool call as running before Vent stops waiting on it. */
const TOOL_CALL_MAX_MS = 30_000;
/** After a platform's end-of-turn signal, how long to wait in case the agent keeps talking. */
const PLATFORM_EOT_SETTLE_MS = 500;

/**
 * How patiently Vent waits for the agent to finish its turn. Platforms that
 * report when the agent stops talking (hasPlatformEndOfTurn) can be trusted
 * quickly. On the rest, Vent's own voice detection decides, so it waits out
 * the agent's natural pauses: mid-reply, and right after a tool result.
 *
 * vadEnergyFloorRms: with platform signals the VAD only has to notice the agent
 * still talking, so it keeps quiet speech (some platforms' TTS sits at RMS
 * 100–250). Without them the VAD alone ends the turn, so it ignores line noise
 * between utterances (measured up to RMS ~240 on Retell and Vapi), which TEN VAD
 * scores right at its threshold and which otherwise keeps a turn from ending.
 */
export function turnTiming(hasPlatformEndOfTurn: boolean) {
  return hasPlatformEndOfTurn
    ? { silenceThresholdMs: 400, postVadContinuationMs: 0, postToolCallContinuationMs: 0, vadEnergyFloorRms: 100 }
    : { silenceThresholdMs: 1200, postVadContinuationMs: 1000, postToolCallContinuationMs: 2000, vadEnergyFloorRms: 250 };
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
 *
 * On channels that report hasPlatformEndOfTurn (read once, at the start), VAD
 * end-of-turn waits for the platform's confirmation (up to 3s), which keeps
 * Vent from cutting the agent off when VAD triggers on a pause.
 */
export async function collectUntilEndOfTurn(
  channel: AudioChannel,
  opts: {
    timeoutMs: number;
    /** Debug label for collector logs. */
    debugLabel: string;
    /** Pre-initialized VAD instance — reused across turns to avoid WASM reload. */
    vad: VoiceActivityDetector;
  }
): Promise<{ audio: Buffer; timedOut: boolean; stats: CollectionStats }> {
  const { timeoutMs, debugLabel, vad } = opts;
  const preferPlatformEOT = !!channel.hasPlatformEndOfTurn;
  const { postToolCallContinuationMs, postVadContinuationMs, vadEnergyFloorRms } = turnTiming(preferPlatformEOT);
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

  vad.energyFloorRms = vadEnergyFloorRms;
  vad.reset();

  const chunks: Buffer[] = [];
  let timedOut = false;

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

  try {
    await new Promise<void>((resolve) => {
      console.log(
        `    [collect:${debugLabel}] start timeout=${timeoutMs}ms silenceThreshold=${vad.silenceThresholdMs}ms ` +
        `preferPlatformEOT=${preferPlatformEOT} ` +
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
       *  platform EOT that won't come — the platform signals once when the
       *  agent stops, then goes silent waiting for the user. */
      let lastPlatformEOTAt: number | null = null;
      /** Whether the agent had been heard in this turn before the latest
       *  platformEndOfTurn. A signal that arrives before any agent speech is
       *  left over from before the turn, not the end of this reply. */
      let platformEOTAfterAgentSpeech = false;
      /** Whether the hold below has already been logged for the current settle. */
      let platformSettleHeld = false;
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

      /**
       * Drop any end-of-turn decision in progress and restart VAD.
       * agentResumed: the agent was heard again, so the platform's
       * "agent went silent" confirmation no longer holds either.
       * keepBudget: leave the extension budget (firstEOTAt) running — used for
       * tool-call transitions, which are not the agent resuming speech.
       */
      const cancelEndOfTurn = ({ agentResumed = false, keepBudget = false } = {}) => {
        clearDeferredEndOfTurn();
        clearPlatformResolve();
        vadEOTFired = false;
        platformEOTFired = false;
        if (agentResumed) platformConfirmedSilent = false;
        if (!keepBudget) firstEOTAt = null;
        vad.reset();
      };

      /** Resolve once the platform's end of turn has held for PLATFORM_EOT_SETTLE_MS. */
      const startPlatformSettle = () => {
        platformEOTResolveTimer = setTimeout(() => {
          platformEOTResolveTimer = null;
          resolveNow("platformEndOfTurn after settle");
        }, PLATFORM_EOT_SETTLE_MS);
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
        const rms = pcmRms(chunk);
        const state = vad.process(chunk);
        const now = Date.now();
        if (firstChunkAt === null) firstChunkAt = now;
        if (lastChunkAt === null) {
          console.log(`    [collect:${debugLabel}] first_audio_chunk`);
        }
        lastChunkAt = now;
        if (rms > audibleDrainRmsThreshold) lastAudibleAudioAt = now;

        // The platform said the agent stopped after speaking and hasn't said it
        // started again, but agent audio is still arriving (its tail lands after
        // the signal, or it carries on without a new "speaking" event). Hold the
        // end of turn until that audio has been quiet for the settle period.
        // Cancelling instead reset the VAD, and with no audio left to re-arm it
        // nothing could end the turn.
        const holdingPlatformSettle = !!platformEOTResolveTimer && platformConfirmedSilent && platformEOTAfterAgentSpeech;
        if (holdingPlatformSettle && (rms > audibleDrainRmsThreshold || state === "speech")) {
          // Real speech refreshes the extension budget; it only caps noise.
          if (state === "speech") firstEOTAt = now;
          if (firstEOTAt !== null && now - firstEOTAt > extensionBudgetMs) {
            console.log(`    [vad] agent audio after platformEndOfTurn but extension budget exhausted (${extensionBudgetMs}ms) — letting it resolve`);
          } else {
            if (!platformSettleHeld) {
              console.log(`    [vad] agent audio after platformEndOfTurn — holding end of turn until ${PLATFORM_EOT_SETTLE_MS}ms quiet`);
              platformSettleHeld = true;
            }
            clearPlatformResolve();
            startPlatformSettle();
          }
        }

        if (rms > audibleDrainRmsThreshold && !holdingPlatformSettle) {
          // Audible audio during the continuation window or the platform EOT
          // settle means the agent may still be talking.
          if (vadDeferTimer || platformEOTResolveTimer) {
            const window = vadDeferTimer ? "continuation window" : "platform EOT settle";
            if (firstEOTAt !== null && now - firstEOTAt > extensionBudgetMs) {
              console.log(
                `    [vad] audible audio during ${window} but extension budget exhausted (${extensionBudgetMs}ms) — letting it resolve`
              );
            } else {
              console.log(`    [vad] Audible audio arrived during ${window} — extending turn`);
              // Real speech (RMS > audibleDrainRmsThreshold) resumed — a
              // legitimate continuation, not noise — so the extension budget
              // resets and the next pause-then-resume cycle gets a fresh window.
              // Without this, chunked TTS responses with multiple tool-call
              // pauses (Retell, etc.) accumulate against an 8s cap and resolve
              // mid-response.
              cancelEndOfTurn({ agentResumed: true });
            }
          }
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
            cancelEndOfTurn({ agentResumed: true });
          }
        }

        prevState = state;

        if (state === "end_of_turn") {
          const now = Date.now();
          const afterToolCall = shouldWaitForPostToolContinuation(now);
          if (toolCallInProgress) {
            // Agent is executing a tool — don't end the turn.
            // Reset VAD so it can detect the post-tool-call speech.
            console.log(`    [vad] Suppressed end_of_turn — tool call in progress`);
            cancelEndOfTurn();
          } else if (afterToolCall || postVadContinuationMs > 0) {
            // Wait out a natural pause (longer right after a tool result) in
            // case the agent continues.
            if (!vadDeferTimer) {
              const waitMs = afterToolCall ? postToolCallContinuationMs : postVadContinuationMs;
              vadEOTFired = true;
              if (firstEOTAt === null) firstEOTAt = now;
              console.log(
                `    [vad] end_of_turn detected${afterToolCall ? " shortly after tool completion" : ""} — ` +
                `waiting ${waitMs}ms for assistant continuation`
              );
              vadDeferTimer = setTimeout(() => {
                scheduleContinuationResolve(afterToolCall ? "post-tool continuation window" : "continuation window");
              }, waitMs);
            }
          } else if (preferPlatformEOT && !platformEOTFired) {
            // If the platform recently fired EOT (within FRESH window) and audible
            // tail audio reset platformEOTFired, trust the platform signal — the
            // tail was the agent finishing, not resuming. Resolve via drain
            // instead of waiting 3s for a phantom new platform EOT (the platform
            // signals once when the agent stops, then goes silent).
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
        cancelEndOfTurn({ agentResumed: true });
      };

      const onError = () => {
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
          cancelEndOfTurn({ keepBudget: true });
          return;
        }
        lastToolCallCompletedAt = Date.now();
        if (vadEOTFired) {
          // Tool call completed and VAD had already fired — agent may speak now.
          // Reset VAD to detect the post-tool-call response.
          console.log(`    [vad] Tool call completed, resetting VAD for post-tool speech`);
          cancelEndOfTurn({ keepBudget: true });
        }
      };

      // Platform-level end-of-turn signal (e.g. LiveKit agent state → "listening").
      // Fires when the platform knows the agent finished speaking — more reliable
      // than VAD for streaming TTS which produces audio in tiny bursts.
      const onPlatformEOT = () => {
        if (!preferPlatformEOT) return;
        platformEOTFired = true;
        platformConfirmedSilent = true;
        lastPlatformEOTAt = Date.now();
        platformEOTAfterAgentSpeech = speechOnsetAt !== null;
        if (firstEOTAt === null) firstEOTAt = lastPlatformEOTAt;
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
          platformSettleHeld = false;
          startPlatformSettle();
        }
      };

      // Resettable timeout — resets on every speech segment so we only
      // time out after prolonged silence, never mid-speech.
      let timeout: ReturnType<typeof setTimeout>;
      const startTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          timedOut = true;
          console.log(
            `    [collect:${debugLabel}] timeout firstChunk=${firstChunkAt !== null} speechOnset=${speechOnsetAt !== null} ` +
            `lastChunkAge=${lastChunkAt != null ? Date.now() - lastChunkAt : "n/a"}ms ` +
            `lastAudibleAge=${lastAudibleAudioAt != null ? Date.now() - lastAudibleAudioAt : "n/a"}ms`
          );
          console.log(`    [vad-diag] collection timed out: chunks=${chunks.length} speechSegments=${speechSegments} speechOnset=${speechOnsetAt !== null}`);
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
      }

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
    });
  } finally {
    // Account for speech that was still ongoing at end
    if (speechStartedAt !== null) {
      totalSpeechMs += Date.now() - speechStartedAt;
    }
  }

  console.log(
    `    [collect:${debugLabel}] done bytes=${chunks.reduce((sum, chunk) => sum + chunk.length, 0)} timedOut=${timedOut} ` +
    `speechSegments=${speechSegments} totalSpeechMs=${totalSpeechMs} firstChunkAt=${firstChunkAt ?? "n/a"} ` +
    `speechOnsetAt=${speechOnsetAt ?? "n/a"} lastChunkAt=${lastChunkAt ?? "n/a"} lastAudibleAt=${lastAudibleAudioAt ?? "n/a"}`
  );

  return {
    audio: concatPcm(chunks),
    timedOut,
    stats: { speechSegments, maxInternalSilenceMs, totalSpeechMs, firstChunkAt, speechOnsetAt },
  };
}
