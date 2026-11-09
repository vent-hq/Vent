import { sql } from "./db.js";

try {
  await sql`CREATE SEQUENCE IF NOT EXISTS booking_ids START 1000`;
  await sql`CREATE TABLE IF NOT EXISTS customers (
    id text PRIMARY KEY, name text NOT NULL, phone text NOT NULL,
    company text NOT NULL, plan text NOT NULL, address text NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS inspections (
    id text PRIMARY KEY, customer_id text NOT NULL REFERENCES customers(id),
    type text NOT NULL, date text NOT NULL, time_slot text NOT NULL,
    status text NOT NULL DEFAULT 'confirmed', notes text
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS confirmed_inspection_slot
    ON inspections(date, time_slot) WHERE status = 'confirmed'`;
  await sql`CREATE TABLE IF NOT EXISTS inspection_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL REFERENCES customers(id), type text NOT NULL,
    date text NOT NULL, result text NOT NULL, notes text,
    UNIQUE(customer_id, type, date)
  )`;
  const customers = [
    {id:'C001',name:'Maria Rodriguez',phone:'555-0101',company:'Apex Manufacturing',plan:'premium',address:'742 Industrial Blvd, Atlanta GA'},
    {id:'C002',name:'James Chen',phone:'555-0102',company:'Harbor Logistics',plan:'basic',address:'1200 Port Way, Savannah GA'},
    {id:'C003',name:'Sarah Thompson',phone:'555-0103',company:'Pinnacle Office Group',plan:'premium',address:'88 Peachtree St, Atlanta GA'},
    {id:'C004',name:'David Kim',phone:'555-0104',company:'Coastal Dining LLC',plan:'basic',address:'445 Beach Rd, Tybee Island GA'},
    {id:'C005',name:'Rachel Foster',phone:'555-0105',company:'Summit Healthcare',plan:'enterprise',address:'3200 Medical Center Dr, Augusta GA'},
  ];
  await sql`INSERT INTO customers ${sql(customers)} ON CONFLICT (id) DO NOTHING`;
  const history = [
    {customer_id:'C001',type:'fire',date:'2025-09-15',result:'pass',notes:'Annual fire safety - all clear'},
    {customer_id:'C002',type:'fire',date:'2025-12-05',result:'fail',notes:'Emergency exit blocked, citation issued'},
  ];
  await sql`INSERT INTO inspection_history ${sql(history)} ON CONFLICT (customer_id,type,date) DO NOTHING`;
  console.log("Demo PostgreSQL schema and sample customers ready; existing bookings preserved.");
} finally {
  await sql.end();
}
