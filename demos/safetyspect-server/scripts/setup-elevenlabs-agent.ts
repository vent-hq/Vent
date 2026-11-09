#!/usr/bin/env npx tsx
/**
 * Sets up the SafetySpect Demo Booker on ElevenLabs Conversational AI.
 *
 * - Creates (or updates) an ElevenLabs agent with system prompt + webhook tools
 *
 * Usage:
 *   ELEVENLABS_API_KEY=xxx npx tsx scripts/setup-elevenlabs-agent.ts
 *
 * Environment variables:
 *   - ELEVENLABS_API_KEY      (required)
 *   - BACKEND_URL             (optional, defaults to https://vent-demo-backend.fly.dev)
 *   - ELEVENLABS_AGENT_ID     (optional, set after first run to update in place)
 */

const API_KEY = process.env["ELEVENLABS_API_KEY"];
if (!API_KEY) {
  console.error("Error: ELEVENLABS_API_KEY environment variable is required");
  process.exit(1);
}

const BACKEND_URL =
  process.env["BACKEND_URL"] ?? "https://vent-demo-backend.fly.dev";

const EXISTING_AGENT_ID = process.env["ELEVENLABS_AGENT_ID"] || "";

const API_BASE = "https://api.elevenlabs.io/v1/convai/agents";

// ── System prompt ──────────────────────────────────────────

const SYSTEM_PROMPT = `Current date: {{system__time_date}}. Resolve relative dates from this date and include the correct year in tool calls.

## Identity
You are SafetySpect's inspection scheduling assistant. You help callers schedule, confirm, reschedule, or cancel safety inspections.

## Style Guidelines
- Be Concise: Respond succinctly, addressing one topic at most.
- Embrace Variety: Use diverse language and rephrasing to enhance clarity without repeating content.
- Be Conversational: Use everyday language, making the chat feel like talking to a friend.
- Be Proactive: Lead the conversation, often wrapping up with a question or next-step suggestion.
- Avoid multiple questions in a single response.

## Response Guideline
- Adapt and Guess: Try to understand transcripts that may contain transcription errors. Avoid mentioning "transcription error" in the response.
- Stay in Character: Keep conversations within your role's scope, guiding them back creatively without breaking character.
- Ensure Fluid Dialogue: Respond in a role-appropriate, direct manner to maintain a smooth conversation flow.
- Use a colloquial way of referring to the date (like Friday, January 14th, or Tuesday, January 12th, 2024).

## Task
You will follow the steps below, do not skip steps, and only ask up to one question in response.

IDENTIFICATION:
- If the caller provides their name or company, use it immediately to look them up.
- If lookup fails, ask for a different identifier (phone, name, or company).

CONVERSATION RULES:
- Ask one question at a time.
- Keep responses to 1-2 short sentences.
- Do not repeat information the caller already provided.
- If the caller provides info before you ask, use it immediately.

TOOL USE RULES:
- Do not call a tool until you have the required information.
- If required information is missing, ask for only one missing piece at a time.
- After a tool succeeds, briefly state the outcome and ask at most one next question.
- Use filler like "one moment" only once per tool call.
- If a tool returns an error, tell the caller what went wrong and ask how they'd like to proceed.

SPEECH FORMAT:
- Say time ranges naturally: "8 to 10 AM", not "8-10" or "eight minus ten".
- Be warm but efficient.

CLOSING:
- After completing a request, ask if the caller needs anything else.
- Only end the call after the caller explicitly confirms they are done.`;

const FIRST_MESSAGE =
  "Hi, thanks for calling SafetySpect! This is our inspection scheduling line. How can I help you today?";

// ── Webhook tool definitions ──────────────────────────────

const TOOLS: any[] = [
  {
    type: "webhook",
    name: "lookup_customer",
    description:
      "Look up a customer by phone number, name, or company name. Returns customer record with upcoming inspections and history. Must be called before booking or cancelling. At least one of phone, name, or company is required.",
    api_schema: {
      url: `${BACKEND_URL}/elevenlabs/lookup_customer`,
      method: "POST",
      request_body_schema: {
        type: "object",
        properties: {
          phone: {
            type: "string",
            description: "Customer phone number (e.g. 555-0101)",
          },
          name: {
            type: "string",
            description: "Customer full name",
          },
          company: {
            type: "string",
            description: "Company name",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "webhook",
    name: "check_availability",
    description:
      "Check available inspection time slots for a given date and type. Returns available 2-hour slots (4-hour for comprehensive). Weekdays only, 8am-5pm ET. Both date and inspection_type are required.",
    api_schema: {
      url: `${BACKEND_URL}/elevenlabs/check_availability`,
      method: "POST",
      request_body_schema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date in YYYY-MM-DD format",
          },
          inspection_type: {
            type: "string",
            description:
              "Type of inspection: fire, electrical, osha, environmental, or comprehensive",
          },
        },
        required: ["date", "inspection_type"],
      },
    },
  },
  {
    type: "webhook",
    name: "book_inspection",
    description:
      "Book an inspection. Requires customer_id from lookup_customer, a future weekday date, a time_slot from check_availability, and inspection_type. Confirm details with the caller before calling.",
    api_schema: {
      url: `${BACKEND_URL}/elevenlabs/book_inspection`,
      method: "POST",
      request_body_schema: {
        type: "object",
        properties: {
          customer_id: {
            type: "string",
            description: "Customer ID from lookup_customer (e.g. C001)",
          },
          date: {
            type: "string",
            description: "Date in YYYY-MM-DD format",
          },
          time_slot: {
            type: "string",
            description: "Time slot (e.g. 08:00-10:00)",
          },
          inspection_type: {
            type: "string",
            description:
              "Type of inspection: fire, electrical, osha, environmental, or comprehensive",
          },
          notes: {
            type: "string",
            description: "Optional notes",
          },
        },
        required: ["customer_id", "date", "time_slot", "inspection_type"],
      },
    },
  },
  {
    type: "webhook",
    name: "cancel_inspection",
    description:
      "Cancel an existing inspection booking. Requires booking_id from lookup_customer results. Confirm with the caller before calling. A $50 late cancellation fee applies if within 24 hours.",
    api_schema: {
      url: `${BACKEND_URL}/elevenlabs/cancel_inspection`,
      method: "POST",
      request_body_schema: {
        type: "object",
        properties: {
          booking_id: {
            type: "string",
            description: "Booking ID (e.g. B001)",
          },
          reason: {
            type: "string",
            description: "Optional cancellation reason",
          },
        },
        required: ["booking_id"],
      },
    },
  },
];

// ── Main ─────────────────────────────────────────────────────

async function apiRequest(
  method: string,
  url: string,
  body?: any
): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      "xi-api-key": API_KEY!,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${url} failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function main() {
  console.log("Setting up ElevenLabs Conversational AI Agent...\n");

  const agentBody = {
    name: "SafetySpect Demo Booker",
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE,
        language: "en",
        prompt: {
          prompt: SYSTEM_PROMPT,
          llm: "claude-haiku-4-5",
          temperature: 0,
          tools: TOOLS,
        },
      },
      tts: {
        voice_id: "JBFqnCBsd6RMkjVDRZzb",
        model_id: "eleven_flash_v2",
        stability: 0.5,
        similarity_boost: 0.8,
        speed: 1,
      },
      asr: {
        quality: "high",
        provider: "scribe_realtime",
        keywords: [
          "SafetySpect",
          "OSHA",
          "fire inspection",
          "electrical inspection",
          "environmental inspection",
          "comprehensive inspection",
        ],
      },
      turn: {
        turn_timeout: 7,
        silence_end_call_timeout: 20,
      },
      conversation: {
        max_duration_seconds: 600,
      },
    },
  };

  let agentId: string;

  if (EXISTING_AGENT_ID) {
    console.log(`  Updating existing agent: ${EXISTING_AGENT_ID}`);
    const updated = await apiRequest(
      "PATCH",
      `${API_BASE}/${EXISTING_AGENT_ID}`,
      agentBody
    );
    agentId = updated.agent_id;
    console.log(`  \u2713 Agent updated: ${agentId}`);
  } else {
    const created = await apiRequest("POST", `${API_BASE}/create`, agentBody);
    agentId = created.agent_id;
    console.log(`  \u2713 Agent created: ${agentId}`);
  }

  // ── Output summary ──
  console.log("\n" + "=".repeat(60));
  console.log("SafetySpect Demo Booker \u2014 ElevenLabs Setup Complete");
  console.log("=".repeat(60));
  console.log(`\nAgent ID:  ${agentId}`);
  console.log(`Backend:   ${BACKEND_URL}`);
  console.log(`\nTools:`);
  TOOLS.forEach((t) => {
    console.log(`  ${t.name} \u2192 ${t.api_schema.url}`);
  });
  console.log(`\nAdd to .env:\n  ELEVENLABS_AGENT_ID=${agentId}`);
  console.log();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});

export {};
