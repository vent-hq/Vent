#!/usr/bin/env npx tsx
/**
 * Sets up the SafetySpect Demo Booker on Retell AI.
 *
 * - Creates a Retell LLM config with system prompt + custom tools
 * - Creates (or updates) an agent referencing that LLM
 *
 * Usage:
 *   RETELL_API_KEY=xxx npx tsx scripts/setup-retell-agent.ts
 *
 * Environment variables:
 *   - RETELL_API_KEY   (required)
 *   - BACKEND_URL      (optional, defaults to https://vent-demo-backend.fly.dev)
 */

import Retell from "retell-sdk";

const API_KEY = process.env["RETELL_API_KEY"];
if (!API_KEY) {
  console.error("Error: RETELL_API_KEY environment variable is required");
  process.exit(1);
}

const BACKEND_URL =
  process.env["BACKEND_URL"] ?? "https://vent-demo-backend.fly.dev";

const client = new Retell({ apiKey: API_KEY });

// ── Existing resource IDs (set after first run, then update in place) ──
const EXISTING_LLM_ID = process.env["RETELL_LLM_ID"] || "";
const EXISTING_AGENT_ID = process.env["RETELL_AGENT_ID"] || "";

// ── MCP server URL (Google Calendar) ──
const GOOGLE_CALENDAR_MCP_URL = process.env["GOOGLE_CALENDAR_MCP_URL"] || "";

// ── System prompt ──────────────────────────────────────────

const GENERAL_PROMPT = `## Identity
You are SafetySpect's inspection scheduling assistant. You help callers schedule, confirm, reschedule, or cancel safety inspections.

## Current Date
Today is {{current_time_America/New_York}}. Use this as your only source of truth for dates. Do not rely on training data or guess the year.

When the caller says a relative day ("tomorrow", "next Tuesday", "this Friday"), compute the absolute date from today:
- "tomorrow" = today + 1 day
- "next [weekday]" / "this [weekday]" = the **very next** occurrence of that weekday on or after today + 1 day. NEVER skip a week. If today is Saturday and the caller says "next Tuesday", that means the Tuesday 3 days from now, NOT the Tuesday 10 days from now.
- Worked example: if today is Saturday April 25, then "next Tuesday" = Tuesday April 28 (3 days away). It is wrong to interpret it as May 5.
- Always pass YYYY-MM-DD to check_availability and book_inspection, using today's year as the baseline.

If the caller's phrase is genuinely ambiguous (e.g. "the Tuesday after next"), ask them to confirm the exact date before calling a tool. Do not guess silently.

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

AVAILABILITY HANDLING:
- check_availability returns an "available_slots" array. NEVER claim a slot is open unless that exact time string is in the array the tool just returned. Do not invent times.
- If "available_slots" is empty, the date is fully booked. Tell the caller plainly and propose ONE specific alternative date (e.g. "Tuesday the 28th is fully booked — want me to check Wednesday the 29th?"). Do not re-check the same date you just checked.
- If two consecutive dates come back empty, stop scanning day-by-day and ask the caller what week or part of the month works for them.

BOOKING:
- Once the caller agrees to a specific slot from the times you just offered, call book_inspection immediately with that exact time_slot string from check_availability. Do not ask further questions before booking.
- Never end the call when the caller has agreed to a slot but you have not yet called book_inspection.
- After book_inspection succeeds, confirm the booking back (date, time, type) and ask if they need anything else.

GOOGLE CALENDAR (MCP):
- Before calling book_inspection, you MUST call list_events for the chosen date to check the customer's Google Calendar for conflicts.
- Pass the same YYYY-MM-DD date you would pass to book_inspection. You do not need to mention to the caller that you are checking their calendar — just do it as part of confirming the slot.
- If list_events returns an event that overlaps the chosen time slot, tell the caller about the conflict (mention the conflicting event's summary and time) and suggest an alternative slot. Do not book over a conflict.
- If list_events returns no overlapping events, proceed with book_inspection as usual.
- If the calendar tool errors or is unavailable, proceed with the booking anyway and do not mention the calendar to the caller.

SPEECH FORMAT:
- Say time ranges naturally: "8 to 10 AM", not "8-10" or "eight minus ten".
- Be warm but efficient.

CLOSING:
- After completing a request, ask if the caller needs anything else.
- Only end the call after the caller explicitly confirms they are done.`;

const BEGIN_MESSAGE =
  "Hi, thanks for calling SafetySpect! This is our inspection scheduling line. How can I help you today?";

// ── Tool definitions (Retell custom functions) ──────────────

const TOOLS: any[] = [
  {
    type: "custom" as const,
    name: "lookup_customer",
    description:
      "Look up a customer by phone number, name, or company name. Returns customer record with upcoming inspections and history. Must be called before booking or cancelling. At least one of phone, name, or company is required.",
    url: `${BACKEND_URL}/retell/lookup_customer`,
    method: "POST" as const,
    parameters: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Customer phone number (e.g. 555-0101)",
        },
        name: { type: "string", description: "Customer full name" },
        company: { type: "string", description: "Company name" },
      },
      required: [],
    },
    speak_during_execution: true,
    speak_after_execution: true,
  },
  {
    type: "custom" as const,
    name: "check_availability",
    description:
      "Check available inspection time slots for a given date and type. Returns available 2-hour slots (4-hour for comprehensive). Weekdays only, 8am-5pm ET. Both date and inspection_type are required.",
    url: `${BACKEND_URL}/retell/check_availability`,
    method: "POST" as const,
    parameters: {
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
    speak_during_execution: true,
    speak_after_execution: true,
  },
  {
    type: "custom" as const,
    name: "book_inspection",
    description:
      "Book an inspection. Requires customer_id from lookup_customer, a future weekday date, a time_slot from check_availability, and inspection_type. Confirm details with the caller before calling.",
    url: `${BACKEND_URL}/retell/book_inspection`,
    method: "POST" as const,
    parameters: {
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
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["customer_id", "date", "time_slot", "inspection_type"],
    },
    speak_during_execution: true,
    speak_after_execution: true,
  },
  {
    type: "custom" as const,
    name: "cancel_inspection",
    description:
      "Cancel an existing inspection booking. Requires booking_id from lookup_customer results. Confirm with the caller before calling. A $50 late cancellation fee applies if within 24 hours.",
    url: `${BACKEND_URL}/retell/cancel_inspection`,
    method: "POST" as const,
    parameters: {
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
    speak_during_execution: true,
    speak_after_execution: true,
  },
  {
    type: "end_call" as const,
    name: "end_call",
    description:
      "End the call. Only use after the caller confirms they have no more questions.",
  },
];

const MCP_TOOLS: any[] = GOOGLE_CALENDAR_MCP_URL
  ? [
      {
        type: "mcp" as const,
        name: "list_events",
        mcp_id: "google_calendar",
        description:
          "List events on the customer's Google Calendar for a given date range. Use this to check for scheduling conflicts before booking an inspection. Pass the YYYY-MM-DD date you intend to book.",
        input_schema: {
          start_date: "string",
          end_date: "string",
          max_results: "number",
        },
        speak_during_execution: false,
        speak_after_execution: false,
      },
      {
        type: "mcp" as const,
        name: "check_conflicts",
        mcp_id: "google_calendar",
        description:
          "Check whether a specific date and time range overlaps any existing event on the customer's Google Calendar. Returns has_conflict: true with the conflicting event details if so.",
        input_schema: {
          date: "string",
          start_time: "string",
          end_time: "string",
        },
        speak_during_execution: false,
        speak_after_execution: false,
      },
    ]
  : [];

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // Step 1: Create or update the Retell LLM config
  console.log("Setting up Retell LLM config...\n");

  let llmId: string;

  const mcps = GOOGLE_CALENDAR_MCP_URL
    ? [
        {
          id: "google_calendar",
          name: "google-calendar",
          url: GOOGLE_CALENDAR_MCP_URL,
          timeout_ms: 10000,
        },
      ]
    : [];

  const llmBody: Record<string, any> = {
    model: "claude-4.5-haiku" as const,
    model_temperature: 0,
    general_prompt: GENERAL_PROMPT,
    begin_message: BEGIN_MESSAGE,
    general_tools: [...TOOLS, ...MCP_TOOLS],
    ...(mcps.length > 0 ? { mcps } : {}),
  };

  if (EXISTING_LLM_ID) {
    console.log(`  Updating existing LLM: ${EXISTING_LLM_ID}`);
    const updated = await client.llm.update(EXISTING_LLM_ID, llmBody);
    llmId = updated.llm_id;
    console.log(`  ✓ LLM updated: ${llmId}`);
  } else {
    const created = await client.llm.create(llmBody);
    llmId = created.llm_id;
    console.log(`  ✓ LLM created: ${llmId}`);
  }

  // Step 2: Create or update the Retell Agent
  console.log("\nSetting up Retell Agent...\n");

  const agentBody = {
    agent_name: "SafetySpect Demo Booker",
    response_engine: {
      type: "retell-llm" as const,
      llm_id: llmId,
    },
    voice_id: "11labs-Adrian",
    language: "en-US" as const,
    voice_speed: 1,
    voice_temperature: 1,
    responsiveness: 1,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    backchannel_frequency: 0.8,
    ambient_sound: "call-center" as const,
    ambient_sound_volume: 0.3,
    max_call_duration_ms: 300000, // 5 minutes
    end_call_after_silence_ms: 20000, // 20s silence
    boosted_keywords: [
      "SafetySpect",
      "OSHA",
      "fire inspection",
      "electrical inspection",
      "environmental inspection",
      "comprehensive inspection",
    ],
    normalize_for_speech: true,
    opt_out_sensitive_data_storage: false,
  };

  let agentId: string;

  if (EXISTING_AGENT_ID) {
    console.log(`  Updating existing agent: ${EXISTING_AGENT_ID}`);
    const updated = await client.agent.update(EXISTING_AGENT_ID, agentBody);
    agentId = updated.agent_id;
    console.log(`  ✓ Agent updated: ${agentId}`);
  } else {
    const created = await client.agent.create(agentBody);
    agentId = created.agent_id;
    console.log(`  ✓ Agent created: ${agentId}`);
  }

  // ── Output summary ──
  console.log("\n" + "=".repeat(60));
  console.log("SafetySpect Demo Booker — Retell Setup Complete");
  console.log("=".repeat(60));
  console.log(`\nLLM ID:    ${llmId}`);
  console.log(`Agent ID:  ${agentId}`);
  console.log(`Backend:   ${BACKEND_URL}`);
  console.log(`\nTools:`);
  TOOLS.forEach((t) => {
    console.log(`  ${t.name} → ${t.url || "(built-in)"}`);
  });
  if (mcps.length > 0) {
    console.log(`\nMCPs:`);
    mcps.forEach((m) => {
      console.log(`  ${m.name} → ${m.url}`);
    });
  } else {
    console.log(`\nMCPs: none (set GOOGLE_CALENDAR_MCP_URL to enable)`);
  }
  console.log(
    `\nAdd to .env:\n  RETELL_AGENT_ID=${agentId}\n  RETELL_LLM_ID=${llmId}`
  );
  console.log();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});

export {};
