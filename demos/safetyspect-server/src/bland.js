import { Router } from "express";
import {
  sql, normalizePhone, fuzzyNameMatch, VALID_TYPES,
  isWeekend, isPast, generateSlots, todayUTC,
} from "./db.js";

const router = Router();

function log(route, reqId, msg, data) {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${ts}] [bland/${route}] ${msg} req=${reqId}`, typeof data === "string" ? data : JSON.stringify(data));
  } else {
    console.log(`[${ts}] [bland/${route}] ${msg} req=${reqId}`);
  }
}

// ─── Slot format conversion ───
// Internal: "08:00-10:00" → Bland: "8:00 AM - 10:00 AM"

function to12h(time24) {
  const [h, m] = time24.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function slotToHuman(slot) {
  const [start, end] = slot.split("-");
  return `${to12h(start)} - ${to12h(end)}`;
}

function parse12hTo24h(timeStr) {
  const match = timeStr.trim().match(/^(\d{1,2}):?(\d{2})?\s*(AM|PM)$/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = match[2] || "00";
  const period = match[3].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m}`;
}

function slotFromHuman(humanSlot) {
  // "8:00 AM - 10:00 AM" → "08:00-10:00"
  const parts = humanSlot.split(" - ");
  if (parts.length === 2) {
    return parts.map((t) => {
      const h24 = parse12hTo24h(t);
      return h24 || t;
    }).join("-");
  }
  // Partial time like "9:00 AM" or "9 AM" — try to match against known slots
  return humanSlot;
}

// TTS-friendly booking ID: "B004" → "B zero zero 4"
function spokenBookingId(id) {
  return id.split("").map(c => {
    if (c === "0") return "zero";
    return c;
  }).join(" ");
}

// All possible internal slot formats
const ALL_SLOTS = [
  "08:00-10:00", "10:00-12:00", "12:00-14:00", "14:00-16:00", "15:00-17:00",
  "08:00-12:00", "12:00-16:00", // comprehensive slots
];

function resolveSlot(rawSlot) {
  // First try direct conversion (full range like "8:00 AM - 10:00 AM")
  const direct = slotFromHuman(rawSlot);
  if (direct.match(/^\d{2}:\d{2}-\d{2}:\d{2}$/)) return direct;

  // Partial time — try to match start time against known slots
  const parsed = parse12hTo24h(rawSlot);
  if (parsed) {
    const matched = ALL_SLOTS.find((s) => s.startsWith(parsed));
    if (matched) return matched;
  }

  // Last resort: return as-is
  return direct;
}

// ─── POST /bland/lookup_customer ───

router.post("/lookup_customer", async (req, res) => {
  const rid = req._reqId;
  try {
    const { phone, name, company } = req.body || {};
    log("lookup_customer", rid, "search params:", { phone, name, company });

    if (!phone && !name && !company) {
      log("lookup_customer", rid, "FAIL: no search params provided");
      return res.json({ error: "No customer found matching that information" });
    }

    const customers = await sql.unsafe("SELECT * FROM customers");
    log("lookup_customer", rid, `DB has ${customers.length} customers`);
    let matches = [];

    if (phone) {
      const norm = normalizePhone(phone);
      log("lookup_customer", rid, `searching by phone: raw="${phone}" normalized="${norm}"`);
      matches = customers.filter((c) => normalizePhone(c.phone) === norm);
      log("lookup_customer", rid, `phone matches: ${matches.length}`);
    }
    if (matches.length === 0 && name) {
      log("lookup_customer", rid, `searching by name: "${name}"`);
      matches = customers.filter((c) => fuzzyNameMatch(name, c.name));
      log("lookup_customer", rid, `name matches: ${matches.length}`, matches.map(c => c.name));
    }
    if (matches.length === 0 && company) {
      const q = company.toLowerCase();
      log("lookup_customer", rid, `searching by company: "${q}"`);
      matches = customers.filter((c) => c.company.toLowerCase().includes(q));
      log("lookup_customer", rid, `company matches: ${matches.length}`, matches.map(c => c.company));
    }

    if (matches.length === 0) {
      log("lookup_customer", rid, "FAIL: no matches found across all search methods");
      return res.json({ error: "No customer found matching that information" });
    }

    const c = matches[0];
    log("lookup_customer", rid, `SUCCESS: found customer id=${c.id} name="${c.name}" company="${c.company}"`);
    res.json({
      customer: {
        id: c.id,
        name: c.name,
        company: c.company,
        phone: c.phone,
        email: `${c.name.split(" ")[0].toLowerCase()}@${c.company.toLowerCase().replace(/\s+/g, "")}.com`,
      },
    });
  } catch (err) {
    log("lookup_customer", rid, `EXCEPTION: ${err.message}`, err.stack);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

// ─── POST /bland/check_availability ───

router.post("/check_availability", async (req, res) => {
  const rid = req._reqId;
  try {
    const { date } = req.body || {};
    log("check_availability", rid, `date="${date}"`);

    if (!date) {
      log("check_availability", rid, "FAIL: no date provided");
      return res.json({ error: "Date is required" });
    }

    if (isWeekend(date)) {
      log("check_availability", rid, `FAIL: ${date} is a weekend`);
      return res.json({ error: "Inspections are only available on weekdays (Monday-Friday)" });
    }

    if (isPast(date)) {
      log("check_availability", rid, `FAIL: ${date} is in the past`);
      return res.json({ error: "past_date", message: `${date} is in the past.`, today: todayUTC(), suggestion: "Ask the caller for a future date. Do not retry with the same date." });
    }

    const slots = await generateSlots(date, "fire");
    if (slots.length === 0) {
      log("check_availability", rid, `FAIL: no slots available on ${date}`);
      return res.json({ error: `No available slots on ${date}. Please try a different date.` });
    }
    const humanSlots = slots.map(slotToHuman);
    log("check_availability", rid, `SUCCESS: ${slots.length} slots available`, humanSlots);
    res.json({ slots: humanSlots });
  } catch (err) {
    log("check_availability", rid, `EXCEPTION: ${err.message}`, err.stack);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

// ─── POST /bland/book_inspection ───

router.post("/book_inspection", async (req, res) => {
  const rid = req._reqId;
  try {
    let { customer_id, type, date, slot } = req.body || {};
    // Normalize: "fire inspection" → "fire", "electrical inspection" → "electrical"
    if (type && typeof type === "string") {
      type = type.replace(/\s*inspection\s*/i, "").trim().toLowerCase();
    }
    log("book_inspection", rid, "params:", { customer_id, type, date, slot });

    if (!customer_id || !type || !date || !slot) {
      const missing = [!customer_id && "customer_id", !type && "type", !date && "date", !slot && "slot"].filter(Boolean);
      log("book_inspection", rid, `FAIL: missing fields: ${missing.join(", ")}`);
      return res.json({ error: "customer_id, type, date, and slot are all required" });
    }

    if (!VALID_TYPES.includes(type)) {
      log("book_inspection", rid, `FAIL: invalid type "${type}" — valid: ${VALID_TYPES.join(", ")}`);
      return res.json({ error: `Invalid inspection type. Must be one of: ${VALID_TYPES.join(", ")}` });
    }

    const customer = (await sql.unsafe("SELECT * FROM customers WHERE id = $1", [customer_id]))[0];
    if (!customer) {
      log("book_inspection", rid, `FAIL: customer_id=${customer_id} not found in DB`);
      return res.json({ error: `Customer ${customer_id} not found` });
    }
    log("book_inspection", rid, `customer found: "${customer.name}" (${customer.company})`);

    if (isPast(date)) {
      log("book_inspection", rid, `FAIL: date ${date} is in the past`);
      return res.json({ error: "past_date", message: `${date} is in the past.`, today: todayUTC(), suggestion: "Ask the caller for a future date. Do not retry with the same date." });
    }

    if (isWeekend(date)) {
      log("book_inspection", rid, `FAIL: date ${date} is a weekend`);
      return res.json({ error: "Inspections are only available on weekdays (Monday-Friday)" });
    }

    // Resolve slot: handles full ranges ("8:00 AM - 10:00 AM") and partials ("9:00 AM", "9 AM")
    const internalSlot = resolveSlot(slot);
    log("book_inspection", rid, `slot resolution: "${slot}" → "${internalSlot}"`);

    // Idempotency: if this customer already has a confirmed booking for this date+type+slot, return it
    const duplicateCheck = (await sql.unsafe("SELECT * FROM inspections WHERE customer_id = $1 AND date = $2 AND type = $3 AND time_slot = $4 AND status = 'confirmed'", [customer_id, date, type, internalSlot]))[0];

    if (duplicateCheck) {
      const humanSlot = slotToHuman(duplicateCheck.time_slot);
      log("book_inspection", rid, `IDEMPOTENT: returning existing booking ${duplicateCheck.id} (same customer+date+type)`);
      const d = new Date(date + "T12:00:00");
      const monthNames = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      const formattedDate = `${monthNames[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
      const typeName = type.charAt(0).toUpperCase() + type.slice(1);
      return res.json({
        booking: {
          id: duplicateCheck.id,
          id_spoken: spokenBookingId(duplicateCheck.id),
          summary: `${typeName} inspection booked for ${formattedDate} at ${humanSlot}`,
        },
      });
    }

    const existing = (await sql.unsafe("SELECT * FROM inspections WHERE date = $1 AND time_slot = $2 AND status = 'confirmed'", [date, internalSlot]))[0];

    if (existing) {
      log("book_inspection", rid, `FAIL: slot ${internalSlot} on ${date} already booked by different customer (id=${existing.id})`);
      return res.json({ error: "That time slot is no longer available" });
    }

    const [{ id: bookingId }] = await sql`SELECT 'B' || lpad(nextval('booking_ids')::text, 6, '0') AS id`;

    await sql.unsafe("INSERT INTO inspections (id, customer_id, type, date, time_slot, status) VALUES ($1, $2, $3, $4, $5, 'confirmed')", [bookingId, customer_id, type, date, internalSlot]);

    const d = new Date(date + "T12:00:00");
    const monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    const formattedDate = `${monthNames[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    const typeName = type.charAt(0).toUpperCase() + type.slice(1);
    const humanSlot = slotToHuman(internalSlot);

    log("book_inspection", rid, `SUCCESS: booked ${bookingId} — ${typeName} on ${formattedDate} at ${humanSlot} for customer ${customer_id}`);
    res.json({
      booking: {
        id: bookingId,
        id_spoken: spokenBookingId(bookingId),
        summary: `${typeName} inspection booked for ${formattedDate} at ${humanSlot}`,
      },
    });
  } catch (err) {
    log("book_inspection", rid, `EXCEPTION: ${err.message}`, err.stack);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

// ─── POST /bland/cancel_inspection ───

router.post("/cancel_inspection", async (req, res) => {
  const rid = req._reqId;
  try {
    const { booking_id } = req.body || {};
    log("cancel_inspection", rid, `booking_id="${booking_id}"`);

    if (!booking_id) {
      log("cancel_inspection", rid, "FAIL: no booking_id provided");
      return res.json({ error: "booking_id is required" });
    }

    const booking = (await sql.unsafe("SELECT i.*, c.name as customer_name, c.phone FROM inspections i JOIN customers c ON i.customer_id = c.id WHERE i.id = $1", [booking_id]))[0];

    if (!booking) {
      log("cancel_inspection", rid, `FAIL: booking_id="${booking_id}" not found in DB`);
      const allBookings = await sql.unsafe("SELECT id, status FROM inspections");
      log("cancel_inspection", rid, `existing bookings:`, allBookings);
      return res.json({ error: `No booking found with ID ${booking_id}` });
    }

    log("cancel_inspection", rid, `found booking: customer="${booking.customer_name}" type=${booking.type} date=${booking.date} slot=${booking.time_slot} status=${booking.status}`);

    if (booking.status === "cancelled") {
      log("cancel_inspection", rid, `FAIL: booking ${booking_id} already cancelled`);
      return res.json({ error: `Booking ${booking_id} is already cancelled` });
    }

    const now = new Date();
    const bookingDate = new Date(booking.date + "T" + booking.time_slot.split("-")[0] + ":00");
    const hoursUntil = (bookingDate - now) / (1000 * 60 * 60);
    const lateFee = hoursUntil < 24 && hoursUntil > 0;
    log("cancel_inspection", rid, `hours until booking: ${hoursUntil.toFixed(1)}, late_fee: ${lateFee}`);

    await sql.unsafe("UPDATE inspections SET status = 'cancelled' WHERE id = $1", [booking_id]);

    if (lateFee) {
      log("cancel_inspection", rid, `SUCCESS: cancelled ${booking_id} WITH $50 late fee`);
      res.json({
        message: `Booking ${booking_id} has been cancelled. A $50 late cancellation fee applies.`,
        late_fee: true,
      });
    } else {
      log("cancel_inspection", rid, `SUCCESS: cancelled ${booking_id} (no late fee)`);
      res.json({
        message: `Booking ${booking_id} has been cancelled successfully`,
        late_fee: false,
      });
    }
  } catch (err) {
    log("cancel_inspection", rid, `EXCEPTION: ${err.message}`, err.stack);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

export default router;
