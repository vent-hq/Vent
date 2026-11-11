#!/usr/bin/env npx tsx
/**
 * Sets up / updates the SafetySpect Demo Booker on Vapi.
 *
 * - Updates existing tools and assistant by ID (no duplicate creation).
 * - Falls back to creating new resources if IDs are not set.
 *
 * Usage:
 *   VAPI_API_KEY=xxx npx tsx scripts/setup-vapi-assistant.ts
 *
 * Environment variables:
 *   - VAPI_API_KEY        (required)
 *   - BACKEND_URL         (optional, defaults to https://vent-demo-backend.fly.dev)
 */

const API_KEY = process.env["VAPI_API_KEY"];
if (!API_KEY) {
  console.error("Error: VAPI_API_KEY environment variable is required");
  process.exit(1);
}

const BACKEND_URL = process.env["BACKEND_URL"] ?? "https://vent-demo-backend.fly.dev";
const VAPI_API = "https://api.vapi.ai";

async function vapi(method: string, path: string, body?: unknown) {
  const res = await fetch(`${VAPI_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vapi ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── Live resource IDs (mirrors what's currently on Vapi) ──────────

const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID ?? process.env.VAPI_AGENT_ID ?? "";

const TOOL_IDS: Record<string, string> = {};

// ── Assistant config ────────────────────────────────────────

const ASSISTANT_NAME = "SafetySpect Demo Booker";

const FIRST_MESSAGE =
  "Hi, thanks for calling SafetySpect! This is our inspection scheduling line. How can I help you today?";

const INSTRUCTIONS = `Current date: {{now}}. Resolve relative dates from this date and include the correct year in tool calls.

You are SafetySpect's inspection scheduling assistant. Help callers schedule, confirm, reschedule, or cancel safety inspections.

GREETING:
- The system has ALREADY spoken your greeting. It is in the conversation history.
- Your FIRST LLM response must DIRECTLY address the caller's request. Do NOT greet again.

CONVERSATION RULES:
- Ask one question at a time.
- Keep responses to 1-2 short sentences.
- Do not repeat information the caller already provided.
- If the caller provides info before you ask, use it immediately.
- Do not narrate internal reasoning.

TOOL USE RULES:
- Do not call a tool until you have the information required to call it correctly.
- If required information is missing, ask for only one missing piece at a time.
- Do not call a tool with placeholders, guessed values, or incomplete arguments.
- After a tool succeeds, do not ask again for information that the tool result already resolved.
- After a tool result, briefly state the outcome and ask at most one next question.
- Do not mix filler, tool narration, and multiple follow-up questions in the same turn.
- Use filler like "one moment" only once per tool call. Never repeat it.
- If a tool returns an error, do NOT retry it with the same arguments. Tell the caller what went wrong and ask how they'd like to proceed (e.g. try a different date, or you can offer to have someone call them back).
- If the same tool fails twice in a row regardless of arguments, stop trying. Apologize briefly, explain there's a system issue, and offer an alternative (callback, different approach, etc.).

IDENTIFICATION:
- The caller's phone number from caller ID is {{customer.number}}. If available, use it immediately — do not ask for it.
- If caller ID is not available or lookup fails, ask for their name or company.

SPEECH FORMAT:
- Say time ranges naturally: "8 to 10 AM", not "8-10" or "eight minus ten".
- Be warm but efficient — don't waste the caller's time.

CLOSING:
- After completing a request, ask if the caller needs anything else.
- Only call endCall AFTER the caller explicitly confirms they are done.
- Never call endCall in the same turn you ask "Is there anything else?"`;

// ── Tool definitions ────────────────────────────────────────

const TOOLS = [
  {
    id: TOOL_IDS.lookup_customer,
    type: "function" as const,
    function: {
      name: "lookup_customer",
      description:
        "Look up a customer by phone number, name, or company name. Returns customer record with ID, name, company, phone, upcoming inspections, and inspection history. MUST be called before booking or cancelling. At least one of phone, name, or company is required — do not call with none. If the result includes an upcoming inspection matching the caller's request, tell them the date/time and ask if they want to keep or reschedule it. If the customer is not found, let them know and suggest contacting SafetySpect to set up an account.",
      parameters: {
        type: "object",
        properties: {
          phone: { description: "Customer phone number (e.g. 555-0101)", type: "string" },
          name: { description: "Customer full name", type: "string" },
          company: { description: "Company name", type: "string" },
        },
        required: [],
      },
    },
    server: { url: `${BACKEND_URL}/` },
  },
  {
    id: TOOL_IDS.check_availability,
    type: "function" as const,
    function: {
      name: "check_availability",
      description:
        "Check available inspection time slots for a given date and inspection type. Returns available 2-hour slots (4-hour for comprehensive). Weekdays only, 8am-5pm ET. Both date and inspection_type are required. If the caller requests a weekend, explain weekdays only and ask for an alternative before calling this tool.",
      parameters: {
        type: "object",
        properties: {
          date: { description: "Date in YYYY-MM-DD format", type: "string" },
          inspection_type: {
            description: "Type of inspection",
            type: "string",
            enum: ["fire", "electrical", "osha", "environmental", "comprehensive"],
          },
        },
        required: ["date", "inspection_type"],
      },
    },
    server: { url: `${BACKEND_URL}/` },
  },
  {
    id: TOOL_IDS.book_inspection,
    type: "function" as const,
    function: {
      name: "book_inspection",
      description:
        "Book an inspection. Requires customer_id from a prior lookup_customer call, a future weekday date, and a time_slot from check_availability. Confirm the booking details (type, date, time slot) with the caller before calling this tool. After success, state the confirmed booking once and ask if the caller needs anything else.",
      parameters: {
        type: "object",
        properties: {
          customer_id: { description: "Customer ID from lookup_customer (e.g. C001)", type: "string" },
          date: { description: "Date in YYYY-MM-DD format", type: "string" },
          time_slot: { description: "Time slot (e.g. 10:00-12:00)", type: "string" },
          inspection_type: {
            description: "Type of inspection",
            type: "string",
            enum: ["fire", "electrical", "osha", "environmental", "comprehensive"],
          },
          notes: { description: "Optional notes", type: "string" },
        },
        required: ["customer_id", "date", "time_slot", "inspection_type"],
      },
    },
    server: { url: `${BACKEND_URL}/` },
  },
  {
    id: TOOL_IDS.cancel_inspection,
    type: "function" as const,
    function: {
      name: "cancel_inspection",
      description:
        "Cancel an existing inspection booking. Requires booking_id from lookup_customer results. Confirm the booking details with the caller before calling. A $50 late cancellation fee applies if within 24 hours of the scheduled time — mention this to the caller after cancellation if applicable.",
      parameters: {
        type: "object",
        properties: {
          booking_id: { description: "Booking ID (e.g. B001)", type: "string" },
          reason: { description: "Optional reason", type: "string" },
        },
        required: ["booking_id"],
      },
    },
    server: { url: `${BACKEND_URL}/` },
  },
];

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // Reuse the existing assistant's tools by name when an ID is supplied.
  const current = ASSISTANT_ID ? await vapi("GET", `/assistant/${ASSISTANT_ID}`) : null;
  for (const id of current?.model?.toolIds ?? []) {
    const existing = await vapi("GET", `/tool/${id}`);
    const tool = TOOLS.find(tool => tool.function.name === existing.function?.name);
    if (tool) tool.id = id;
  }
  // Step 1: Update existing tools (PATCH by ID, no duplicates)
  console.log("Updating tools...\n");
  const toolIds: string[] = [];

  for (const tool of TOOLS) {
    if (tool.id) {
      // PATCH doesn't accept `type` — only send mutable fields
      const updated = await vapi("PATCH", `/tool/${tool.id}`, {
        function: tool.function,
        server: tool.server,
      });
      toolIds.push(updated.id);
      console.log(`  ✓ ${tool.function.name} → ${updated.id} (updated)`);
    } else {
      const created = await vapi("POST", "/tool", {
        type: tool.type,
        function: tool.function,
        server: tool.server,
      });
      toolIds.push(created.id);
      console.log(`  ✓ ${tool.function.name} → ${created.id} (created)`);
    }
  }

  const finalToolIds = toolIds;

  // Only send fields that Vapi PATCH accepts — no read-only props.
  // Note: Vapi REST API uses `model.tools` (inline) or `model.toolIds` for tool linking,
  // not a top-level `toolIds` field.
  const assistantBody = {
    name: ASSISTANT_NAME,
    firstMessage: FIRST_MESSAGE,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: INSTRUCTIONS },
      ],
      toolIds: finalToolIds,
      tools: [{ type: "endCall" }],
    },
    voice: {
      provider: "vapi",
      voiceId: "Elliot",
    },
    transcriber: {
      provider: "deepgram",
      model: "nova-3",
    },
  };

  console.log(`\nUpdating assistant: ${ASSISTANT_ID}`);
  const updated = ASSISTANT_ID
    ? await vapi("PATCH", `/assistant/${ASSISTANT_ID}`, assistantBody)
    : await vapi("POST", "/assistant", assistantBody);
  console.log(`  ✓ Assistant: ${updated.id}\n`);

  // ── Output summary ──
  console.log("=".repeat(60));
  console.log("SafetySpect Demo Booker — Vapi Setup Complete");
  console.log("=".repeat(60));
  console.log(`\nAssistant ID: ${updated.id}`);
  console.log(`Backend:      ${BACKEND_URL}`);
  console.log(`Tools:        ${toolIds.length} updated`);
  toolIds.forEach((id, i) => {
    console.log(`  ${TOOLS[i].function.name} → ${id}`);
  });
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});

export {};
