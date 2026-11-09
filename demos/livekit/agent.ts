/**
 * SafetySpect Demo Booker — LiveKit Voice Agent (TypeScript).
 *
 * TypeScript port of the Python agent, used to verify the @vent-hq/livekit
 * npm package works end-to-end with Vent's LiveKit adapter.
 *
 * Same tools: lookup_customer, check_availability, book_inspection, cancel_inspection
 * All tools call the shared SafetySpect backend, which stores demo data in PostgreSQL.
 */

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
  llm,
  inference,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { dispose } from "@livekit/rtc-node";
import { z } from "zod";
import { fileURLToPath } from "node:url";

const BACKEND_URL = process.env.DEMO_BACKEND_URL;
if (!BACKEND_URL) throw new Error("DEMO_BACKEND_URL is required");

const today = new Date();
const todayISO = today.toISOString().split("T")[0];
const todayHuman = today.toLocaleDateString("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});
const VENT_TOPICS = {
  callMetadata: "vent:call-metadata",
  debugUrl: "vent:debug-url",
  warning: "vent:warning",
  metrics: "vent:metrics",
  functionToolsExecuted: "vent:function-tools-executed",
  toolCalls: "vent:tool-calls",
  conversationItem: "vent:conversation-item",
  userInputTranscribed: "vent:user-input-transcribed",
  sessionUsage: "vent:session-usage",
} as const;
const textEncoder = new TextEncoder();
let activeToolCallPublisher:
  | ((payload: {
      name: string;
      arguments: unknown;
      result: unknown;
      successful: boolean;
      duration_ms: number;
    }) => void)
  | undefined;

const SYSTEM_PROMPT = `You are Elliot, an AI receptionist for SafetySpect, a safety inspection company.
Today's date is ${todayISO} (${todayHuman}).

Your capabilities:
- Look up customer accounts by phone number, name, or company name
- Check available inspection time slots for a given date
- Book safety inspections (fire, electrical, OSHA, environmental, comprehensive)
- Cancel existing inspection bookings

Rules:
- Greet callers warmly once at the start of the conversation: "Hi, thanks for calling SafetySpect! My name is Elliot. How can I help you today?"
- Never repeat the opening greeting after the first turn.
- Always look up the customer before booking or canceling — never trust a caller-provided customer ID without verification
- If the caller already gave enough identifying information in one utterance, use it before asking them to repeat anything.
- Resolve relative dates using today's date above, then pass YYYY-MM-DD to the availability tool.
- Inspection types are exactly: fire, electrical, OSHA, environmental, comprehensive. There are no other types. If the caller says "ocean inspection" (or anything resembling it), that is OSHA being misheard by speech recognition — treat it as OSHA. Never invent a type or silently switch the caller's requested type to a different one.
- Inspections are available weekdays only (Monday–Friday), in 2-hour slots
- Cancellations within 24 hours of the inspection incur a $50 late cancellation fee
- Confirm all booking details with the caller before submitting
- Be helpful, professional, and concise
- Keep responses short — 1-2 sentences at a time. Do not monologue.
- If the caller says they are done, will call back later, or has no more questions, reply with one short closing and end the conversation. Always write closers as two separate sentences split by a period, never a comma — for example "Sounds good. Take care." or "Thanks for calling. Goodbye." Comma-joined short phrases (like "Of course, talk soon.") get garbled by the TTS engine. Do not reopen with another greeting, another intake question, or a second farewell sentence.
- NEVER use markdown formatting (no asterisks, bold, bullet points). You are speaking out loud, not writing.
- When using tools, tell the caller what you're doing briefly, then use the tool. Don't narrate every step.`;

function normalizeOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return value as string;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeRequiredString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return value as string;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalStringParam(description: string) {
  return z
    .preprocess(normalizeOptionalString, z.string().optional())
    .describe(description);
}

function requiredStringParam(description: string) {
  return z
    .preprocess(normalizeRequiredString, z.string().optional())
    .describe(description);
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sanitizeForJson(value: unknown, depth = 0): unknown {
  if (value == null || depth > 8) return value ?? null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item, depth + 1));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, nested]) => [
        String(key),
        sanitizeForJson(nested, depth + 1),
      ])
    );
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((item) => sanitizeForJson(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => typeof nested !== "function" && typeof nested !== "symbol")
        .map(([key, nested]) => [key, sanitizeForJson(nested, depth + 1)])
    );
  }
  return String(value);
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function publishVentEvent(
  ctx: JobContext,
  topic: string,
  payload: Record<string, unknown>,
  eventType = topic
): Promise<void> {
  const participant = ctx.room.localParticipant;
  if (!participant) return;

  await participant.publishData(
    textEncoder.encode(JSON.stringify(sanitizeForJson({ type: eventType, ...payload }))),
    {
      reliable: true,
      topic,
    }
  );
}

function toolResultSuccessful(result: unknown): boolean {
  return !(
    result &&
    typeof result === "object" &&
    "error" in (result as Record<string, unknown>) &&
    (result as Record<string, unknown>).error != null
  );
}

function withToolCallReporting<TArgs extends Record<string, unknown>, TResult>(
  name: string,
  execute: (args: TArgs) => Promise<TResult>
) {
  return async (args: TArgs): Promise<TResult> => {
    const startedAt = Date.now();

    try {
      const result = await execute(args);
      activeToolCallPublisher?.({
        name,
        arguments: args,
        result,
        successful: toolResultSuccessful(result),
        duration_ms: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      activeToolCallPublisher?.({
        name,
        arguments: args,
        result:
          error instanceof Error
            ? { error: error.message, name: error.name }
            : { error: String(error) },
        successful: false,
        duration_ms: Date.now() - startedAt,
      });
      throw error;
    }
  };
}

function instrumentVentLiveKitSession(ctx: JobContext, session: voice.AgentSession) {
  const teardownFns: Array<() => void> = [];
  const subscribe = <TEvent>(
    eventName: string,
    listener: (event: TEvent) => void
  ) => {
    session.on(eventName as never, listener as never);
    teardownFns.push(() => {
      session.off(eventName as never, listener as never);
    });
  };
  const safePublish = (operation: () => Promise<void>, context: string) => {
    void operation().catch((error) => {
      console.warn(`[vent-livekit] Failed to publish ${context}`, error);
    });
  };

  subscribe<voice.MetricsCollectedEvent>(
    voice.AgentSessionEventTypes.MetricsCollected,
    (event) => {
      safePublish(
        () =>
          publishVentEvent(ctx, VENT_TOPICS.metrics, {
            event: "metrics_collected",
            ...(sanitizeForJson(event) as Record<string, unknown>),
          }),
        "metrics_collected"
      );
    }
  );

  subscribe<voice.FunctionToolsExecutedEvent>(
    voice.AgentSessionEventTypes.FunctionToolsExecuted,
    (event) => {
      const function_calls = event.functionCalls.map((call) => ({
        name: call.name,
        arguments: parseJsonish(call.args),
        call_id: call.callId,
      }));
      const function_call_outputs = event.functionCallOutputs.map((output) => ({
        name: output.name,
        output: parseJsonish(output.output),
        call_id: output.callId,
        is_error: output.isError,
      }));
      const tool_calls = event.functionCalls.map((call, index) => ({
        name: call.name,
        arguments: parseJsonish(call.args),
        call_id: call.callId,
        result: function_call_outputs[index]?.output,
        successful:
          function_call_outputs[index] != null ? !function_call_outputs[index].is_error : undefined,
      }));

      safePublish(
        () =>
          publishVentEvent(ctx, VENT_TOPICS.functionToolsExecuted, {
            event: "function_tools_executed",
            created_at: event.createdAt,
            function_calls,
            function_call_outputs,
            tool_calls,
          }),
        "function_tools_executed"
      );
    }
  );

  subscribe<voice.ConversationItemAddedEvent>(
    voice.AgentSessionEventTypes.ConversationItemAdded,
    (event) => {
      const payload = sanitizeForJson(event) as Record<string, unknown>;
      const item = payload.item;
      if (item && typeof item === "object" && Array.isArray((item as { content?: unknown[] }).content)) {
        (item as { content: unknown[] }).content = (item as { content: unknown[] }).content.filter(
          (content) => {
            if (typeof content === "string") return true;
            if (content && typeof content === "object" && "type" in content) {
              const contentType = (content as { type?: unknown }).type;
              return contentType !== "audio_content" && contentType !== "image_content";
            }
            return true;
          }
        );
      }

      safePublish(
        () =>
          publishVentEvent(ctx, VENT_TOPICS.conversationItem, {
            event: "conversation_item_added",
            ...payload,
          }),
        "conversation_item_added"
      );
    }
  );

  subscribe<voice.UserInputTranscribedEvent>(
    voice.AgentSessionEventTypes.UserInputTranscribed,
    (event) => {
      safePublish(
        () =>
          publishVentEvent(ctx, VENT_TOPICS.userInputTranscribed, {
            event: "user_input_transcribed",
            ...(sanitizeForJson(event) as Record<string, unknown>),
          }),
        "user_input_transcribed"
      );
    }
  );

  subscribe<voice.SessionUsageUpdatedEvent>(
    voice.AgentSessionEventTypes.SessionUsageUpdated,
    (event) => {
      const payload = sanitizeForJson(event) as Record<string, unknown>;
      const usage =
        payload.usage && typeof payload.usage === "object"
          ? (payload.usage as Record<string, unknown>)
          : payload;

      safePublish(
        () => publishVentEvent(ctx, VENT_TOPICS.sessionUsage, { usage }),
        "session_usage_updated"
      );
    }
  );

  subscribe<voice.CloseEvent>(voice.AgentSessionEventTypes.Close, (event) => {
    const payload = sanitizeForJson(event) as Record<string, unknown>;
    if (payload.error == null) return;

    safePublish(
      () =>
        publishVentEvent(ctx, VENT_TOPICS.warning, {
          message: "LiveKit session closed with error",
          error: payload.error,
        }),
      "close warning"
    );
  });

  safePublish(
    () =>
      publishVentEvent(ctx, VENT_TOPICS.callMetadata, {
        call_metadata: compactRecord({
          platform: "livekit",
        }) ?? { platform: "livekit" },
      }),
    "call metadata"
  );

  return {
    dispose() {
      for (const teardown of teardownFns.splice(0)) {
        teardown();
      }
    },
  };
}

// All platforms use the same deployed business backend and PostgreSQL database.
async function callTool(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${BACKEND_URL}/${name}`, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify(args), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Demo tool ${name} failed (${response.status})`);
  return await response.json();
}

const lookupCustomer = llm.tool({
  description: "Look up a customer by name, phone or company before booking.",
  parameters: z.object({phone: optionalStringParam("Phone"), name: optionalStringParam("Customer name"), company: optionalStringParam("Company")}),
  execute: withToolCallReporting("lookup_customer", args => callTool("lookup_customer", args)),
});
const checkAvailability = llm.tool({
  description: "Check inspection availability on a weekday. Use today's date from the instructions to resolve relative dates.",
  parameters: z.object({date: requiredStringParam("Date in YYYY-MM-DD"), inspection_type: requiredStringParam("fire, electrical, osha, environmental, comprehensive")}),
  execute: withToolCallReporting("check_availability", args => callTool("check_availability", args)),
});
const bookInspection = llm.tool({
  description: "Book an inspection after the caller confirms the details.",
  parameters: z.object({customer_id: requiredStringParam("Customer ID from lookup"), date: requiredStringParam("YYYY-MM-DD"), time_slot: requiredStringParam("Exact available slot in HH:MM-HH:MM"), inspection_type: requiredStringParam("Inspection type"), notes: optionalStringParam("Notes")}),
  execute: withToolCallReporting("book_inspection", args => callTool("book_inspection", args)),
});
const cancelInspection = llm.tool({
  description: "Cancel an existing booking.",
  parameters: z.object({booking_id: requiredStringParam("Booking ID"), reason: optionalStringParam("Reason")}),
  execute: withToolCallReporting("cancel_inspection", args => callTool("cancel_inspection", args)),
});

// ─── Agent ───

class SafetySpectAgent extends voice.Agent {
  constructor() {
    super({
      instructions: SYSTEM_PROMPT,
      tools: {
        lookupCustomer,
        checkAvailability,
        bookInspection,
        cancelInspection,
      },
    });
  }
}

// ─── Entrypoint ───

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const vad = ctx.proc.userData.vad as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: new inference.STT({
        model: "deepgram/flux-general-en",
        language: "en",
      }),
      llm: "openai/gpt-4o-mini",
      tts: new inference.TTS({ model: "deepgram/aura-2", voice: "andromeda" }),
      maxToolSteps: 6,
      preemptiveGeneration: true,
      turnHandling: {
        turnDetection: "stt",
        interruption: {
          discardAudioIfUninterruptible: false,
          minWords: 1,
        },
      },
    });

    await session.start({
      agent: new SafetySpectAgent(),
      room: ctx.room,
    });

    // Instrument for Vent observability with a local compat bridge for the
    // current LiveKit SDK event shapes.
    const bridge = instrumentVentLiveKitSession(ctx, session);
    activeToolCallPublisher = (payload) => {
      void publishVentEvent(ctx, VENT_TOPICS.toolCalls, payload, "tool_call").catch((error) => {
        console.warn("[vent-livekit] Failed to publish tool_call", error);
      });
    };
    const cleanup = () => {
      activeToolCallPublisher = undefined;
      bridge.dispose();
    };

    ctx.addShutdownCallback(async () => {
      // Shutdown can run after the room transport is already gone, so do not
      // publish additional Vent events from here.
      cleanup();
    });

    // Only emit the opening greeting if the room has no prior conversation.
    // If a fresh worker takes over a room mid-call (LiveKit Cloud can do this
    // when the original worker drops), session.history is empty on this side
    // but the caller has already heard the greeting — re-greeting confuses
    // the caller and forces them to restart the flow.
    const hasPriorConversation = session.history.items.some(
      (item) => item.type === "message" && item.role !== "system"
    );
    if (!hasPriorConversation) {
      session.say(
        "Hi, thanks for calling SafetySpect! My name is Elliot. How can I help you today?"
      );
    }

    // Clean up on shutdown
    ctx.room.on("disconnected", () => {
      cleanup();
    });
  },
});

if (typeof process.send !== "function") {
  const originalExit = process.exit.bind(process);
  let exitInProgress = false;
  let disposePromise: Promise<void> | undefined;

  const disposeRtcNode = () => {
    if (!disposePromise) {
      disposePromise = dispose().catch((error) => {
        console.error("RTC teardown failed before process exit:", error);
        throw error;
      });
    }

    return disposePromise;
  };

  process.exit = ((code?: number) => {
    const exitCode = typeof code === "number" ? code : process.exitCode ?? 0;

    if (exitInProgress) {
      return originalExit(exitCode);
    }

    exitInProgress = true;

    void disposeRtcNode()
      .catch(() => undefined)
      .finally(() => {
        originalExit(exitCode);
      });

    return undefined as never;
  }) as typeof process.exit;
}

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_AGENT_NAME ?? "safetyspect-ts",
    numIdleProcesses: 0,
    initializeProcessTimeout: 60_000,
  })
);
