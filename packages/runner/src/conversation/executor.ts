/**
 * Conversation call executor — runs a full dynamic conversation loop.
 *
 * Flow:
 * 1. Caller LLM generates text from persona prompt
 * 2. TTS → send audio to agent via AudioChannel
 * 3. Collect agent audio (VAD for end-of-turn)
 * 4. STT → text back to caller LLM
 * 5. Repeat until max_turns or the caller decides the conversation is over
 * 6. Compute metrics (latency, audio, tool calls)
 */

import type { AudioChannel } from "@vent/adapters";
import type {
  ConversationCallSpec,
  ConversationCallResult,
  ConversationTurn,
  ConversationMetrics,
  ObservedToolCall,
  ToolCallMetrics,
  ComponentLatency,
  ComponentLatencyMetrics,
  LatencyMetrics,
  HarnessOverhead,
} from "@vent/shared";
import { synthesize, TTSSession, BatchVAD, VoiceActivityDetector, StreamingTranscriber, applyEffects, resolveAccentVoiceId, resolveLanguageVoiceId, resolveGenderVoiceId, analyzeAudioQuality, concatPcm, type AudioQualityMetrics } from "@vent/voice";
import { CallerLLM, type CallerDecision } from "./caller-llm.js";
import { collectUntilEndOfTurn, linearRegressionSlope, turnTiming } from "../audio-tests/helpers.js";
import { computeAllMetrics } from "../metrics/index.js";
import { AdaptiveThreshold } from "./adaptive-threshold.js";

function summarizeDebugText(text: string | null | undefined, maxChars = 96): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function prepareCallerSpeechText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sinceStartMs(startTime: number): number {
  return Math.round(performance.now() - startTime);
}

// Merge adjacent same-role agent turns. The 1500ms end-of-turn VAD can split a
// single agent utterance across two executor turns (e.g. "Let me" → caller waits
// → "ask my mother..."); the resulting pair is one logical turn for the user.
// Only the first fragment's TTFB/TTFW reflect real response latency; subsequent
// fragments are a continuation, so their timing fields are dropped.
function mergeFracturedAgentTurns(turns: ConversationTurn[]): ConversationTurn[] {
  const merged: ConversationTurn[] = [];
  for (const turn of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === "agent" && turn.role === "agent") {
      const joinedText = [prev.text, turn.text].filter((t) => t && t.length > 0).join(" ");
      prev.text = joinedText;
      if (turn.audio_duration_ms != null) {
        prev.audio_duration_ms = (prev.audio_duration_ms ?? 0) + turn.audio_duration_ms;
      }
      if (turn.stt_ms != null) {
        prev.stt_ms = (prev.stt_ms ?? 0) + turn.stt_ms;
      }
      if (turn.platform_transcript) {
        prev.platform_transcript = [prev.platform_transcript, turn.platform_transcript]
          .filter((t) => t && t.length > 0)
          .join(" ");
      }
      continue;
    }
    merged.push({ ...turn });
  }
  return merged;
}

export interface RunConversationCallOpts {
  /** Called after channel.connect() resolves, while runConversationCall owns
   *  the lifecycle. Used by the outer runner to start recording upload after
   *  the channel is ready — kept as a callback so connect() can be invoked
   *  here, not before runConversationCall, so the STT listener is attached
   *  BEFORE the transport starts emitting audio. */
  onConnected?: () => Promise<void>;
  /** External cancel signal. Checked at the top of every turn — when fired,
   *  the call is aborted, partial transcript is preserved, and the channel
   *  is hung up via safeDisconnect (which stops the real platform call). */
  signal?: AbortSignal;
}

/** Prefix for failures of Vent's own components (caller LLM, STT/TTS, VAD),
 *  so they aren't mistaken for the agent under test failing. */
const VENT_FAILED = "Vent failed, agent not tested: ";

/** An error on the agent's side of the connection; reported with its raw message. */
class PlatformError extends Error {}

function ventFailure(err: unknown): never {
  throw new Error(VENT_FAILED + (err instanceof Error ? err.message : String(err)));
}

export async function runConversationCall(
  spec: ConversationCallSpec,
  channel: AudioChannel,
  opts: RunConversationCallOpts = {},
): Promise<ConversationCallResult> {
  const startTime = performance.now();
  const transcript: ConversationTurn[] = [];
  const ttfbValues: number[] = [];
  const ttfwValues: number[] = [];

  const language = spec.language;
  const caller = new CallerLLM(spec.caller_prompt, spec.persona, language);
  const adaptiveThreshold = new AdaptiveThreshold({
    baseMs: turnTiming(!!channel.hasPlatformEndOfTurn).silenceThresholdMs,
  });

  // Resolve TTS voice ID. Priority: caller_audio.accent > voice (English-only) > language default.
  const ttsVoiceId = spec.caller_audio?.accent
    ? resolveAccentVoiceId(spec.caller_audio.accent)
    : spec.voice && (!language || language === "en")
      ? resolveGenderVoiceId(spec.voice)
      : language
        ? resolveLanguageVoiceId(language)
        : undefined;
  const ttsOpts = ttsVoiceId ? { voiceId: ttsVoiceId } : undefined;

  // Set up everything Vent needs to hear and speak BEFORE dialing the agent:
  // if Deepgram fails here, the run fails before the customer's platform has
  // placed (and billed) a call. The caller's first turn is generated only
  // after the real greeting turn is collected.
  const turnVAD = new VoiceActivityDetector({ silenceThresholdMs: adaptiveThreshold.thresholdMs });
  const batchVAD = new BatchVAD();
  const transcriber = new StreamingTranscriber(language ? { language } : undefined);
  // Persistent TTS session — one WebSocket for all turns (avoids REST rate limit)
  const ttsSession = new TTSSession(ttsOpts);

  await Promise.all([
    turnVAD.init(),
    batchVAD.init(),
    transcriber.connect(),
    ttsSession.connect(),
  ]).catch(ventFailure);

  // Attach the opening STT feed BEFORE connecting the channel's transport so
  // no audio frames can arrive with zero listeners. Greeting-start clipping
  // (the "Hi, Thanks" prefix getting dropped from the transcript) comes from
  // this exact window — any audio emitted before the listener attaches is
  // lost (we deliberately don't buffer, since bursting a buffer into Deepgram
  // collapses its endpointing). Detached again after the opening finalize
  // so subsequent turns can manage their own attach/detach without duplicate
  // listeners double-feeding Deepgram.
  const openingFeedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
  channel.on("audio", openingFeedSTT);
  await channel.connect();
  await opts.onConnected?.();

  const openingSpeaker = await channel.getOpeningSpeaker?.() ?? "agent";
  const maxCallDurationSeconds = await channel.getMaxCallDurationSeconds?.() ?? null;
  const callDeadlineMs = maxCallDurationSeconds != null
    ? startTime + Math.max(0, maxCallDurationSeconds * 1000 - 1000)
    : null;
  const collectGreetingFirst = openingSpeaker !== "caller";
  console.log(
    `    [opening] speaker=${openingSpeaker}` +
    (maxCallDurationSeconds != null ? ` maxDuration=${maxCallDurationSeconds}s` : "")
  );

  const remainingCallMs = (): number | null => {
    if (callDeadlineMs == null) return null;
    return Math.max(0, Math.floor(callDeadlineMs - performance.now()));
  };

  const resolveCollectionTimeoutMs = (defaultMs: number): number => {
    const remainingMs = remainingCallMs();
    if (remainingMs == null) return defaultMs;
    return Math.max(250, Math.min(defaultMs, remainingMs));
  };

  const canStartAnotherTurn = (minimumMs = 1500): boolean => {
    const remainingMs = remainingCallMs();
    return remainingMs == null || remainingMs > minimumMs;
  };

  const turnSignalQualities: AudioQualityMetrics[] = [];
  let agentText: string | null = null;

  // Track channel disconnect — when the agent hangs up, the call ends naturally.
  let channelDisconnected = false;
  /** How a completed call ended, when Vent ended it or the connection closed. */
  let endNote: string | undefined;
  const connectionClosedNote = "The connection closed (platform, agent or network).";
  const safeDisconnect = async () => {
    if (channelDisconnected || !channel.connected) return;
    try {
      await channel.disconnect();
    } catch (err) {
      console.log(`    [end] Non-fatal disconnect error: ${(err as Error).message}`);
    } finally {
      channelDisconnected = true;
    }
  };
  channel.on("disconnected", () => {
    channelDisconnected = true;
    console.log(`    [end] Connection closed`);
  });

  /**
   * Build a ConversationCallResult from the in-scope conversation state.
   * Used by both the success path and the error catch — every metric is
   * computed in its own try/catch so a partial-data failure on one field
   * doesn't crash the recovery for the others. The user gets as much
   * information as we can salvage, no matter where the conversation aborted.
   */
  const buildResult = async (
    finalStatus: "completed" | "error",
    finalError?: string,
  ): Promise<ConversationCallResult> => {
    const safe = <T>(fn: () => T, fallback: T, label: string): T => {
      try { return fn(); } catch (e) {
        console.warn(`    [build-result] ${label} failed: ${(e as Error).message}`);
        return fallback;
      }
    };
    const safeAsync = async <T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
      try { return await fn(); } catch (e) {
        console.warn(`    [build-result] ${label} failed: ${(e as Error).message}`);
        return fallback;
      }
    };

    // Ensure the channel is flushed before reading post-call data. Idempotent.
    await safeAsync(() => safeDisconnect(), undefined, "safeDisconnect");

    // Collapse VAD-fractured agent turns. In-place mutation of `transcript`.
    safe(() => {
      const merged = mergeFracturedAgentTurns(transcript);
      transcript.length = 0;
      transcript.push(...merged);
    }, undefined, "mergeFracturedAgentTurns");

    // Channel-side data: tool calls + call metadata.
    const observedToolCalls: ObservedToolCall[] =
      (await safeAsync(() => channel.getCallData?.() ?? Promise.resolve([]), [], "getCallData")) ?? [];
    if (observedToolCalls.length > 0) {
      console.log(`    Collected ${observedToolCalls.length} tool call(s) from channel`);
      safe(() => {
        const agentTurns = transcript
          .map((t, i) => ({ timestamp_ms: t.timestamp_ms, index: i }))
          .filter((_, i) => transcript[i]!.role === "agent");
        for (const tc of observedToolCalls) {
          if (tc.timestamp_ms == null) continue;
          let matched = 0;
          for (const at of agentTurns) {
            if (at.timestamp_ms <= tc.timestamp_ms) matched = at.index;
            else break;
          }
          tc.turn_index = matched;
        }
      }, undefined, "matchToolCallsToTurns");
    }

    const callMetadata = await safeAsync(
      () => channel.getCallMetadata?.() ?? Promise.resolve(null),
      null,
      "getCallMetadata",
    ) ?? null;
    if (callMetadata) {
      console.log(`    Call metadata: ended_reason=${callMetadata.ended_reason ?? "unknown"}, cost=$${callMetadata.cost_usd?.toFixed(4) ?? "n/a"}`);
    }

    // Mean ttfb / ttfw — required field, fall back to 0.
    const meanTtfb = ttfbValues.length > 0
      ? Math.round(ttfbValues.reduce((a, b) => a + b, 0) / ttfbValues.length)
      : 0;
    const meanTtfw = ttfwValues.length > 0
      ? Math.round(ttfwValues.reduce((a, b) => a + b, 0) / ttfwValues.length)
      : undefined;

    // Tool-call summary metrics.
    const toolCallMetrics = safe<ToolCallMetrics | undefined>(() => {
      if (observedToolCalls.length === 0) return undefined;
      const successful = observedToolCalls.filter((tc) => tc.successful === true).length;
      const failed = observedToolCalls.filter((tc) => tc.successful === false).length;
      const latencies = observedToolCalls
        .map((tc) => tc.latency_ms)
        .filter((l): l is number => l != null);
      const meanLatency = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : undefined;
      const names = [...new Set(observedToolCalls.map((tc) => tc.name))];
      return { total: observedToolCalls.length, successful, failed, mean_latency_ms: meanLatency, names };
    }, undefined, "toolCallMetrics");

    // Component latency: per-turn STT/LLM/TTS, plus aggregates.
    const componentLatencyMetrics = safe<ComponentLatencyMetrics | undefined>(() => {
      const rawComponentTimings = channel.getComponentTimings?.() ?? [];
      if (rawComponentTimings.length === 0) return undefined;

      const agentTurnsForLatency = transcript
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.role === "agent");
      const responseAgentTurns = collectGreetingFirst ? agentTurnsForLatency.slice(1) : agentTurnsForLatency;

      for (let i = 0; i < rawComponentTimings.length && i < responseAgentTurns.length; i++) {
        const timing = rawComponentTimings[i];
        if (timing && (timing.stt_ms != null || timing.llm_ms != null || timing.tts_ms != null)) {
          responseAgentTurns[i]!.entry.component_latency = timing;
        }
      }

      const sttValues = rawComponentTimings.map((t) => t.stt_ms).filter((v): v is number => v != null);
      const llmValues = rawComponentTimings.map((t) => t.llm_ms).filter((v): v is number => v != null);
      const ttsValues = rawComponentTimings.map((t) => t.tts_ms).filter((v): v is number => v != null);
      const mean = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : undefined;
      const p95 = (arr: number[]) => {
        if (arr.length === 0) return undefined;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = 0.95 * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const value = lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
        return Math.round(value);
      };

      const meanStt = mean(sttValues);
      const meanLlm = mean(llmValues);
      const meanTts = mean(ttsValues);
      let bottleneck: "stt" | "llm" | "tts" | undefined;
      if (meanStt != null && meanLlm != null && meanTts != null) {
        const max = Math.max(meanStt, meanLlm, meanTts);
        if (max === meanLlm) bottleneck = "llm";
        else if (max === meanStt) bottleneck = "stt";
        else bottleneck = "tts";
      }
      console.log(`    Component latency: STT=${meanStt ?? "?"}ms LLM=${meanLlm ?? "?"}ms TTS=${meanTts ?? "?"}ms [bottleneck: ${bottleneck ?? "unknown"}]`);
      return {
        per_turn: rawComponentTimings,
        mean_stt_ms: meanStt,
        mean_llm_ms: meanLlm,
        mean_tts_ms: meanTts,
        p95_stt_ms: p95(sttValues),
        p95_llm_ms: p95(llmValues),
        p95_tts_ms: p95(ttsValues),
        bottleneck,
      };
    }, undefined, "componentLatency");

    // Merge platform STT transcripts into caller turns.
    safe(() => {
      const platformTranscripts = channel.getTranscripts?.() ?? [];
      for (const pt of platformTranscripts) {
        const callerTurns = transcript.filter((t) => t.role === "caller");
        if (pt.turnIndex < callerTurns.length) {
          callerTurns[pt.turnIndex]!.platform_transcript = pt.text;
        }
      }
    }, undefined, "platformTranscripts");

    // Deep latency metrics (percentiles, mouth-to-ear estimate, etc).
    const latencyResult = await safeAsync(
      () => computeAllMetrics(transcript, channel.stats.connectLatencyMs),
      { latency: undefined as LatencyMetrics | undefined, harness_overhead: undefined as HarnessOverhead | undefined },
      "computeAllMetrics",
    );

    // Aggregate signal quality across turns.
    const signalQuality = safe(() => {
      if (turnSignalQualities.length === 0) return undefined;
      return {
        mean_snr_db: Math.round(
          turnSignalQualities.reduce((a, q) => a + q.estimated_snr_db, 0) / turnSignalQualities.length * 10,
        ) / 10,
        max_clipping_ratio: Math.max(...turnSignalQualities.map((q) => q.clipping_ratio)),
        energy_consistency: Math.round(
          turnSignalQualities.reduce((a, q) => a + q.energy_consistency, 0) / turnSignalQualities.length * 1000,
        ) / 1000,
        sudden_drops: turnSignalQualities.reduce((a, q) => a + q.sudden_drops, 0),
        sudden_spikes: turnSignalQualities.reduce((a, q) => a + q.sudden_spikes, 0),
        clean_edges: turnSignalQualities.every((q) => q.clean_start && q.clean_end),
      };
    }, undefined, "signalQuality");

    // Drift slope mutation onto the latency object (if computed).
    safe(() => {
      if (latencyResult.latency && ttfbValues.length >= 2) {
        latencyResult.latency.drift_slope_ms_per_turn =
          Math.round(linearRegressionSlope(ttfbValues) * 100) / 100;
      }
    }, undefined, "driftSlope");

    const metrics: ConversationMetrics = {
      mean_ttfb_ms: meanTtfb,
      mean_ttfw_ms: meanTtfw,
      latency: latencyResult.latency,
      signal_quality: signalQuality,
      tool_calls: toolCallMetrics,
      harness_overhead: latencyResult.harness_overhead,
      component_latency: componentLatencyMetrics,
    };

    return {
      name: spec.name,
      caller_prompt: spec.caller_prompt,
      status: finalStatus,
      ...(finalError != null ? { error: finalError } : {}),
      ...(finalStatus === "completed" && endNote ? { end_note: endNote } : {}),
      transcript,
      observed_tool_calls: observedToolCalls.length > 0 ? observedToolCalls : undefined,
      duration_ms: Math.round(performance.now() - startTime),
      metrics,
      call_metadata: callMetadata ?? undefined,
    };
  };

  try {
    // For assistant-speaks-first platforms, turn -1 collects the agent greeting.
    // For caller-speaks-first platforms, we start directly at turn 0.
    for (let turn = collectGreetingFirst ? -1 : 0; turn < spec.max_turns; turn++) {
      if (channelDisconnected) {
        endNote = connectionClosedNote;
        break;
      }
      if (opts.signal?.aborted) {
        // A string reason means Vent itself stopped the call (time limit,
        // worker shutdown); anything else is the user cancelling.
        const reason = opts.signal.reason;
        if (typeof reason === "string" && reason !== "cancelled") {
          throw new Error(`Vent stopped the call: ${reason}`);
        }
        endNote = "Cancelled by user.";
        break;
      }
      if (turn >= 0 && !canStartAnotherTurn()) {
        console.log(`    [call-limit] maxDurationSeconds reached — stopping before turn=${turn}`);
        break;
      }
      // ── Greeting turn: just collect agent audio, no caller speech ──
      if (turn === -1) {
        const vadStart = performance.now();
        // No resetForNextTurn or feedSTT attach here — transcriber is already
        // connected and feedSTT is already attached at call setup so the
        // opening's first audio chunks aren't lost to an unattached listener.
        console.log(`    [opening] collect_start t=${sinceStartMs(startTime)}ms`);

        turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;
        const openingWaitMs = resolveCollectionTimeoutMs(30000);
        const { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
          channel,
          {
            timeoutMs: openingWaitMs,
            vad: turnVAD,
            preferPlatformEOT: !!channel.hasPlatformEndOfTurn,
            debugLabel: "opening",
          }
        );
        console.log(
          `    [opening] collect_end t=${sinceStartMs(startTime)}ms bytes=${agentAudio.length} ` +
          `timedOut=${timedOut} speechOnset=${stats.speechOnsetAt !== null}`
        );

        if (timedOut && stats.speechOnsetAt === null) {
          endNote = `The agent connected but said nothing for ${Math.round(openingWaitMs / 1000)}s; Vent hung up.`;
          break;
        }

        let greetingText = "";
        let greetingSttMs = 0;
        if (stats.speechOnsetAt !== null && agentAudio.length > 4800) {
          const sttStart = performance.now();
          const { text } = await transcriber.finalize();
          greetingSttMs = Math.round(performance.now() - sttStart);
          greetingText = text;
        }
        // Release the call-level STT listener now that the opening is done.
        // Subsequent turns manage their own feedSTT attach/detach around
        // collection to avoid feeding Deepgram during caller-LLM/TTS idle
        // audio (which slows CloseStream).
        channel.off("audio", openingFeedSTT);

        if (greetingText) {
          const vadMs = Math.round(performance.now() - vadStart);
          console.log(`    Agent greeting: "${greetingText.slice(0, 80)}..."`);
          console.log(`[turn-timing] greeting vad_collect=${vadMs}ms stt=${greetingSttMs}ms`);
          console.log(`    [opening] resolved t=${sinceStartMs(startTime)}ms`);
          agentText = greetingText;

          const agentTimestamp = performance.now() - startTime;
          const audioDurationMs = Math.round((agentAudio.length / 2 / 24000) * 1000);
          const speechSegments = batchVAD.analyze(agentAudio);
          turnSignalQualities.push(analyzeAudioQuality(agentAudio, speechSegments));
          transcript.push({
            role: "agent",
            text: greetingText,
            timestamp_ms: Math.round(agentTimestamp),
            audio_duration_ms: audioDurationMs,
            stt_ms: greetingSttMs,
          });
        }

        adaptiveThreshold.update(stats);
        continue;
      }
      // Step 1: Caller LLM generates the next full utterance.
      let callerText: string | null;
      let ttsMs = 0;
      const turnPipelineStart = performance.now();

      // Update VAD silence threshold for this turn (adaptive)
      turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;

      // Reset STT (opens new Deepgram connection for this turn).
      // feedSTT is attached right before collection (in each mode branch
      // below), NOT here — feeding 5-15s of pre-collection silence/noise to
      // Deepgram during the LLM+TTS phase makes it less responsive to short
      // agent utterances (Deepgram's endpointing eats sub-500ms speech as
      // noise after a long silence prefix). Empirically observed: agent
      // saying ~400ms "Yes, that's right" returned empty is_final.
      await transcriber.resetForNextTurn();
      const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);

      let sendTime: number;

      let callerAudio: Buffer | null = null;
      let callerDecision: CallerDecision | null;
      let llmMs: number = 0;
      let spokenCallerText: string | null = null;

      // ── Streaming LLM → TTS → channel pipeline ──────────────────────
      // LLM streams tokens and yields sentences via callback into a queue.
      // A concurrent consumer synthesizes each sentence via streaming TTS
      // and pipes audio chunks to the channel as they arrive.
      // For "wait"/"end_now" modes, no sentences are yielded so no audio is sent.
      const llmStart = performance.now();
      const callerAudioChunks: Buffer[] = [];

      // ── Pipecat-style streaming pipeline ──────────────────────────
      // 1. Set up TTS audio listener FIRST (captures audio as it arrives)
      // 2. Stream LLM tokens → detect sentences → sendText per sentence
      //    (Deepgram produces audio immediately per Speak message, no flush needed)
      // 3. Flush once at the end to process any remaining buffer
      const ttsStart = performance.now();

      // Start TTS stream — audio listener queues chunks for sequential sending
      const audioSendQueue: Buffer[] = [];
      const audioNotify = { fn: null as (() => void) | null };
      let ttsFinished = false;

      const ttsStream = ttsSession.startStreaming((chunk) => {
        callerAudioChunks.push(chunk);
        audioSendQueue.push(chunk);
        audioNotify.fn?.();
        audioNotify.fn = null;
      });

      // Concurrent audio sender — sends chunks sequentially as they arrive
      // Caught here: an unhandled rejection would crash the call process.
      const send = { error: null as unknown };
      const audioSendPromise = (async () => {
        while (true) {
          if (audioSendQueue.length > 0) {
            const chunk = audioSendQueue.shift()!;
            let audio = chunk;
            if (spec.caller_audio) audio = applyEffects(audio, spec.caller_audio);
            await channel.sendAudio(audio);
          } else if (ttsFinished) {
            break;
          } else {
            await new Promise<void>((r) => { audioNotify.fn = r; });
          }
        }
      })().catch((err: unknown) => { send.error = err; });

      // Stream LLM — each sentence is sent to Deepgram TTS as it's detected
      callerDecision = await caller.streamNextUtterance(
        agentText,
        (sentence) => ttsStream.sendText(prepareCallerSpeechText(sentence) + " "),
      );

      // Flush remaining TTS buffer and wait for all audio to arrive
      await ttsStream.finish();
      ttsFinished = true;
      audioNotify.fn?.();
      await audioSendPromise;
      // Hang-up while the caller was talking ends the call below; a send
      // failure on a live connection is a platform error.
      if (send.error && !channelDisconnected && channel.connected) {
        throw new PlatformError(send.error instanceof Error ? send.error.message : String(send.error));
      }

      // Flush the adapter's audio buffer (drain remaining frames + silence tail)
      await channel.flushAudioBuffer?.();
      ttsMs = Math.round(performance.now() - ttsStart);

      if (callerAudioChunks.length > 0) {
        callerAudio = concatPcm(callerAudioChunks);
      }

      const shouldStopAfterAgentReply = callerDecision?.mode === "closing";

      if (!callerDecision) {
        throw new Error("Vent's caller LLM returned an empty or unreadable response");
      }
      if (callerDecision.mode === "end_now") {
        break;
      }

      if (callerDecision.mode === "wait") {
        console.log(`[turn-decision] turn=${turn} caller=wait caller_llm=${llmMs}ms`);

        channel.on("audio", feedSTT);
        const vadStart = performance.now();
        const waitTurnWaitMs = resolveCollectionTimeoutMs(30000);
        const { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
          channel,
          {
            timeoutMs: waitTurnWaitMs,
            vad: turnVAD,
            preferPlatformEOT: !!channel.hasPlatformEndOfTurn,
            debugLabel: `turn-${turn}-wait`,
          }
        );
        const vadMs = Math.round(performance.now() - vadStart);
        console.log(
          `[turn-collect] turn=${turn} caller=wait bytes=${agentAudio.length} timedOut=${timedOut} ` +
          `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null} ` +
          `speechSegments=${stats.speechSegments} totalSpeechMs=${stats.totalSpeechMs}`
        );

        if (timedOut && stats.speechOnsetAt === null) {
          // After a closing turn, silence means the agent hung up — that's normal
          if (shouldStopAfterAgentReply) {
            channel.off("audio", feedSTT);
            console.log(`    [closing] Agent silent after caller goodbye — ending call normally`);
            break;
          }
          channel.off("audio", feedSTT);
          const diag = channel.getReceiveDiagnostics?.();
          if (diag) console.log(diag);
          endNote = `No agent speech for ${Math.round(waitTurnWaitMs / 1000)}s after the caller's turn; Vent hung up.`;
          break;
        }

        adaptiveThreshold.update(stats);

        const agentTimestamp = performance.now() - startTime;

        if (agentAudio.length > 0) {
          channel.off("audio", feedSTT);
          channel.startComfortNoise?.();
          const sttStart = performance.now();
          let { text, confidence } = await transcriber.finalize();
          const sttMs = Math.round(performance.now() - sttStart);
          const textSource = text ? "stt" : "empty";

          agentText = text;

          const totalPipelineMs = Math.round(performance.now() - turnPipelineStart);
          console.log(`[turn-timing] turn=${turn} caller=wait vad_collect=${vadMs}ms stt=${sttMs}ms total_pipeline=${totalPipelineMs}ms threshold=${adaptiveThreshold.thresholdMs}ms`);
          console.log(
            `[turn-text] turn=${turn} caller=wait source=${textSource} chars=${text?.length ?? 0} ` +
            `text="${summarizeDebugText(agentText)}"`
          );

          const agentAudioDurationMs = Math.round(
            (agentAudio.length / 2 / 24000) * 1000
          );
          const speechSegments = batchVAD.analyze(agentAudio);
          turnSignalQualities.push(analyzeAudioQuality(agentAudio, speechSegments));

          transcript.push({
            role: "agent",
            text: agentText,
            timestamp_ms: Math.round(agentTimestamp),
            caller_decision_mode: "wait",
            audio_duration_ms: agentAudioDurationMs,
            stt_confidence: confidence,
            stt_ms: sttMs,
          });
          if (shouldStopAfterAgentReply) break;
        } else {
          channel.off("audio", feedSTT);
          agentText = "";
          console.log(
            `[turn-text] turn=${turn} caller=wait source=empty-audio chars=0 timedOut=${timedOut} ` +
            `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null}`
          );
          transcript.push({
            role: "agent",
            text: "",
            timestamp_ms: Math.round(agentTimestamp),
            caller_decision_mode: "wait",
          });
          if (shouldStopAfterAgentReply) break;
        }
        continue;
      }

      // Audio was already sent to the channel during the streaming pipeline above.
      // Set up remaining state for this turn.
      callerText = callerDecision.text;
      spokenCallerText = prepareCallerSpeechText(callerText);
      const emittedCallerText = spokenCallerText ?? callerText;

      console.log(
        `    [caller] turn=${turn} decision=${callerDecision.mode} t=${sinceStartMs(startTime)}ms ` +
        `text="${summarizeDebugText(emittedCallerText)}"`
      );

      if (!callerAudio) {
        throw new Error(`Caller audio was not prepared for turn ${turn}`);
      }

      console.log(`[turn-timing] turn=${turn} caller_llm=${llmMs}ms tts=${ttsMs}ms`);

      if (channelDisconnected || !channel.connected) {
        endNote = connectionClosedNote;
        if (turn === 0 && collectGreetingFirst) {
          console.log(
            `    [opening-error] caller turn skipped because the channel disconnected before turn 0 send`
          );
        }
        break;
      }

      const callerTimestamp = performance.now() - startTime;
      const audioDurationMs = Math.round((callerAudio.length / 2 / 24000) * 1000);

      transcript.push({
        role: "caller",
        text: emittedCallerText,
        timestamp_ms: Math.round(callerTimestamp),
        caller_decision_mode: callerDecision.mode,
        audio_duration_ms: audioDurationMs,
        tts_ms: ttsMs,
      });

      sendTime = Date.now();
      console.log(
        `    [caller-send] turn=${turn} t=${sinceStartMs(startTime)}ms ` +
        `audioDuration=${audioDurationMs}ms bytes=${callerAudio.length}`
      );

      // Attach STT feed — agent response audio starts arriving after caller sends.
      channel.on("audio", feedSTT);

      // Step 3: Collect agent response via VAD (reused instance)
      // 30s timeout: LiveKit sendAudio is fire-and-forget with real-time pacing,
      // so frames take seconds to deliver. The agent also needs processing time
      // (STT → LLM → TTS) before responding.
      const vadStart = performance.now();
      const replyWaitMs = resolveCollectionTimeoutMs(30000);
      let { audio: agentAudio, stats, timedOut } = await collectUntilEndOfTurn(
        channel,
        {
          timeoutMs: replyWaitMs,
          vad: turnVAD,
          preferPlatformEOT: !!channel.hasPlatformEndOfTurn,
          debugLabel: `turn-${turn}`,
        }
      );
      const vadMs = Math.round(performance.now() - vadStart);
      console.log(
        `[turn-collect] turn=${turn} bytes=${agentAudio.length} timedOut=${timedOut} ` +
        `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null} ` +
        `speechSegments=${stats.speechSegments} totalSpeechMs=${stats.totalSpeechMs}`
      );



      // Fail fast: if no speech detected within timeout, agent has stopped responding
      if (timedOut && stats.speechOnsetAt === null) {
        channel.off("audio", feedSTT);
        const diag = channel.getReceiveDiagnostics?.();
        if (diag) console.log(diag);
        endNote = `No agent speech for ${Math.round(replyWaitMs / 1000)}s after the caller's turn; Vent hung up.`;
        break;
      }

      // Adapt threshold for next turn based on this turn's response cadence
      adaptiveThreshold.update(stats);

      let agentTimestamp = performance.now() - startTime;

      // Measure TTFB (first audio byte) and TTFW (first speech via VAD)
      let turnTtfb: number | undefined;
      let turnTtfw: number | undefined;
      let turnSilencePad: number | undefined;
      if (agentAudio.length > 0 && stats.firstChunkAt !== null) {
        turnTtfb = Math.max(0, stats.firstChunkAt - sendTime);
        ttfbValues.push(turnTtfb);

        if (stats.speechOnsetAt !== null) {
          turnTtfw = Math.max(0, stats.speechOnsetAt - sendTime);
          ttfwValues.push(turnTtfw);
          turnSilencePad = Math.max(0, turnTtfw - turnTtfb);
        }
      }

      // Step 4: Get streaming STT result + batch VAD analysis
      if (agentAudio.length > 0) {
        channel.off("audio", feedSTT);
        // Keep the codec warm during LLM+TTS processing to prevent
        // the agent from detecting silence and saying "are you still there?"
        channel.startComfortNoise?.();
        const sttStart = performance.now();
        let { text, confidence } = await transcriber.finalize();
        let sttMs = Math.round(performance.now() - sttStart);
        const textSource = text ? "stt" : "empty";

        agentText = text;

        // ── Filler speech detection (platform EOT adapters only) ──────────
        // When the agent says filler ("Let me check that") before a tool call,
        // Retell fires agent_stop_talking and we resolve the turn. But the real
        // answer hasn't arrived yet. Detect filler via a fast Haiku call, then
        // collect the continuation segment and merge into one logical turn.
        const agentWordCount = agentText ? agentText.trim().split(/\s+/).length : 0;
        if (channel.hasPlatformEndOfTurn && agentText && agentWordCount > 0 && agentWordCount <= 12) {
          const fillerClassification = await caller.classifyAgentSpeech(agentText);

          if (fillerClassification === "filler") {
            console.log(
              `[filler-continuation] turn=${turn} detected filler="${summarizeDebugText(agentText)}" — collecting continuation`
            );

            const fillerAudio = agentAudio;

            await transcriber.resetForNextTurn();
            const feedContinuationSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);
            channel.on("audio", feedContinuationSTT);

            turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;
            const continuation = await collectUntilEndOfTurn(channel, {
              timeoutMs: resolveCollectionTimeoutMs(30000),
              vad: turnVAD,
              preferPlatformEOT: true,
              debugLabel: `turn-${turn}-continuation`,
            });
            channel.off("audio", feedContinuationSTT);

            if (continuation.audio.length > 0 && continuation.stats.speechOnsetAt !== null) {
              const contSttStart = performance.now();
              const contResult = await transcriber.finalize();
              const contSttMs = Math.round(performance.now() - contSttStart);

              agentAudio = concatPcm([fillerAudio, continuation.audio]);
              agentText = agentText + " " + (contResult.text || "");
              sttMs += contSttMs;
              confidence = contResult.confidence;

              adaptiveThreshold.update(continuation.stats);
              agentTimestamp = performance.now() - startTime;

              console.log(
                `[filler-continuation] turn=${turn} merged text="${summarizeDebugText(agentText)}" ` +
                `continuation_bytes=${continuation.audio.length}`
              );
            } else {
              console.log(
                `[filler-continuation] turn=${turn} no continuation speech — using filler as-is`
              );
            }
          }
        }

        const totalPipelineMs = Math.round(performance.now() - turnPipelineStart);
        console.log(`[turn-timing] turn=${turn} vad_collect=${vadMs}ms stt=${sttMs}ms total_pipeline=${totalPipelineMs}ms threshold=${adaptiveThreshold.thresholdMs}ms`);
        console.log(
          `[turn-text] turn=${turn} source=${textSource} chars=${text?.length ?? 0} ` +
          `text="${summarizeDebugText(agentText)}"`
        );

        const agentAudioDurationMs = Math.round(
          (agentAudio.length / 2 / 24000) * 1000
        );

        // Batch VAD on agent audio for speech/silence segmentation
        const speechSegments = batchVAD.analyze(agentAudio);
        // Signal quality analysis on raw audio buffer
        turnSignalQualities.push(analyzeAudioQuality(agentAudio, speechSegments));

        transcript.push({
          role: "agent",
          text: agentText,
          timestamp_ms: Math.round(agentTimestamp),
          audio_duration_ms: agentAudioDurationMs,
          ttfb_ms: turnTtfb,
          ttfw_ms: turnTtfw,
          silence_pad_ms: turnSilencePad,
          stt_confidence: confidence,
          stt_ms: sttMs,
        });
        if (shouldStopAfterAgentReply) break;
      } else {
        channel.off("audio", feedSTT);
        agentText = "";
        console.log(
          `[turn-text] turn=${turn} source=empty-audio chars=0 timedOut=${timedOut} ` +
          `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null}`
        );
        transcript.push({
          role: "agent",
          text: "",
          timestamp_ms: Math.round(agentTimestamp),
          ttfb_ms: turnTtfb,
          ttfw_ms: turnTtfw,
          silence_pad_ms: turnSilencePad,
        });
        if (shouldStopAfterAgentReply) break;
      }
    }

    return await buildResult("completed");
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(`    [executor] aborted mid-conversation: ${raw}`);
    // Inside the conversation, only PlatformError comes from the agent's side.
    const errorMsg = err instanceof PlatformError || raw.startsWith(VENT_FAILED) ? raw : VENT_FAILED + raw;
    return await buildResult("error", errorMsg);
  } finally {
    // Each cleanup is wrapped in its own try/catch — a throw in any one
    // would otherwise propagate out of the finally and overwrite the
    // result returned from the try/catch above (or the original thrown
    // error), making debugging real failures impossible.
    try { await safeDisconnect(); } catch (e) {
      console.warn(`    [executor cleanup] safeDisconnect failed: ${(e as Error).message}`);
    }
    try { await ttsSession.close(); } catch (e) {
      console.warn(`    [executor cleanup] ttsSession.close failed: ${(e as Error).message}`);
    }
    try { transcriber.close(); } catch (e) {
      console.warn(`    [executor cleanup] transcriber.close failed: ${(e as Error).message}`);
    }
    try { turnVAD.destroy(); } catch (e) {
      console.warn(`    [executor cleanup] turnVAD.destroy failed: ${(e as Error).message}`);
    }
    try { batchVAD.destroy(); } catch (e) {
      console.warn(`    [executor cleanup] batchVAD.destroy failed: ${(e as Error).message}`);
    }
  }
}
