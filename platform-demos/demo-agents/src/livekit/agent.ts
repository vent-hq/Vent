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
import { instrumentLiveKitAgent } from "@vent-hq/livekit";
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

function normalizeString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return value as string;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Every parameter is optional in the schema; the backend rejects missing required values.
function stringParam(description: string) {
  return z
    .preprocess(normalizeString, z.string().optional())
    .describe(description);
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
  parameters: z.object({phone: stringParam("Phone"), name: stringParam("Customer name"), company: stringParam("Company")}),
  execute: args => callTool("lookup_customer", args),
});
const checkAvailability = llm.tool({
  description: "Check inspection availability on a weekday. Use today's date from the instructions to resolve relative dates.",
  parameters: z.object({date: stringParam("Date in YYYY-MM-DD"), inspection_type: stringParam("fire, electrical, osha, environmental, comprehensive")}),
  execute: args => callTool("check_availability", args),
});
const bookInspection = llm.tool({
  description: "Book an inspection after the caller confirms the details.",
  parameters: z.object({customer_id: stringParam("Customer ID from lookup"), date: stringParam("YYYY-MM-DD"), time_slot: stringParam("Exact available slot in HH:MM-HH:MM"), inspection_type: stringParam("Inspection type"), notes: stringParam("Notes")}),
  execute: args => callTool("book_inspection", args),
});
const cancelInspection = llm.tool({
  description: "Cancel an existing booking.",
  parameters: z.object({booking_id: stringParam("Booking ID"), reason: stringParam("Reason")}),
  execute: args => callTool("cancel_inspection", args),
});

// ─── Agent ───

class SafetySpectAgent extends voice.Agent {
  constructor() {
    super({
      instructions: SYSTEM_PROMPT,
      // Same tool names as the other platforms' demo agents.
      tools: {
        lookup_customer: lookupCustomer,
        check_availability: checkAvailability,
        book_inspection: bookInspection,
        cancel_inspection: cancelInspection,
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

    // Forward tool calls, metrics and conversation items to Vent.
    const vent = instrumentLiveKitAgent({ ctx, session });
    const cleanup = () => vent.dispose();

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
