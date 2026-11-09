import express from "express";
import { sql } from "./db.js";
import vapiRouter from "./vapi.js";
import blandRouter from "./bland.js";
import retellRouter from "./retell.js";
import elevenlabsRouter from "./elevenlabs.js";

const app = express();

// ─── Request logging middleware ───
app.use((req, res, next) => {
  const start = Date.now();
  const id = Math.random().toString(36).slice(2, 8);
  req._reqId = id;
  req._startMs = start;

  console.log(`[${new Date().toISOString()}] ▶ ${req.method} ${req.originalUrl} req=${id}`);

  // Log raw body once parsed
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const elapsed = Date.now() - start;
    const status = res.statusCode;
    const hasError = body && body.error;
    const prefix = hasError ? "✗" : "✓";
    console.log(`[${new Date().toISOString()}] ${prefix} ${req.method} ${req.originalUrl} → ${status} (${elapsed}ms) req=${id}`);
    if (hasError) {
      console.log(`[${new Date().toISOString()}]   ERROR: ${body.error} req=${id}`);
    }
    return origJson(body);
  };

  next();
});

app.use(express.json({ limit: "10mb" }));

// Log parsed body for POST requests
app.use((req, res, next) => {
  if (req.method === "POST" && req.body) {
    console.log(`[${new Date().toISOString()}]   BODY: ${JSON.stringify(req.body)} req=${req._reqId}`);
  }
  next();
});

app.get("/health", async (_req, res) => {
  try { await sql`SELECT 1`; res.json({status:"ok",database:"postgresql"}); }
  catch { res.status(503).json({status:"error"}); }
});

// Vapi webhook at root (existing behavior)
app.use("/", vapiRouter);

// Bland webhook routes at /bland/*
app.use("/bland", blandRouter);

// Retell custom function routes at /retell/*
app.use("/retell", retellRouter);

// ElevenLabs webhook tool routes at /elevenlabs/*
app.use("/elevenlabs", elevenlabsRouter);

// ─── 404 handler ───
app.use((req, res) => {
  console.log(`[${new Date().toISOString()}] ✗ 404 NOT FOUND: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ─── Error handler ───
app.use((err, req, res, _next) => {
  console.error(`[${new Date().toISOString()}] ✗ UNHANDLED ERROR on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: `Server error: ${err.message}` });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] SafetySpect server listening on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Routes: /bland/*, /retell/*, /elevenlabs/*`);
});
