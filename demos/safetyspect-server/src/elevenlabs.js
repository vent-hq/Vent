import { Router } from "express";
import {
  sql, normalizePhone, fuzzyNameMatch, VALID_TYPES,
  isWeekend, isPast, generateSlots, todayUTC,
} from "./db.js";

const router = Router();

function log(route, reqId, msg, data) {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${ts}] [elevenlabs/${route}] ${msg} req=${reqId}`, typeof data === "string" ? data : JSON.stringify(data));
  } else {
    console.log(`[${ts}] [elevenlabs/${route}] ${msg} req=${reqId}`);
  }
}

// ─── POST /elevenlabs/lookup_customer ───

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
    let matches = [];

    if (phone) {
      const norm = normalizePhone(phone);
      matches = customers.filter((c) => normalizePhone(c.phone) === norm);
    }
    if (matches.length === 0 && name) {
      matches = customers.filter((c) => fuzzyNameMatch(name, c.name));
    }
    if (matches.length === 0 && company) {
      const q = company.toLowerCase();
      matches = customers.filter((c) => c.company.toLowerCase().includes(q));
    }

    if (matches.length === 0) {
      log("lookup_customer", rid, "FAIL: no matches found");
      return res.json({ error: "No customer found matching that information" });
    }

    const c = matches[0];

    const upcoming = await sql.unsafe("SELECT * FROM inspections WHERE customer_id = $1 AND status = 'confirmed' ORDER BY date", [c.id]);

    const history = await sql.unsafe("SELECT * FROM inspection_history WHERE customer_id = $1 ORDER BY date DESC", [c.id]);

    log("lookup_customer", rid, `SUCCESS: found customer id=${c.id} name="${c.name}"`);
    res.json({
      found: true,
      customer: {
        id: c.id,
        name: c.name,
        phone: c.phone,
        company: c.company,
        plan: c.plan,
        address: c.address,
      },
      upcoming_inspections: upcoming,
      inspection_history: history,
    });
  } catch (err) {
    log("lookup_customer", rid, `EXCEPTION: ${err.message}`);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

// ─── POST /elevenlabs/check_availability ───

router.post("/check_availability", async (req, res) => {
  const rid = req._reqId;
  try {
    const { date, inspection_type } = req.body || {};
    log("check_availability", rid, `date="${date}" type="${inspection_type}"`);

    if (!date || !inspection_type) {
      return res.json({ error: "Both date and inspection_type are required." });
    }

    if (!VALID_TYPES.includes(inspection_type)) {
      return res.json({ error: `Invalid inspection type. Must be one of: ${VALID_TYPES.join(", ")}` });
    }

    if (isPast(date)) {
      return res.json({ error: "past_date", message: `${date} is in the past.`, today: todayUTC() });
    }

    if (isWeekend(date)) {
      return res.json({ error: "weekend", message: `${date} is a weekend. Inspections are weekdays only.` });
    }

    const slots = await generateSlots(date, inspection_type);
    log("check_availability", rid, `SUCCESS: ${slots.length} slots`, slots);
    res.json({
      date,
      inspection_type,
      available_slots: slots,
      total_available: slots.length,
      note: slots.length <= 1 ? "Limited availability - book soon!" : undefined,
    });
  } catch (err) {
    log("check_availability", rid, `EXCEPTION: ${err.message}`);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

// ─── POST /elevenlabs/book_inspection ───

router.post("/book_inspection", async (req, res) => {
  const rid = req._reqId;
  try {
    const { customer_id, date, time_slot, inspection_type, notes } = req.body || {};
    log("book_inspection", rid, "params:", { customer_id, date, time_slot, inspection_type });

    if (!customer_id || !date || !time_slot || !inspection_type) {
      const missing = [!customer_id && "customer_id", !date && "date", !time_slot && "time_slot", !inspection_type && "inspection_type"].filter(Boolean);
      return res.json({ error: `Missing required fields: ${missing.join(", ")}` });
    }

    const customer = (await sql.unsafe("SELECT * FROM customers WHERE id = $1", [customer_id]))[0];
    if (!customer) {
      return res.json({ error: `Customer ${customer_id} not found. Use lookup_customer first.` });
    }

    if (!VALID_TYPES.includes(inspection_type)) {
      return res.json({ error: `Invalid inspection type. Must be one of: ${VALID_TYPES.join(", ")}` });
    }

    if (isPast(date)) {
      return res.json({ error: "past_date", message: `${date} is in the past.`, today: todayUTC() });
    }

    if (isWeekend(date)) {
      return res.json({ error: "weekend", message: `${date} is a weekend. Inspections are weekdays only.` });
    }

    const existing = (await sql.unsafe("SELECT * FROM inspections WHERE date = $1 AND time_slot = $2 AND status = 'confirmed'", [date, time_slot]))[0];

    if (existing) {
      return res.json({ error: "That time slot is already booked. Please choose a different slot." });
    }

    const [{ id: bookingId }] = await sql`SELECT 'B' || lpad(nextval('booking_ids')::text, 6, '0') AS id`;

    await sql.unsafe("INSERT INTO inspections (id, customer_id, type, date, time_slot, status, notes) VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)", [bookingId, customer_id, inspection_type, date, time_slot, notes || null]);

    log("book_inspection", rid, `SUCCESS: booked ${bookingId}`);
    res.json({
      success: true,
      booking: {
        id: bookingId,
        customer_name: customer.name,
        company: customer.company,
        inspection_type,
        date,
        time_slot,
        status: "confirmed",
      },
      confirmation: `Booking ${bookingId} confirmed. This is a demo booking; no SMS was sent.`,
    });
  } catch (err) {
    log("book_inspection", rid, `EXCEPTION: ${err.message}`);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

// ─── POST /elevenlabs/cancel_inspection ───

router.post("/cancel_inspection", async (req, res) => {
  const rid = req._reqId;
  try {
    const { booking_id, reason } = req.body || {};
    log("cancel_inspection", rid, `booking_id="${booking_id}"`);

    if (!booking_id) {
      return res.json({ error: "booking_id is required." });
    }

    const booking = (await sql.unsafe("SELECT i.*, c.name as customer_name, c.phone FROM inspections i JOIN customers c ON i.customer_id = c.id WHERE i.id = $1", [booking_id]))[0];

    if (!booking) {
      return res.json({ error: `Booking ${booking_id} not found.` });
    }

    if (booking.status === "cancelled") {
      return res.json({ error: `Booking ${booking_id} is already cancelled.` });
    }

    const now = new Date();
    const bookingDate = new Date(booking.date + "T" + booking.time_slot.split("-")[0] + ":00");
    const hoursUntil = (bookingDate - now) / (1000 * 60 * 60);
    const lateFee = hoursUntil < 24 && hoursUntil > 0;

    await sql.unsafe("UPDATE inspections SET status = 'cancelled' WHERE id = $1", [booking_id]);

    log("cancel_inspection", rid, `SUCCESS: cancelled ${booking_id}, late_fee=${lateFee}`);
    res.json({
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
    });
  } catch (err) {
    log("cancel_inspection", rid, `EXCEPTION: ${err.message}`);
    res.json({ error: `Internal error: ${err.message}` });
  }
});

export default router;
