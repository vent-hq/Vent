import test from "node:test";
import assert from "node:assert/strict";

const origin = process.env.DEMO_BACKEND_URL ?? "https://vent-demo-backend.fly.dev";
async function post(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
function futureWeekday(offset) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

test("all provider endpoints read the same seeded PostgreSQL customers", async () => {
  for (const prefix of ["", "/elevenlabs", "/bland", "/retell"]) {
    const result = await post(`${prefix}/lookup_customer`, prefix === "/retell" ? { args: { name: "James Chen" } } : { name: "James Chen" });
    assert.equal(result.customer.id, "C002");
    assert.equal(result.customer.company, "Harbor Logistics");
  }
  const result = await post("/", { message: { type: "tool-calls", toolCallList: [{ id: "lookup-test", function: { name: "lookup_customer", arguments: JSON.stringify({ company: "Harbor Logistics" }) } }] } });
  assert.equal(result.results[0].toolCallId, "lookup-test");
  assert.equal(JSON.parse(result.results[0].result).customer.id, "C002");
});

test("a booking made through ElevenLabs is visible to Retell and cancellable through Bland", async () => {
  const date = futureWeekday(120);
  const available = await post("/elevenlabs/check_availability", { date, inspection_type: "osha" });
  assert.ok(available.available_slots.length);
  const time_slot = available.available_slots[0];
  const booked = await post("/elevenlabs/book_inspection", { customer_id: "C002", date, time_slot, inspection_type: "osha", notes: "Vent integration check" });
  assert.equal(booked.success, true);
  const id = booked.booking.id;
  try {
    const customer = await post("/retell/lookup_customer", { args: { name: "James Chen" } });
    assert.ok(customer.upcoming_inspections.some(row => row.id === id));
    const availability = await post("/check_availability", { date, inspection_type: "osha" });
    assert.ok(!availability.available_slots.includes(time_slot));
  } finally {
    const cancelled = await post("/bland/cancel_inspection", { booking_id: id });
    assert.match(cancelled.message, /cancelled/);
  }
});

test("PostgreSQL prevents concurrent double booking across providers", async () => {
  const date = futureWeekday(150);
  const available = await post("/check_availability", { date, inspection_type: "fire" });
  const time_slot = available.available_slots[0];
  assert.ok(time_slot);
  const args = { customer_id: "C002", date, time_slot, inspection_type: "fire" };
  const results = await Promise.all([
    post("/book_inspection", args),
    post("/retell/book_inspection", { args: { ...args, customer_id: "C001" } }),
  ]);
  const successes = results.filter(result => result.success === true);
  try {
    assert.equal(successes.length, 1);
    assert.equal(results.filter(result => result.error).length, 1);
  } finally {
    for (const success of successes) await post("/cancel_inspection", { booking_id: success.booking.id });
  }
});
