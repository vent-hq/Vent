#!/usr/bin/env npx tsx
/**
 * Sets up the SafetySpect Demo Booker on Bland AI.
 *
 * Creates a Conversational Pathway and a Persona that wraps it.
 * The persona controls voice, model, interruption settings, etc.
 * The pathway handles the conversation flow (lookup, availability,
 * booking, cancellation) via webhook nodes.
 *
 * Usage:
 *   BLAND_API_KEY=sk-xxx npx tsx scripts/setup-bland-pathway.ts
 *
 * Requires:
 *   - BLAND_API_KEY environment variable
 *   - BACKEND_URL (optional, defaults to https://vent-demo-backend.fly.dev)
 *   - BLAND_PERSONA_ID (optional, updates existing persona instead of creating)
 */

import { readFileSync } from "fs";

// Load .env file
for (const envFile of [".env.local", ".env"]) {
  try {
    const content = readFileSync(envFile, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1].trim()]) {
        process.env[match[1].trim()] = match[2].trim();
      }
    }
  } catch {}
}

const API_KEY = process.env["BLAND_API_KEY"];
if (!API_KEY) {
  console.error("Error: BLAND_API_KEY environment variable is required");
  process.exit(1);
}

const BACKEND_URL = process.env["BACKEND_URL"] ?? "https://vent-demo-backend.fly.dev";
const BLAND_API = "https://api.bland.ai/v1";

async function bland(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BLAND_API}${path}`, {
    method,
    headers: {
      authorization: API_KEY!,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bland API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── Pathway nodes ────────────────────────────────────────────

const nodes = [
  {
    id: "greeting",
    type: "Default",
    data: {
      name: "Greeting",
      isStart: true,
      prompt: `You are Elliot, an AI receptionist for SafetySpect, a safety inspection company.

Say EXACTLY this greeting and nothing else: "Hi, thanks for calling SafetySpect! My name is Elliot. How can I help you today?"

Do NOT say anything else. Do NOT ask follow-up questions. Just deliver the greeting and wait for the caller to respond.

After the caller responds, extract their intent and route them immediately. NEVER repeat the greeting or ask "How can I help you?" again.`,
      extractVars: [
        ["caller_intent", "string", "What the caller wants: lookup, availability, booking, cancellation, or general question"],
        ["inspection_type", "string", "Extract ONLY the single keyword: fire, electrical, osha, environmental, or comprehensive. Do NOT include the word 'inspection'. Example: caller says 'fire inspection' → extract 'fire'. Otherwise null."],
        ["lookup_phone", "string", "The caller's phone number if provided"],
        ["lookup_name", "string", "The caller's full name if provided"],
        ["lookup_company", "string", "The caller's company name if provided"],
      ],
    },
  },

  // ── Lookup Customer ──
  {
    id: "ask_lookup_info",
    type: "Default",
    data: {
      name: "Ask Lookup Info",
      prompt: `Extract the caller's identifying information from the conversation so far — their name, phone, and/or company.

Say ONLY: "Let me look you up." Do not ask for more information — proceed with whatever you have.`,
      extractVars: [
        ["lookup_phone", "string", "The caller's phone number if provided at any point in the conversation"],
        ["lookup_name", "string", "The caller's full name if provided at any point in the conversation"],
        ["lookup_company", "string", "The caller's company name if provided at any point in the conversation"],
      ],
    },
  },
  {
    id: "webhook_lookup_customer",
    type: "Webhook",
    data: {
      name: "Lookup Customer",
      text: "Looking up your account now. One moment please.",
      url: `${BACKEND_URL}/bland/lookup_customer`,
      method: "POST",
      body: `{ "phone": "{{lookup_phone}}", "name": "{{lookup_name}}", "company": "{{lookup_company}}" }`,
      responseData: [
        { name: "customer_id", data: "$.customer.id", context: "The customer's ID" },
        { name: "customer_name", data: "$.customer.name", context: "The customer's name" },
        { name: "customer_company", data: "$.customer.company", context: "The customer's company" },
        { name: "customer_phone", data: "$.customer.phone", context: "The customer's phone" },
        { name: "customer_email", data: "$.customer.email", context: "The customer's email" },
        { name: "lookup_error", data: "$.error", context: "Error message if customer not found" },
      ],
      responsePathways: [
        ["customer_id", "!=", "null", { id: "ask_availability_date", name: "Ask Availability Date" }],
        ["lookup_error", "!=", "null", { id: "ask_lookup_info", name: "Ask Lookup Info" }],
      ],
    },
  },

  // ── Check Availability ──
  {
    id: "ask_availability_date",
    type: "Default",
    data: {
      name: "Ask Availability Date",
      prompt: `If availability_error is set, tell the caller: "I'm sorry, there are no available slots on that date. Would you like to try a different date?"

Otherwise, if the caller has ALREADY mentioned a date (like "next Thursday") in a previous turn, extract it now and say ONLY: "Let me check <the day they mentioned> for you." For example: "Let me check next Monday for you." Say it exactly once, then stop — do NOT repeat yourself, and do NOT say the YYYY-MM-DD format out loud.

If the caller has NOT mentioned a date yet, ask: "What date are you looking at for the inspection?"

Inspections are only available on weekdays (Monday–Friday). If they mention a weekend, say: "We only do inspections on weekdays. Could you pick a weekday instead?"

IMPORTANT: Convert relative dates to YYYY-MM-DD format internally. "Next Thursday" from 2026-03-26 = 2026-04-02. Extract the date but do NOT say the YYYY-MM-DD format out loud.

If you don't yet know the inspection type, also ask: "And what type of inspection do you need — fire, electrical, OSHA, environmental, or comprehensive?"`,
      extractVars: [
        ["availability_date", "string", "The date in YYYY-MM-DD format. Convert relative dates like 'next Thursday' to actual dates."],
        ["inspection_type", "string", "Extract ONLY the single keyword: fire, electrical, osha, environmental, or comprehensive. Do NOT include the word 'inspection'. Keep previous value ({{inspection_type}}) if already set and caller didn't change it."],
      ],
    },
  },
  {
    id: "webhook_check_availability",
    type: "Webhook",
    data: {
      name: "Check Availability",
      text: "Checking available time slots now. This may take a moment.",
      url: `${BACKEND_URL}/bland/check_availability`,
      method: "POST",
      body: `{ "date": "{{availability_date}}" }`,
      responseData: [
        { name: "available_slots", data: "$.slots", context: "Available 2-hour inspection time slots" },
        { name: "availability_error", data: "$.error", context: "Error message if date is invalid" },
      ],
      responsePathways: [
        ["available_slots", "!=", "null", { id: "confirm_booking", name: "Confirm Booking" }],
        ["availability_error", "!=", "null", { id: "ask_availability_date", name: "Ask Availability Date" }],
      ],
    },
  },
  // availability_result removed — webhook node now speaks the result directly

  // ── Confirm Booking (picks slot if needed, then confirms) ──
  {
    id: "confirm_booking",
    type: "Default",
    data: {
      name: "Confirm Booking",
      prompt: `The available slots are: {{available_slots}}

If the caller just told you which slot they want, extract it and confirm.
If they said "the earliest" or "the first one", pick the first slot from the list.
If they haven't picked a slot yet, ask: "Which slot would you like?"

Once you know the slot, confirm:
"Just to confirm — I'll book a {{inspection_type}} inspection for {{customer_name}} on [date spoken naturally] from [start time] to [end time]. Sound good?"

TTS pronunciation rules:
- Say dates naturally: "Thursday, March twenty-sixth" NOT "2026-03-26"
- Say the inspection type naturally: "fire inspection" not "fire"
- Say times naturally: "8 AM to 10 AM" NOT "8:00 AM - 10:00 AM"
- NEVER read raw date formats like YYYY-MM-DD out loud

Wait for the caller to confirm before proceeding.`,
      extractVars: [
        ["selected_slot", "string", "The FULL time range they selected, copied exactly from the available_slots list. Must be in format like '8:00 AM - 10:00 AM'. If they say 'the earliest' or 'the first one', use the first slot. Otherwise null if they haven't picked yet."],
        ["booking_confirmed", "string", "Whether the caller confirmed they want to book: yes or no. Only 'yes' if they explicitly confirmed after hearing the summary."],
      ],
    },
  },

  // ── Book Inspection ──
  // Webhook just fires the request and says "one moment". A separate Default node
  // (booking_result) speaks the confirmation — the caller's utterance during the webhook
  // ("thank you", "I'll wait", etc.) ensures the Default node won't go silent.
  {
    id: "webhook_book_inspection",
    type: "Webhook",
    data: {
      name: "Book Inspection",
      text: "Booking your inspection now. One moment please.",
      url: `${BACKEND_URL}/bland/book_inspection`,
      method: "POST",
      body: `{ "customer_id": "{{customer_id}}", "type": "{{inspection_type}}", "date": "{{availability_date}}", "slot": "{{selected_slot}}" }`,
      responseData: [
        { name: "booking_id", data: "$.booking.id", context: "The booking confirmation ID" },
        { name: "booking_id_spoken", data: "$.booking.id_spoken", context: "TTS-friendly booking ID (e.g., 'B zero zero 4')" },
        { name: "booking_confirmation", data: "$.booking.summary", context: "Booking confirmation details" },
        { name: "booking_error", data: "$.error", context: "Error if booking failed" },
      ],
      responsePathways: [
        ["booking_id", "!=", "null", { id: "booking_result", name: "Booking Result" }],
        ["booking_error", "!=", "null", { id: "ask_availability_date", name: "Ask Availability Date" }],
      ],
    },
  },
  {
    id: "booking_result",
    type: "Default",
    data: {
      name: "Booking Result",
      prompt: `You MUST speak the booking result to the caller. Check the variables and respond:

If booking_id has a value (like "B004") AND booking_error is empty/null:
Say: "Great news! Your inspection has been booked. {{booking_confirmation}}. Your confirmation ID is {{booking_id_spoken}}. Is there anything else I can help you with?"

If booking_error has a value:
Say: "I'm sorry, there was an issue — {{booking_error}}. Would you like to try a different time slot?"

TTS rules:
- Say dates naturally: "April first" not "2026-04-01"
- Say times naturally: "8 AM to 10 AM" not "8:00 AM - 10:00 AM"
- Use {{booking_id_spoken}} for the booking ID — it's already formatted for speech

IMPORTANT: You MUST deliver the confirmation or error. Do NOT skip it. Do NOT just say goodbye.`,
    },
  },

  // ── Cancel Inspection ──
  {
    id: "ask_cancellation_info",
    type: "Default",
    data: {
      name: "Ask Cancellation Info",
      prompt: `If the caller already provided a booking or confirmation ID, extract it and proceed immediately. Say: "I can help with that."

If they haven't provided an ID yet, ask: "I can help with that. What's your booking or confirmation ID?"

Do NOT mention cancellation fees here — wait until the cancellation result comes back.`,
      extractVars: [
        ["cancel_booking_id", "string", "The booking ID to cancel"],
      ],
    },
  },
  {
    id: "webhook_cancel_inspection",
    type: "Webhook",
    data: {
      name: "Cancel Inspection",
      text: "Processing the cancellation now. One moment please.",
      url: `${BACKEND_URL}/bland/cancel_inspection`,
      method: "POST",
      body: `{ "booking_id": "{{cancel_booking_id}}" }`,
      responseData: [
        { name: "cancel_result", data: "$.message", context: "Cancellation result message" },
        { name: "late_fee", data: "$.late_fee", context: "Whether a $50 late fee was applied" },
        { name: "cancel_error", data: "$.error", context: "Error if cancellation failed" },
      ],
      responsePathways: [
        ["cancel_result", "!=", "null", { id: "cancellation_result", name: "Cancellation Result" }],
        ["cancel_error", "!=", "null", { id: "ask_cancellation_info", name: "Ask Cancellation Info" }],
      ],
    },
  },
  {
    id: "cancellation_result",
    type: "Default",
    data: {
      name: "Cancellation Result",
      prompt: `You MUST speak the cancellation result to the caller. Check the variables and respond:

If cancel_result has a value AND cancel_error is empty/null:
Say: "{{cancel_result}}"
If late_fee is true, add: "Please note, a $50 late cancellation fee has been applied since this was within 24 hours of the inspection."
Then ask: "Is there anything else I can help you with?"

If cancel_error has a value:
Say: "I'm sorry, there was an issue — {{cancel_error}}. Could you double-check the booking ID?"

IMPORTANT: You MUST deliver the result. Do NOT skip it. Do NOT just say goodbye.`,
    },
  },

  // ── End Call ──
  {
    id: "end_call",
    type: "End Call",
    data: {
      name: "End Call",
      prompt: "Thank the caller for choosing SafetySpect. Say goodbye warmly: 'Thanks for calling SafetySpect! Have a great day.'",
    },
  },

  // ── Global FAQ ──
  {
    id: "faq_handler",
    type: "Default",
    data: {
      name: "General Questions",
      isGlobal: true,
      globalLabel: "Caller asks a general question or goes off-topic",
      prompt: `Answer general questions about SafetySpect:
- We offer fire, electrical, OSHA, environmental, and comprehensive safety inspections
- Inspections are 2-hour slots on weekdays only
- Cancellations within 24 hours incur a $50 late fee
- Our inspectors are certified professionals
For anything you can't answer, offer to transfer them or take a message.`,
    },
  },
];

// ── Pathway edges ────────────────────────────────────────────

const edges = [
  // ── Greeting ──
  { id: "e_greeting_webhook", source: "greeting", target: "webhook_lookup_customer", label: "Caller wants to book, schedule, or check availability AND has already provided their name, phone, or company" },
  { id: "e_greeting_lookup", source: "greeting", target: "ask_lookup_info", label: "Caller wants to book or check availability but has NOT provided any identifying info yet" },
  { id: "e_greeting_cancel", source: "greeting", target: "ask_cancellation_info", label: "Caller wants to cancel an inspection" },

  // ── Lookup flow ──
  // responsePathways on the webhook handle routing based on response (customer found → availability, error → retry)
  { id: "e_askinfo_lookup", source: "ask_lookup_info", target: "webhook_lookup_customer", label: "The caller has provided their name, phone number, or company name" },

  // ── Availability flow ──
  // responsePathways on the webhook handle routing (slots found → confirm, error → retry date)
  { id: "e_date_check", source: "ask_availability_date", target: "webhook_check_availability", label: "Caller provided a date" },

  // ── Confirm booking flow ──
  { id: "e_confirm_book", source: "confirm_booking", target: "webhook_book_inspection", label: "Caller confirmed the booking" },
  { id: "e_confirm_different", source: "confirm_booking", target: "webhook_check_availability", label: "Caller wants a different slot — re-check availability" },
  { id: "e_confirm_newdate", source: "confirm_booking", target: "ask_availability_date", label: "Caller wants a different date" },
  { id: "e_confirm_end", source: "confirm_booking", target: "end_call", label: "Caller changed their mind and does not want to book" },

  // ── Booking flow ──
  // responsePathways on the webhook handle routing (success → booking_result, error → retry availability)
  { id: "e_result_end", source: "booking_result", target: "end_call", label: "Caller says goodbye or has nothing else they need" },
  { id: "e_result_more", source: "booking_result", target: "greeting", label: "Caller wants to do something else" },

  // ── Cancellation flow ──
  { id: "e_cancelinfo_cancel", source: "ask_cancellation_info", target: "webhook_cancel_inspection", label: "Caller provided booking ID" },
  // responsePathways on the webhook handle routing (success → cancellation_result, error → retry)
  { id: "e_cancel_end", source: "cancellation_result", target: "end_call", label: "Caller says goodbye or has nothing else they need" },
  { id: "e_cancel_more", source: "cancellation_result", target: "greeting", label: "Caller wants to do something else" },
];

// ── Persona config ──────────────────────────────────────────

const PERSONA_NAME = "SafetySpect Demo Booker";

// ── Main ─────────────────────────────────────────────────────

async function main() {
  // ── Step 1: Create or update the pathway ──
  const existingPathwayId = process.env["BLAND_PATHWAY_ID"] ?? process.env["BLAND_AGENT_ID"];

  let pathwayId: string;
  if (existingPathwayId) {
    console.log(`Updating existing pathway: ${existingPathwayId}\n`);
    pathwayId = existingPathwayId;
  } else {
    console.log("Creating new SafetySpect pathway on Bland AI...\n");
    const createRes = await bland("POST", "/pathway/create", {
      name: PERSONA_NAME,
      description: "Safety inspection booking agent with customer lookup, availability checking, booking, and cancellation via webhook tools.",
    });

    pathwayId = createRes.data?.pathway_id ?? createRes.pathway_id;
    if (!pathwayId) {
      console.error("Failed to create pathway:", JSON.stringify(createRes, null, 2));
      process.exit(1);
    }

    console.log(`Pathway created: ${pathwayId}`);
  }

  // ── Step 2: Update pathway with nodes and edges ──
  const updateRes = await fetch(`${BLAND_API}/pathway/${pathwayId}`, {
    method: "POST",
    headers: {
      authorization: API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ nodes, edges }),
  });

  if (!updateRes.ok) {
    const text = await updateRes.text();
    console.error(`Failed to update pathway (${updateRes.status}): ${text}`);
    process.exit(1);
  }

  console.log("Pathway updated with nodes and edges.\n");

  // ── Step 3: Create or update the persona ──
  const existingPersonaId = process.env["BLAND_PERSONA_ID"];

  const personaBody = {
    name: PERSONA_NAME,
    description: "SafetySpect safety inspection scheduling assistant. Books, reschedules, and cancels inspections via conversational pathway.",
    call_config: {
      voice: "nat",
      record: true,
      language: "en",
      max_duration: 5,
      wait_for_greeting: false,
      interruption_threshold: 400,
    },
    pathway_conditions: [
      {
        name: "Default",
        prompt: "Use this pathway for all calls.",
        pathway_id: pathwayId,
        pathway_version: "production",
        start_node_id: "greeting",
      },
    ],
  };

  let personaId: string;
  if (existingPersonaId) {
    console.log(`Updating existing persona: ${existingPersonaId}`);
    const patchRes = await bland("PATCH", `/personas/${existingPersonaId}`, personaBody);
    personaId = patchRes.id ?? patchRes.persona?.id ?? existingPersonaId;
    console.log(`  ✓ Persona draft updated: ${personaId}`);
    // Promote draft to production so changes take effect immediately
    await bland("POST", `/personas/${personaId}/versions/promote`, {});
    console.log(`  ✓ Persona promoted to production\n`);
  } else {
    console.log("Creating new persona...");
    const createRes = await bland("POST", "/personas", personaBody);
    personaId = createRes.id ?? createRes.data?.id ?? createRes.persona?.id;
    if (!personaId) {
      console.error("Failed to create persona:", JSON.stringify(createRes, null, 2));
      process.exit(1);
    }
    console.log(`  ✓ Persona created: ${personaId}\n`);
  }

  // ── Output summary ──
  console.log("=".repeat(60));
  console.log("SafetySpect Demo Booker — Bland AI Setup Complete");
  console.log("=".repeat(60));
  console.log(`\nPathway ID:  ${pathwayId}`);
  console.log(`Persona ID:  ${personaId}`);
  console.log(`Backend:     ${BACKEND_URL}`);
  console.log(`\nWebhook endpoints needed on backend:`);
  console.log(`  POST ${BACKEND_URL}/bland/lookup_customer`);
  console.log(`  POST ${BACKEND_URL}/bland/check_availability`);
  console.log(`  POST ${BACKEND_URL}/bland/book_inspection`);
  console.log(`  POST ${BACKEND_URL}/bland/cancel_inspection`);
  console.log(`\nAdd to your .env:`);
  console.log(`  BLAND_PERSONA_ID=${personaId}`);
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});

export {};
