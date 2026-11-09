/**
 * Single call execution — runs one conversation call against a voice agent.
 * Audio quality analysis and latency drift are integrated
 * into the call (no standalone infrastructure probes).
 */

import { randomUUID } from "node:crypto";
import type {
  ConversationCallSpec,
  ConversationCallResult,
  RunAggregateV2,
} from "@vent/shared";
import { requireEnv } from "@vent/shared";
import { buildArtifactUrl, createArtifactToken, createStorageClient } from "@vent/artifacts";
import { createAudioChannel, type AudioChannel, type AudioChannelConfig } from "@vent/adapters";
import { runConversationCall } from "./conversation/index.js";

export interface CallStartInfo {
  call_name: string;
}

export interface ExecuteCallOpts {
  callSpec: ConversationCallSpec;
  channelConfig: AudioChannelConfig;
  runId?: string;
  /** Owning user — embedded in the recording artifact token so the API can
   *  enforce that only the owner (not anyone with a leaked URL) can fetch it. */
  userId?: string;
  onCallStart?: (info: CallStartInfo) => void;
  onCallComplete?: (result: ConversationCallResult) => void | Promise<void>;
  /** External cancel signal — when fired, the call aborts at the next turn
   *  boundary, partial transcript is preserved, and the channel is hung up. */
  signal?: AbortSignal;
}

export interface ExecuteCallResult {
  status: "pass" | "fail";
  conversationResult: ConversationCallResult;
  aggregate: RunAggregateV2;
}

interface ActiveRecordingUpload {
  finalize(): Promise<string | null>;
  abort(): Promise<void>;
}

let storageClient:
  | ReturnType<typeof createStorageClient>
  | null
  | undefined;

function getStorageClient() {
  if (storageClient !== undefined) return storageClient;
  try {
    storageClient = createStorageClient();
  } catch {
    storageClient = null;
  }
  return storageClient;
}

function getRequiredStorageClient() {
  const storage = getStorageClient();
  if (!storage) {
    throw new Error("Vent-owned recording requires object storage configuration");
  }
  return storage;
}

function slugifyRecordingLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "call";
}

async function attachRecordingUrl(
  result: ConversationCallResult,
  channel: AudioChannel,
  adapter: AudioChannelConfig["adapter"],
  activeUpload: ActiveRecordingUpload | null,
  runId?: string,
): Promise<void> {
  if (!runId) {
    await activeUpload?.abort().catch(() => {});
    await channel.discardCallRecording?.().catch(() => {});
    return;
  }

  console.log(`[recording] activeUpload=${!!activeUpload} runId=${runId}`);
  if (activeUpload) {
    try {
      const recordingUrl = await activeUpload.finalize();
      console.log(`[recording] live finalize result: ${recordingUrl ? "got URL" : "null"}`);
      if (recordingUrl) {
        result.call_metadata = {
          platform: result.call_metadata?.platform ?? adapter,
          ...(result.call_metadata ?? {}),
          recording_url: recordingUrl,
        };
      } else {
        // Upload finalized but produced no URL (zero bytes captured, or
        // multipart abort during cleanup). Log loudly so an operator can
        // correlate "missing recording" with this run in worker logs.
        console.warn(`[recording] FINALIZED_BUT_NO_URL run=${runId} — upload produced no URL (zero bytes or aborted)`);
      }
    } catch (err) {
      console.warn(`[recording] UPLOAD_FAILED run=${runId} error=${(err as Error).message}`);
    } finally {
      await channel.discardCallRecording?.().catch(() => {});
    }
    return;
  }

  console.warn("[recording] attachRecordingUrl failed: Vent-owned recording upload was not initialized");
  await channel.discardCallRecording?.().catch(() => {});
}

function buildRecordingUrl(
  key: string,
  storage: NonNullable<ReturnType<typeof createStorageClient>>,
  userId: string | undefined,
): Promise<string> | string {
  // Signed-URL-only auth (S3/Twilio pattern). The HMAC token is the credential;
  // 1h TTL bounds blast radius. No dashboard sign-in required.
  const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  if (secret) {
    const apiBaseUrl = requireEnv("API_PUBLIC_URL");
    // userId is captured in the token payload for audit logging only — it's
    // not enforced on access. May be undefined in dev / standalone runner.
    return buildArtifactUrl(apiBaseUrl, createArtifactToken(key, secret, { userId: userId ?? "anon" }));
  }
  return storage.presignDownload(key, 3600);
}

async function startRecordingUpload(
  channel: AudioChannel,
  resultName: string | undefined,
  callerPrompt: string,
  runId?: string,
  userId?: string,
): Promise<ActiveRecordingUpload | null> {
  if (!runId) {
    console.log("[recording] startRecordingUpload: no runId");
    return null;
  }

  const liveRecording = channel.getLiveCallRecording?.();
  if (!liveRecording) {
    throw new Error("Vent-owned recording stream is unavailable");
  }

  const storage = getRequiredStorageClient();
  const baseName = slugifyRecordingLabel(resultName ?? callerPrompt.slice(0, 48));
  const key = `recordings/${runId}/${baseName}-${randomUUID()}.wav`;
  const recordingUrl = await buildRecordingUrl(key, storage, userId);
  const multipart = await storage.createWavMultipartUpload(key);
  let aborted = false;

  const uploadPromise = (async () => {
    try {
      for await (const chunk of liveRecording.pcm) {
        await multipart.appendPcm(chunk);
      }
      if (aborted) return null;
      const totalBytes = await multipart.complete();
      return totalBytes > 0 ? recordingUrl : null;
    } catch (err) {
      if (aborted) return null;
      await multipart.abort().catch(() => {});
      throw err;
    }
  })();

  let settled = false;

  return {
    finalize: async () => {
      if (settled) return uploadPromise;
      settled = true;
      await liveRecording.finalize();
      const result = await uploadPromise;
      await liveRecording.cleanup().catch(() => {});
      return result;
    },
    abort: async () => {
      if (settled) return;
      settled = true;
      aborted = true;
      await liveRecording.abort().catch(() => {});
      await multipart.abort().catch(() => {});
      await uploadPromise.catch(() => {});
      await liveRecording.cleanup().catch(() => {});
    },
  };
}

export async function executeCall(opts: ExecuteCallOpts): Promise<ExecuteCallResult> {
  const {
    callSpec: spec,
    channelConfig,
    runId,
    userId,
    onCallStart,
    onCallComplete,
    signal,
  } = opts;

  const notifyCallComplete = async (result: ConversationCallResult) => {
    if (!onCallComplete) return;
    try {
      await onCallComplete(result);
    } catch (err) {
      console.warn(`onCallComplete failed: ${(err as Error).message}`);
    }
  };

  // Pre-flight health check — only for relay/local agent runs.
  // Platform adapters (vapi, retell, elevenlabs, bland) don't need this —
  // it would waste a real API call + credits just to verify connectivity.
  // The first real call will fail with a clear error if config is wrong.
  const isPlatformAdapter = ["vapi", "retell", "elevenlabs", "bland", "livekit"].includes(channelConfig.adapter);
  if (!isPlatformAdapter) {
    const probeChannel = await createAudioChannel(channelConfig);
    try {
      await probeChannel.connect();
      // Hold open to verify end-to-end — if the CLI can't reach the agent,
      // the API closes this WS within ~1s (close message or buffer limit).
      await new Promise<void>((resolve, reject) => {
        const ok = setTimeout(() => {
          probeChannel.off("disconnected", onDisconnect);
          resolve();
        }, 2_000);
        function onDisconnect() {
          clearTimeout(ok);
          reject(new Error("Relay probe disconnected — CLI cannot reach local agent"));
        }
        if (!probeChannel.connected) {
          clearTimeout(ok);
          reject(new Error("Relay probe closed immediately — CLI cannot reach local agent"));
          return;
        }
        probeChannel.on("disconnected", onDisconnect);
      });
      await probeChannel.disconnect().catch(() => {});
      console.log("Pre-flight health check passed — agent is reachable.");
    } catch (err) {
      await probeChannel.disconnect().catch(() => {});
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Pre-flight health check failed: ${errorMsg}`);
      const failResult: ConversationCallResult = {
        name: "health_check",
        caller_prompt: "Pre-flight connectivity check",
        status: "error",
        transcript: [],
        duration_ms: 0,
        metrics: { mean_ttfb_ms: 0 },
        error: `Agent unreachable: ${errorMsg}`,
      };
      await notifyCallComplete(failResult);
      return {
        status: "fail",
        conversationResult: failResult,
        aggregate: {
          conversation_calls: { total: 1, passed: 0, failed: 1 },
          total_duration_ms: 0,
        },
      };
    }
  }

  // Execute the single call
  const callName = spec.name ?? `conversation:${spec.caller_prompt.slice(0, 50)}`;
  onCallStart?.({ call_name: callName });
  console.log(`  Conversation: ${spec.caller_prompt.slice(0, 60)}...`);

  const perCallChannelConfig: AudioChannelConfig = {
    ...channelConfig,
    runId,
    callName,
  };
  const channel = await createAudioChannel(perCallChannelConfig);
  const start = Date.now();

  let result: ConversationCallResult;
  let recordingUpload: ActiveRecordingUpload | null = null;

  try {
    // Defer channel.connect() into runConversationCall so the STT listener
    // is attached BEFORE the transport starts emitting audio. Without this,
    // the first ~500ms of the agent's greeting flows to zero listeners and
    // gets dropped — Deepgram only sees audio starting mid-sentence.
    const callResult = await runConversationCall(spec, channel, {
      onConnected: async () => {
        recordingUpload = await startRecordingUpload(channel, spec.name, spec.caller_prompt, runId, userId);
      },
      signal,
    });
    result = callResult;
    await attachRecordingUrl(result, channel, perCallChannelConfig.adapter, recordingUpload, runId);
    console.log(`    Status: ${result.status} (${result.duration_ms}ms)`);
    console.log(JSON.stringify({
      event: "call_complete", call_name: callName,
      status: result.status, duration_ms: result.duration_ms,
      channel: { bytes_sent: channel.stats.bytesSent, bytes_received: channel.stats.bytesReceived, errors: channel.stats.errorEvents },
    }));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`    ${callName}: error — ${errorMsg}`);

    const observedToolCalls = await channel.getCallData?.().catch(() => []) ?? [];
    const callMetadata = await channel.getCallMetadata?.().catch(() => null) ?? null;

    // Salvage whatever transcript the channel captured before the throw —
    // returning [] discards real diagnostic data when the failure was late
    // in the call (e.g. mid-conversation timeout). channel.getTranscripts()
    // returns CALLER-only text across all five adapters (verified) — these
    // are the user/caller-side utterances the platform's own STT captured.
    // Don't fabricate alternating agent turns; we don't have the agent text
    // here, only what the user said.
    const platformTranscript =
      (channel.getTranscripts ? channel.getTranscripts() : []) ?? [];
    const salvagedTranscript = platformTranscript.map((t) => ({
      role: "caller" as const,
      text: t.text,
      timestamp_ms: 0,
    }));

    result = {
      name: spec.name,
      caller_prompt: spec.caller_prompt,
      status: "error",
      transcript: salvagedTranscript,
      duration_ms: Date.now() - start,
      metrics: { mean_ttfb_ms: 0 },
      error: errorMsg,
      observed_tool_calls: observedToolCalls.length > 0 ? observedToolCalls : undefined,
      call_metadata: callMetadata ?? undefined,
    };
    await attachRecordingUrl(result, channel, perCallChannelConfig.adapter, recordingUpload, runId);
    console.log(JSON.stringify({
      event: "call_complete", call_name: callName,
      status: "error", duration_ms: result.duration_ms, error: errorMsg,
    }));
  } finally {
    await channel.disconnect().catch(() => {});
  }

  await notifyCallComplete(result);

  const passed = result.status === "completed" ? 1 : 0;
  const failed = result.status === "error" ? 1 : 0;
  const costUsd = result.call_metadata?.cost_usd;

  const aggregate: RunAggregateV2 = {
    conversation_calls: { total: 1, passed, failed },
    total_duration_ms: result.duration_ms,
    ...(costUsd != null && costUsd > 0 ? { total_cost_usd: costUsd } : {}),
  };

  const status = failed === 0 ? "pass" : "fail";

  console.log(`Run complete: ${status}`);

  return {
    status,
    conversationResult: result,
    aggregate,
  };
}
