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
import { buildPlatformTranscript } from "./platform-transcript.js";
import {
  concatPcm,
  SAMPLE_RATE,
  type ConversationCallSpec,
  type ConversationCallResult,
  type ConversationTurn,
  type ConversationMetrics,
  type ObservedToolCall,
  summarizeComponentLatency,
} from "@vent/shared";
import { TTSSession, VoiceActivityDetector, StreamingTranscriber, applyEffects, resolveAccentVoiceId, resolveLanguageVoiceId, resolveGenderVoiceId, analyzeAudioQuality, type AudioQualityMetrics } from "@vent/voice";
import { CallerLLM } from "./caller-llm.js";
import { collectUntilEndOfTurn, turnTiming } from "./turn-taking.js";
import { AdaptiveThreshold } from "./adaptive-threshold.js";
import { matchToolCallsToTurns } from "../metrics/tool-calls.js";
import { summarizeSignalQuality } from "../metrics/signal-quality.js";

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

function pcmDurationMs(pcm: Buffer): number {
  return Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
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

  const language = spec.language;
  const caller = new CallerLLM(spec.caller_prompt, spec.persona, language);
  const adaptiveThreshold = new AdaptiveThreshold(turnTiming(!!channel.hasPlatformEndOfTurn).silenceThresholdMs);

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
  const transcriber = new StreamingTranscriber(language);
  // Persistent TTS session — one WebSocket for all turns (avoids REST rate limit)
  const ttsSession = new TTSSession(ttsOpts);

  await Promise.all([
    turnVAD.init(),
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
  // With no agent greeting to collect, each turn attaches its own STT feed.
  if (!collectGreetingFirst) channel.off("audio", openingFeedSTT);
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

  /** Collect the agent's turn with the current adaptive threshold. The STT
   *  feed is attached by the caller. */
  const collectAgentTurn = async (debugLabel: string) => {
    const timeoutMs = resolveCollectionTimeoutMs(30000);
    turnVAD.silenceThresholdMs = adaptiveThreshold.thresholdMs;
    const collectStart = performance.now();
    const collected = await collectUntilEndOfTurn(channel, { timeoutMs, vad: turnVAD, debugLabel });
    return { ...collected, timeoutMs, collectMs: Math.round(performance.now() - collectStart) };
  };

  /** Read back the transcript of the agent audio fed to STT, timing the wait. */
  const finalizeTranscript = async () => {
    const sttStart = performance.now();
    const { text, confidence } = await transcriber.finalize();
    return { text, confidence, sttMs: Math.round(performance.now() - sttStart) };
  };

  /** Record an agent turn. Duration and signal quality come from its audio, when there is any. */
  const pushAgentTurn = (
    audio: Buffer,
    text: string,
    timestampMs: number,
    fields: Omit<ConversationTurn, "role" | "text" | "timestamp_ms" | "audio_duration_ms">,
  ) => {
    agentText = text;
    if (audio.length > 0) turnSignalQualities.push(analyzeAudioQuality(audio));
    transcript.push({
      role: "agent",
      text,
      timestamp_ms: Math.round(timestampMs),
      ...(audio.length > 0 ? { audio_duration_ms: pcmDurationMs(audio) } : {}),
      ...fields,
    });
  };

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
      safe(() => matchToolCallsToTurns(observedToolCalls, transcript), undefined, "matchToolCallsToTurns");
    }

    const callMetadata = await safeAsync(
      () => channel.getCallMetadata?.() ?? Promise.resolve(null),
      null,
      "getCallMetadata",
    ) ?? null;
    if (callMetadata) {
      console.log(`    Call metadata: ended_reason=${callMetadata.ended_reason ?? "unknown"}, cost=$${callMetadata.cost?.total_usd.toFixed(4) ?? "n/a"}`);
    }

    // Component timings reported by the platform; the result shows their means.
    const componentTimings = safe(() => {
      const timings = channel.getComponentTimings?.() ?? [];
      const summary = summarizeComponentLatency(timings);
      if (summary) {
        console.log(`    Component latency: STT=${summary.mean_stt_ms ?? "?"}ms LLM=${summary.mean_llm_ms ?? "?"}ms TTS=${summary.mean_tts_ms ?? "?"}ms`);
      }
      return timings;
    }, [], "componentLatency");

    const platformTranscript = safe(() => buildPlatformTranscript(channel.getTranscripts?.() ?? []), [], "platformTranscript");

    // Only what the turns can't reproduce; summaries are computed when formatting.
    const metrics: ConversationMetrics = {
      ...(channel.stats.connectLatencyMs > 0 ? { connect_latency_ms: channel.stats.connectLatencyMs } : {}),
      signal_quality: safe(() => summarizeSignalQuality(turnSignalQualities), undefined, "signalQuality"),
      ...(componentTimings.length > 0 ? { component_latency: { per_turn: componentTimings } } : {}),
    };

    return {
      name: spec.name,
      caller_prompt: spec.caller_prompt,
      status: finalStatus,
      ...(finalError != null ? { error: finalError } : {}),
      ...(finalStatus === "completed" && endNote ? { end_note: endNote } : {}),
      transcript,
      ...(platformTranscript.length > 0 ? { platform_transcript: platformTranscript } : {}),
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
        // No resetForNextTurn or feedSTT attach here — transcriber is already
        // connected and openingFeedSTT is already attached at call setup so the
        // opening's first audio chunks aren't lost to an unattached listener.
        console.log(`    [opening] collect_start t=${sinceStartMs(startTime)}ms`);
        const { audio: greetingAudio, stats, timedOut, timeoutMs, collectMs } = await collectAgentTurn("opening");
        console.log(
          `    [opening] collect_end t=${sinceStartMs(startTime)}ms bytes=${greetingAudio.length} ` +
          `timedOut=${timedOut} speechOnset=${stats.speechOnsetAt !== null}`
        );

        if (timedOut && stats.speechOnsetAt === null) {
          endNote = `The agent connected but said nothing for ${Math.round(timeoutMs / 1000)}s; Vent hung up.`;
          break;
        }

        let greeting = { text: "", sttMs: 0 };
        if (stats.speechOnsetAt !== null && greetingAudio.length > 4800) {
          greeting = await finalizeTranscript();
        }
        // Release the call-level STT listener now that the opening is done.
        // Subsequent turns manage their own feedSTT attach/detach around
        // collection to avoid feeding Deepgram during caller-LLM/TTS idle
        // audio (which slows CloseStream).
        channel.off("audio", openingFeedSTT);

        if (greeting.text) {
          console.log(`    Agent greeting: "${greeting.text.slice(0, 80)}..."`);
          console.log(`[turn-timing] greeting vad_collect=${collectMs}ms stt=${greeting.sttMs}ms`);
          console.log(`    [opening] resolved t=${sinceStartMs(startTime)}ms`);
          pushAgentTurn(greetingAudio, greeting.text, performance.now() - startTime, { stt_ms: greeting.sttMs });
        }

        adaptiveThreshold.update(stats);
        continue;
      }

      // ── Caller turn: caller LLM → streaming TTS → channel ──────────
      const turnPipelineStart = performance.now();

      // Reset STT (opens new Deepgram connection for this turn).
      // feedSTT is attached right before collection, NOT here — feeding
      // 5-15s of pre-collection silence/noise to Deepgram during the LLM+TTS
      // phase makes it less responsive to short agent utterances (Deepgram's
      // endpointing eats sub-500ms speech as noise after a long silence
      // prefix). Empirically observed: agent saying ~400ms "Yes, that's
      // right" returned empty is_final.
      await transcriber.resetForNextTurn();
      const feedSTT = (chunk: Buffer) => transcriber.feedAudio(chunk);

      // The LLM streams tokens; each detected sentence goes to Deepgram TTS
      // right away, and TTS audio is sent to the channel, in order, as it
      // arrives. Each send is awaited before the next. After a failed send
      // nothing more is sent; the error is raised once the utterance is done.
      // For "wait"/"end_now" no sentences are produced, so no audio is sent.
      const callerAudioChunks: Buffer[] = [];
      const timing = { firstSentenceAt: null as number | null, firstAudioAt: null as number | null };
      let sending = Promise.resolve();
      let sendError = null as { cause: unknown } | null;
      const ttsStream = ttsSession.startStreaming((chunk) => {
        timing.firstAudioAt ??= performance.now();
        callerAudioChunks.push(chunk);
        sending = sending.then(async () => {
          if (sendError) return;
          try {
            await channel.sendAudio(spec.caller_audio ? applyEffects(chunk, spec.caller_audio) : chunk);
          } catch (cause) {
            sendError = { cause };
          }
        });
      });

      const llmStart = performance.now();
      const callerDecision = await caller.streamNextUtterance(agentText, (sentence) => {
        timing.firstSentenceAt ??= performance.now();
        ttsStream.sendText(prepareCallerSpeechText(sentence) + " ");
      });
      // Caller LLM time until it had something to say (or decided not to speak).
      const llmMs = Math.round((timing.firstSentenceAt ?? performance.now()) - llmStart);

      // Flush remaining TTS buffer, then wait for all audio to be sent.
      await ttsStream.finish();
      await sending;
      // Caller TTS time: first sentence handed to Deepgram → its first audio.
      // Measured after finish(): the first audio can arrive after the LLM is done.
      const ttsMs = timing.firstSentenceAt !== null && timing.firstAudioAt !== null
        ? Math.round(timing.firstAudioAt - timing.firstSentenceAt)
        : undefined;
      // Hang-up while the caller was talking ends the call below; a send
      // failure on a live connection is a platform error.
      if (sendError && !channelDisconnected && channel.connected) {
        const { cause } = sendError;
        throw new PlatformError(cause instanceof Error ? cause.message : String(cause));
      }

      // Flush the adapter's audio buffer (drain remaining frames + silence tail)
      await channel.flushAudioBuffer?.();

      const callerAudio = callerAudioChunks.length > 0 ? concatPcm(callerAudioChunks) : null;
      const shouldStopAfterAgentReply = callerDecision?.mode === "closing";

      if (!callerDecision) {
        throw new Error("Vent's caller LLM returned an empty or unreadable response");
      }
      if (callerDecision.mode === "end_now") {
        break;
      }

      // "wait": the caller stays silent and lets the agent keep talking.
      const waiting = callerDecision.mode === "wait";
      const logTag = waiting ? " caller=wait" : "";
      let sendTime: number | null = null;
      if (waiting) {
        console.log(`[turn-decision] turn=${turn} caller=wait caller_llm=${llmMs}ms`);
      } else {
        // Audio was already sent to the channel during the streaming pipeline above.
        const callerText = prepareCallerSpeechText(callerDecision.text);
        console.log(
          `    [caller] turn=${turn} decision=${callerDecision.mode} t=${sinceStartMs(startTime)}ms ` +
          `text="${summarizeDebugText(callerText)}"`
        );

        if (!callerAudio) {
          throw new Error(`Caller audio was not prepared for turn ${turn}`);
        }

        console.log(`[turn-timing] turn=${turn} caller_llm=${llmMs}ms tts=${ttsMs ?? "?"}ms`);

        if (channelDisconnected || !channel.connected) {
          endNote = connectionClosedNote;
          if (turn === 0 && collectGreetingFirst) {
            console.log(
              `    [opening-error] caller turn skipped because the channel disconnected before turn 0 send`
            );
          }
          break;
        }

        const audioDurationMs = pcmDurationMs(callerAudio);
        transcript.push({
          role: "caller",
          text: callerText,
          timestamp_ms: Math.round(performance.now() - startTime),
          caller_decision_mode: callerDecision.mode,
          audio_duration_ms: audioDurationMs,
          tts_ms: ttsMs,
        });

        sendTime = Date.now();
        console.log(
          `    [caller-send] turn=${turn} t=${sinceStartMs(startTime)}ms ` +
          `audioDuration=${audioDurationMs}ms bytes=${callerAudio.length}`
        );
      }

      // ── Agent turn ──────────────────────────────────────────────────
      // 30s timeout: LiveKit sendAudio is fire-and-forget with real-time pacing,
      // so frames take seconds to deliver. The agent also needs processing time
      // (STT → LLM → TTS) before responding.
      channel.on("audio", feedSTT);
      const { audio: collectedAudio, stats, timedOut, timeoutMs, collectMs } =
        await collectAgentTurn(waiting ? `turn-${turn}-wait` : `turn-${turn}`);
      channel.off("audio", feedSTT);
      let agentAudio = collectedAudio;
      console.log(
        `[turn-collect] turn=${turn}${logTag} bytes=${agentAudio.length} timedOut=${timedOut} ` +
        `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null} ` +
        `speechSegments=${stats.speechSegments} totalSpeechMs=${stats.totalSpeechMs}`
      );

      // Fail fast: if no speech detected within timeout, agent has stopped responding
      if (timedOut && stats.speechOnsetAt === null) {
        const diag = channel.getReceiveDiagnostics?.();
        if (diag) console.log(diag);
        endNote = `No agent speech for ${Math.round(timeoutMs / 1000)}s after the caller's turn; Vent hung up.`;
        break;
      }

      // Adapt threshold for next turn based on this turn's response cadence
      adaptiveThreshold.update(stats);

      let agentTimestamp = performance.now() - startTime;

      // Response latency, for replies: TTFB (first audio byte) and TTFW (first speech via VAD)
      const latencyFields: Pick<ConversationTurn, "caller_decision_mode" | "ttfb_ms" | "ttfw_ms" | "silence_pad_ms"> =
        waiting ? { caller_decision_mode: "wait" } : {};
      if (sendTime !== null && agentAudio.length > 0 && stats.firstChunkAt !== null) {
        const ttfb = Math.max(0, stats.firstChunkAt - sendTime);
        latencyFields.ttfb_ms = ttfb;
        if (stats.speechOnsetAt !== null) {
          const ttfw = Math.max(0, stats.speechOnsetAt - sendTime);
          latencyFields.ttfw_ms = ttfw;
          latencyFields.silence_pad_ms = Math.max(0, ttfw - ttfb);
        }
      }

      if (agentAudio.length === 0) {
        console.log(
          `[turn-text] turn=${turn}${logTag} source=empty-audio chars=0 timedOut=${timedOut} ` +
          `firstChunk=${stats.firstChunkAt !== null} speechOnset=${stats.speechOnsetAt !== null}`
        );
        pushAgentTurn(agentAudio, "", agentTimestamp, latencyFields);
        if (shouldStopAfterAgentReply) break;
        continue;
      }

      // Keep the codec warm during LLM+TTS processing to prevent
      // the agent from detecting silence and saying "are you still there?"
      channel.startComfortNoise?.();
      const { text, confidence: firstConfidence, sttMs: firstSttMs } = await finalizeTranscript();
      let turnText = text;
      let confidence = firstConfidence;
      let sttMs = firstSttMs;

      // ── Filler speech detection (platform EOT adapters, replies only) ──
      // When the agent says filler ("Let me check that") before a tool call,
      // the platform reports end of turn and we resolve it. But the real
      // answer hasn't arrived yet. Detect filler via a fast Haiku call, then
      // collect the continuation segment and merge into one logical turn.
      const agentWordCount = turnText ? turnText.trim().split(/\s+/).length : 0;
      if (!waiting && channel.hasPlatformEndOfTurn && turnText && agentWordCount > 0 && agentWordCount <= 12) {
        const fillerClassification = await caller.classifyAgentSpeech(turnText);

        if (fillerClassification === "filler") {
          console.log(
            `[filler-continuation] turn=${turn} detected filler="${summarizeDebugText(turnText)}" — collecting continuation`
          );

          await transcriber.resetForNextTurn();
          channel.on("audio", feedSTT);
          const continuation = await collectAgentTurn(`turn-${turn}-continuation`);
          channel.off("audio", feedSTT);

          if (continuation.audio.length > 0 && continuation.stats.speechOnsetAt !== null) {
            const contResult = await finalizeTranscript();

            agentAudio = concatPcm([agentAudio, continuation.audio]);
            turnText = turnText + " " + (contResult.text || "");
            sttMs += contResult.sttMs;
            confidence = contResult.confidence;

            adaptiveThreshold.update(continuation.stats);
            agentTimestamp = performance.now() - startTime;

            console.log(
              `[filler-continuation] turn=${turn} merged text="${summarizeDebugText(turnText)}" ` +
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
      console.log(`[turn-timing] turn=${turn}${logTag} vad_collect=${collectMs}ms stt=${sttMs}ms total_pipeline=${totalPipelineMs}ms threshold=${adaptiveThreshold.thresholdMs}ms`);
      console.log(
        `[turn-text] turn=${turn}${logTag} source=${text ? "stt" : "empty"} chars=${text.length} ` +
        `text="${summarizeDebugText(turnText)}"`
      );

      pushAgentTurn(agentAudio, turnText, agentTimestamp, {
        ...latencyFields,
        stt_confidence: confidence,
        stt_ms: sttMs,
      });
      if (shouldStopAfterAgentReply) break;
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
    const cleanups: [string, () => unknown][] = [
      ["safeDisconnect", safeDisconnect],
      ["ttsSession.close", () => ttsSession.close()],
      ["transcriber.close", () => transcriber.close()],
      ["turnVAD.destroy", () => turnVAD.destroy()],
    ];
    for (const [label, cleanup] of cleanups) {
      try { await cleanup(); } catch (e) {
        console.warn(`    [executor cleanup] ${label} failed: ${(e as Error).message}`);
      }
    }
  }
}
