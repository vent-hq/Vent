/**
 * Single call execution — runs one conversation call against a voice agent.
 * Audio quality analysis and latency drift are integrated
 * into the call (no standalone infrastructure probes).
 */

import { randomUUID } from "node:crypto";
import { isPlatformProvider, type ConversationCallSpec, type ConversationCallResult } from "@vent/shared";
import { buildArtifactUrl, createArtifactToken, createStorageClient } from "@vent/artifacts";
import { createAudioChannel, type AudioChannel, type AudioChannelConfig } from "@vent/adapters";
import { runConversationCall } from "./conversation/executor.js";
import { buildPlatformTranscript } from "./conversation/platform-transcript.js";

export interface ExecuteCallOpts {
  callSpec: ConversationCallSpec;
  channelConfig: AudioChannelConfig;
  runId: string;
  /** Owning user, recorded in the recording artifact token for audit logging. */
  userId: string;
  /** Signs recording links: the recording is served by the API at apiPublicUrl. */
  recordingLinks: RecordingLinkSigning;
  /** External cancel signal — when fired, the call aborts at the next turn
   *  boundary, partial transcript is preserved, and the channel is hung up. */
  signal?: AbortSignal;
}

export interface RecordingLinkSigning {
  secret: string;
  apiPublicUrl: string;
}

export interface ExecuteCallResult {
  status: "pass" | "fail";
  conversationResult: ConversationCallResult;
}

interface ActiveRecordingUpload {
  finalize(): Promise<string | null>;
  abort(): Promise<void>;
}

let storageClient: ReturnType<typeof createStorageClient> | undefined;

function getStorageClient() {
  return (storageClient ??= createStorageClient());
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
  runId: string,
): Promise<void> {
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

function buildRecordingUrl(key: string, signing: RecordingLinkSigning, userId: string): string {
  // Signed-URL-only auth (S3/Twilio pattern). The HMAC token is the credential;
  // 1h TTL bounds blast radius. No dashboard sign-in required.
  return buildArtifactUrl(signing.apiPublicUrl, createArtifactToken(key, signing.secret, { userId }));
}

async function startRecordingUpload(
  channel: AudioChannel,
  resultName: string | undefined,
  callerPrompt: string,
  runId: string,
  userId: string,
  signing: RecordingLinkSigning,
): Promise<ActiveRecordingUpload> {
  const liveRecording = channel.getLiveCallRecording?.();
  if (!liveRecording) {
    throw new Error("Vent-owned recording stream is unavailable");
  }

  const storage = getStorageClient();
  const baseName = slugifyRecordingLabel(resultName ?? callerPrompt.slice(0, 48));
  const key = `recordings/${runId}/${baseName}-${randomUUID()}.wav`;
  const recordingUrl = buildRecordingUrl(key, signing, userId);
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
    recordingLinks,
    signal,
  } = opts;

  // Pre-flight health check — only for relay/local agent runs.
  // Platform adapters (vapi, retell, elevenlabs, bland) don't need this —
  // it would waste a real API call + credits just to verify connectivity.
  // The first real call will fail with a clear error if config is wrong.
  if (!isPlatformProvider(channelConfig.adapter)) {
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
        metrics: {},
        error: `Agent unreachable: ${errorMsg}`,
      };
      return { status: "fail", conversationResult: failResult };
    }
  }

  // Execute the single call
  const callName = spec.name ?? `conversation:${spec.caller_prompt.slice(0, 50)}`;
  console.log(`  Conversation: ${spec.caller_prompt.slice(0, 60)}...`);

  const channel = await createAudioChannel(channelConfig);
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
        recordingUpload = await startRecordingUpload(channel, spec.name, spec.caller_prompt, runId, userId, recordingLinks);
      },
      signal,
    });
    result = callResult;
    await attachRecordingUrl(result, channel, channelConfig.adapter, recordingUpload, runId);
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

    // Vent's own transcript is lost with the throw; keep what the platform
    // recorded, since the failure may have come late in the call.
    const platformTranscript = buildPlatformTranscript(channel.getTranscripts?.() ?? []);

    result = {
      name: spec.name,
      caller_prompt: spec.caller_prompt,
      status: "error",
      transcript: [],
      ...(platformTranscript.length > 0 ? { platform_transcript: platformTranscript } : {}),
      duration_ms: Date.now() - start,
      metrics: {},
      error: errorMsg,
      observed_tool_calls: observedToolCalls.length > 0 ? observedToolCalls : undefined,
      call_metadata: callMetadata ?? undefined,
    };
    await attachRecordingUrl(result, channel, channelConfig.adapter, recordingUpload, runId);
    console.log(JSON.stringify({
      event: "call_complete", call_name: callName,
      status: "error", duration_ms: result.duration_ms, error: errorMsg,
    }));
  } finally {
    await channel.disconnect().catch(() => {});
  }

  const status = result.status === "error" ? "fail" : "pass";
  console.log(`Run complete: ${status}`);
  return { status, conversationResult: result };
}
