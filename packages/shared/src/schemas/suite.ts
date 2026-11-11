/**
 * One call as the user describes it in a suite file: who the simulated caller
 * is, what they want, and how their audio sounds.
 *
 * Written by: the user (suite file) / the coding agent.
 * Read by: the API (validated on submit), the runner (drives the caller).
 */

import { z } from "zod";
import { CALLER_ACCENTS } from "../constants.js";
import { PLATFORM_PROVIDERS } from "./platforms.js";

/** How the call connects: a hosted platform, or "websocket" for a custom agent. */
export const AdapterTypeSchema = z.enum(["websocket", ...PLATFORM_PROVIDERS]);

export const CallerPersonaSchema = z.object({
  pace: z.enum(["slow", "normal", "fast"]).optional(),
  clarity: z.enum(["clear", "vague", "rambling"]).optional(),
  disfluencies: z.boolean().optional(),
  cooperation: z.enum(["cooperative", "reluctant", "hostile"]).optional(),
  emotion: z.enum(["neutral", "cheerful", "confused", "frustrated", "skeptical", "rushed"]).optional(),
  memory: z.enum(["reliable", "unreliable"]).optional(),
  intent_clarity: z.enum(["clear", "indirect", "vague"]).optional(),
  confirmation_style: z.enum(["explicit", "vague"]).optional(),
});

/** Real-world audio conditions applied to the caller's audio. After parsing every value is concrete. */
export const CallerAudioEffectsSchema = z.object({
  noise: z.object({
    type: z.enum(["babble", "white", "pink"]),
    snr_db: z.number().min(0).max(40).default(10),
  }).optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
  speakerphone: z.boolean().optional(),
  mic_distance: z.enum(["close", "normal", "far"]).optional(),
  clarity: z.number().min(0).max(1).optional(),
  accent: z.enum(CALLER_ACCENTS).optional(),
  packet_loss: z.number().min(0).max(0.3).optional(),
  jitter_ms: z.number().min(0).max(100).optional(),
});

export const ConversationCallSpecSchema = z.object({
  name: z.string().optional(),
  caller_prompt: z.string().min(1),
  max_turns: z.number().int().min(1).max(50).default(6),
  persona: CallerPersonaSchema.optional(),
  /** Audio effects applied to all caller audio (speakerphone, speed, noise, accent, etc.) */
  caller_audio: CallerAudioEffectsSchema.optional(),
  /** ISO 639-1 language code for multilingual calls (e.g., "es", "fr", "de"). The caller speaks it and Vent transcribes in it. */
  language: z.string().min(2).max(5).optional(),
  /** Caller voice gender (English only). "male" → aura-2-apollo-en, "female" → aura-2-thalia-en (default). Ignored if caller_audio.accent is set or language is non-English. */
  voice: z.enum(["male", "female"]).optional(),
});
