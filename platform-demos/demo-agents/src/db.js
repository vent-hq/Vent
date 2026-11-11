import postgres from "postgres";

const url = new URL(process.env.DEMO_DATABASE_URL ?? "");
if (url.pathname !== "/vent_demo") throw new Error("DEMO_DATABASE_URL must name the isolated vent_demo database");
export const sql = postgres(url.toString(), { max: 5 });

// ─── Helpers ───

export function normalizePhone(phone) {
  return phone.replace(/\D/g, "").slice(-7);
}

export function fuzzyMatch(a, b) {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  let dist = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist <= 2;
}

export function fuzzyNameMatch(query, fullName) {
  const queryParts = query.toLowerCase().trim().split(/\s+/);
  const nameParts = fullName.toLowerCase().trim().split(/\s+/);
  return queryParts.every((qp) => nameParts.some((np) => fuzzyMatch(qp, np)));
}

export const VALID_TYPES = ["fire", "electrical", "osha", "environmental", "comprehensive"];

export function isWeekend(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.getDay() === 0 || d.getDay() === 6;
}

export function isPast(dateStr) {
  // Compare date strings in UTC to avoid timezone mismatches
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0]; // "YYYY-MM-DD" in UTC
  return dateStr < todayStr;
}

export function todayUTC() {
  return new Date().toISOString().split("T")[0];
}

export async function generateSlots(dateStr, inspectionType) {
  if (inspectionType === "comprehensive") {
    const allSlots = ["08:00-12:00", "12:00-16:00"];
    const dayOfMonth = parseInt(dateStr.split("-")[2]);
    if (dayOfMonth % 3 === 0) return allSlots.slice(0, 1);
    return allSlots;
  }

  const allSlots = [
    "08:00-10:00", "10:00-12:00", "12:00-14:00", "14:00-16:00", "15:00-17:00",
  ];

  const booked = (await sql.unsafe("SELECT time_slot FROM inspections WHERE date = $1 AND status = 'confirmed'", [dateStr]))
    .map((r) => r.time_slot);

  let available = allSlots.filter((s) => !booked.includes(s));

  const dayOfMonth = parseInt(dateStr.split("-")[2]);
  if (dayOfMonth % 5 === 0 && available.length > 2) {
    available = available.slice(0, 1);
  } else if (dayOfMonth % 4 === 0 && available.length > 3) {
    available = available.slice(0, 2);
  }

  return available;
}
