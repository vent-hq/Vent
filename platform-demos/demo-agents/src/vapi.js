import { Router } from "express";
import {
  sql, normalizePhone, fuzzyNameMatch, VALID_TYPES,
  isWeekend, isPast, generateSlots, todayUTC,
} from "./db.js";

const router = Router();

// ─── Tool Handlers ───

async function lookupCustomer(params) {
  const { phone, name, company } = params;

  if (!phone && !name && !company) {
    return { error: "At least one of phone, name, or company is required." };
  }

  let customers = await sql.unsafe("SELECT * FROM customers");
  let matches = [];

  if (phone) {
    const norm = normalizePhone(phone);
    matches = customers.filter((c) => normalizePhone(c.phone) === norm);
  } else if (name) {
    matches = customers.filter((c) => fuzzyNameMatch(name, c.name));
  } else if (company) {
    const q = company.toLowerCase();
    matches = customers.filter((c) => c.company.toLowerCase().includes(q));
  }

  if (matches.length === 0) {
    return { found: false, message: "No customer found matching the provided information.", suggestion: "Try searching by a different field (phone, name, or company). If this is a new customer, let them know they need to contact SafetySpect to set up an account." };
  }

  const customer = matches[0];

  const upcoming = await sql.unsafe("SELECT * FROM inspections WHERE customer_id = $1 AND status = 'confirmed' ORDER BY date", [customer.id]);

  const history = await sql.unsafe("SELECT * FROM inspection_history WHERE customer_id = $1 ORDER BY date DESC", [customer.id]);

  return {
    found: true,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      company: customer.company,
      plan: customer.plan,
      address: customer.address,
    },
    upcoming_inspections: upcoming,
    inspection_history: history,
  };
}

async function checkAvailability(params) {
  const { date, inspection_type } = params;

  if (!date || !inspection_type) {
    return { error: "Both date and inspection_type are required." };
  }

  if (!VALID_TYPES.includes(inspection_type)) {
    return { error: `Invalid inspection type. Must be one of: ${VALID_TYPES.join(", ")}` };
  }

  if (isPast(date)) {
    return { error: "past_date", message: `${date} is in the past.`, today: todayUTC(), suggestion: "Ask the caller for a future date. Do not retry with the same date." };
  }

  if (isWeekend(date)) {
    return { error: "weekend", message: `${date} is a weekend.`, suggestion: "Inspections are weekdays only (Mon-Fri). Ask the caller for a weekday. Do not retry with the same date." };
  }

  const slots = await generateSlots(date, inspection_type);

  return {
    date,
    inspection_type,
    available_slots: slots,
    total_available: slots.length,
    note: slots.length <= 1 ? "Limited availability - book soon!" : undefined,
  };
}

async function bookInspection(params) {
  const { customer_id, date, time_slot, inspection_type, notes } = params;

  if (!customer_id || !date || !time_slot || !inspection_type) {
    return { error: "customer_id, date, time_slot, and inspection_type are all required." };
  }

  const customer = (await sql.unsafe("SELECT * FROM customers WHERE id = $1", [customer_id]))[0];
  if (!customer) {
    return { error: "customer_not_found", message: `Customer ${customer_id} not found.`, suggestion: "Use lookup_customer first to find the correct customer ID." };
  }

  if (!VALID_TYPES.includes(inspection_type)) {
    return { error: "invalid_type", message: `Invalid inspection type.`, valid_types: VALID_TYPES, suggestion: "Ask the caller which type they need." };
  }

  if (isPast(date)) {
    return { error: "past_date", message: `${date} is in the past.`, today: todayUTC(), suggestion: "Ask the caller for a future date. Do not retry with the same date." };
  }

  if (isWeekend(date)) {
    return { error: "weekend", message: `${date} is a weekend.`, suggestion: "Inspections are weekdays only (Mon-Fri). Ask the caller for a weekday." };
  }

  const existing = (await sql.unsafe("SELECT * FROM inspections WHERE date = $1 AND time_slot = $2 AND status = 'confirmed'", [date, time_slot]))[0];

  if (existing) {
    return { error: "That time slot is already booked. Please choose a different slot." };
  }

  const [{ id: bookingId }] = await sql`SELECT 'B' || lpad(nextval('booking_ids')::text, 6, '0') AS id`;

  await sql.unsafe("INSERT INTO inspections (id, customer_id, type, date, time_slot, status, notes) VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)", [bookingId, customer_id, inspection_type, date, time_slot, notes || null]);

  return {
    success: true,
    booking: {
      id: bookingId,
      customer_name: customer.name,
      company: customer.company,
      inspection_type,
      date,
      time_slot,
      status: "confirmed",
      notes: notes || null,
    },
    confirmation: `Booking ${bookingId} confirmed. This is a demo booking; no SMS was sent.`,
  };
}

async function cancelInspection(params) {
  const { booking_id, reason } = params;

  if (!booking_id) {
    return { error: "booking_id is required." };
  }

  const booking = (await sql.unsafe("SELECT i.*, c.name as customer_name, c.phone FROM inspections i JOIN customers c ON i.customer_id = c.id WHERE i.id = $1", [booking_id]))[0];

  if (!booking) {
    return { error: "booking_not_found", message: `Booking ${booking_id} not found.`, suggestion: "Verify the booking ID with the caller, or use lookup_customer to find their active bookings." };
  }

  if (booking.status === "cancelled") {
    return { error: "already_cancelled", message: `Booking ${booking_id} is already cancelled.`, suggestion: "Let the caller know it's already cancelled. Ask if they'd like to schedule a new inspection instead." };
  }

  const now = new Date();
  const bookingDate = new Date(booking.date + "T" + booking.time_slot.split("-")[0] + ":00");
  const hoursUntil = (bookingDate - now) / (1000 * 60 * 60);
  const lateFee = hoursUntil < 24 && hoursUntil > 0;

  await sql.unsafe("UPDATE inspections SET status = 'cancelled' WHERE id = $1", [booking_id]);

  return {
    success: true,
    cancelled_booking: {
      id: booking_id,
      customer_name: booking.customer_name,
      inspection_type: booking.type,
      date: booking.date,
      time_slot: booking.time_slot,
    },
    late_fee: lateFee ? "$50.00 late cancellation fee applies (within 24 hours of scheduled time)" : "No late fee",
    reason: reason || "No reason provided",
  };
}

// ─── Vapi Webhook Endpoint ───

router.post("/", async (req, res) => {
  const message = req.body?.message;

  if (!message || message.type !== "tool-calls") {
    return res.json({ results: [] });
  }

  const toolCalls = message.toolCallList || [];
  const results = [];

  for (const call of toolCalls) {
    // Handle both Vapi formats: call.function.name or call.name
    const toolName = call.function?.name || call.name;
    const params = call.function?.arguments
      ? (typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments)
      : (call.parameters || {});

    let result;
    try {
      switch (toolName) {
        case "lookup_customer":
          result = await lookupCustomer(params);
          break;
        case "check_availability":
          result = await checkAvailability(params);
          break;
        case "book_inspection":
          result = await bookInspection(params);
          break;
        case "cancel_inspection":
          result = await cancelInspection(params);
          break;
        default:
          result = { error: `Unknown tool: ${toolName}` };
      }
    } catch (err) {
      result = { error: `Internal error: ${err.message}` };
    }

    const resultStr = JSON.stringify(result).replace(/\n/g, " ");
    results.push({ toolCallId: call.id, result: resultStr });
  }

  res.json({ results });
});

router.get("/", (_req, res) => res.json({ status: "ok", service: "safetyspect-server" }));

// ─── Direct REST endpoints for Vapi apiRequest tools ───

router.post("/lookup_customer", async (req, res) => {
  try {
    const result = await lookupCustomer(req.body || {});
    res.json(result);
  } catch (err) {
    res.json({ error: `Internal error: ${err.message}` });
  }
});

router.post("/check_availability", async (req, res) => {
  try {
    const result = await checkAvailability(req.body || {});
    res.json(result);
  } catch (err) {
    res.json({ error: `Internal error: ${err.message}` });
  }
});

router.post("/book_inspection", async (req, res) => {
  try {
    const result = await bookInspection(req.body || {});
    res.json(result);
  } catch (err) {
    res.json({ error: `Internal error: ${err.message}` });
  }
});

router.post("/cancel_inspection", async (req, res) => {
  try {
    const result = await cancelInspection(req.body || {});
    res.json(result);
  } catch (err) {
    res.json({ error: `Internal error: ${err.message}` });
  }
});

export default router;
