/**
 * Deepgram Aura-2 TTS — streams text to PCM 16-bit 24kHz mono audio.
 */

import { createClient, LiveTTSEvents } from "@deepgram/sdk";
import { SAMPLE_RATE, type CallerAccent } from "@vent/shared";

const DEFAULT_MODEL = "aura-2-thalia-en";

// ============================================================
// Voice selection — Deepgram Aura-2 voice IDs
// ============================================================

const ACCENT_VOICES: Record<CallerAccent, string> = {
  // English accents
  american: "aura-2-thalia-en",
  british: "aura-2-draco-en",
  australian: "aura-2-hyperion-en",
  filipino: "aura-2-amalthea-en",

  // Other languages
  spanish_mexican: "aura-2-javier-es",
  spanish_peninsular: "aura-2-nestor-es",
  spanish_colombian: "aura-2-celeste-es",
  spanish_argentine: "aura-2-antonia-es",
  german: "aura-2-julius-de",
  french: "aura-2-hector-fr",
  italian: "aura-2-elio-it",
  dutch: "aura-2-sander-nl",
  japanese: "aura-2-ebisu-ja",
};

/** ISO 639-1 → default voice. */
const LANGUAGE_DEFAULT_VOICES: Record<string, string> = {
  en: "aura-2-thalia-en",
  es: "aura-2-javier-es",
  fr: "aura-2-hector-fr",
  de: "aura-2-julius-de",
  it: "aura-2-elio-it",
  nl: "aura-2-sander-nl",
  ja: "aura-2-ebisu-ja",
};

/** English-only male/female toggle. */
const GENDER_VOICE_DEFAULTS: Record<"male" | "female", string> = {
  female: "aura-2-thalia-en",
  male: "aura-2-apollo-en",
};

/** Resolve an accent (validated against CALLER_ACCENTS) to a Deepgram voice ID. */
export function resolveAccentVoiceId(accent: CallerAccent): string {
  return ACCENT_VOICES[accent];
}

/**
 * Resolve an ISO 639-1 language code to a default Deepgram voice ID.
 * Returns undefined if the language has no TTS voice available.
 */
export function resolveLanguageVoiceId(language: string): string | undefined {
  return LANGUAGE_DEFAULT_VOICES[language];
}

export function resolveGenderVoiceId(gender: "male" | "female"): string {
  return GENDER_VOICE_DEFAULTS[gender];
}

// ============================================================
// Streaming session
// ============================================================

type LiveTTS = ReturnType<ReturnType<typeof createClient>["speak"]["live"]>;

export interface TTSConfig {
  voiceId?: string;
}

/**
 * Persistent TTS session backed by a Deepgram WebSocket connection.
 * One session per conversation call — reused across all turns.
 */
export class TTSSession {
  private live: LiveTTS | null = null;
  private model: string;
  private apiKey: string;
  private connected = false;

  constructor(config?: TTSConfig) {
    this.apiKey = process.env.DEEPGRAM_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error("Missing Deepgram API key (env: DEEPGRAM_API_KEY)");
    }
    this.model = config?.voiceId ?? DEFAULT_MODEL;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.live = createClient(this.apiKey).speak.live({
      model: this.model,
      encoding: "linear16",
      sample_rate: SAMPLE_RATE,
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Deepgram TTS WebSocket connection timeout (10s)"));
      }, 10_000);

      this.live!.on(LiveTTSEvents.Open, () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.live!.on(LiveTTSEvents.Error, (err: unknown) => {
        if (!this.connected) {
          clearTimeout(timeout);
          reject(new Error(`Deepgram TTS WebSocket error: ${err}`));
        } else {
          console.error("[tts] WebSocket error:", err);
        }
      });

      this.live!.on(LiveTTSEvents.Close, () => {
        this.connected = false;
      });
    });
  }

  /**
   * Start a streaming TTS utterance. The audio listener is set up BEFORE any
   * text is sent, so audio chunks from Deepgram are captured as they arrive.
   *
   * Usage:
   *   const stream = ttsSession.startStreaming(onAudio);
   *   stream.sendText("First sentence. ");  // audio starts flowing immediately
   *   stream.sendText("Second sentence. "); // more audio flows
   *   await stream.finish();                // flush + wait for the rest
   */
  startStreaming(onAudio: (chunk: Buffer) => void): TTSStream {
    if (!this.connected || !this.live) {
      throw new Error("TTS session not connected");
    }
    const live = this.live;
    live.removeAllListeners(LiveTTSEvents.Audio);
    live.on(LiveTTSEvents.Audio, (data: Buffer) => {
      onAudio(data);
    });
    return new TTSStream(live);
  }

  /**
   * Gracefully close the WebSocket connection.
   */
  async close(): Promise<void> {
    if (this.live && this.connected) {
      this.live.requestClose();
      // Give the server a moment to close gracefully
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      this.live.disconnect();
    }
    this.live = null;
    this.connected = false;
  }
}

/**
 * Represents an active TTS streaming utterance. Text can be sent incrementally
 * via sendText(). Audio chunks flow back immediately via the onAudio callback.
 * Call finish() to flush remaining buffer and wait for completion.
 */
class TTSStream {
  constructor(private readonly live: LiveTTS) {}

  /** Send text to Deepgram. Audio starts flowing back immediately. */
  sendText(text: string): void {
    if (!text.trim()) return;
    this.live.sendText(text);
  }

  /**
   * Flush remaining buffer and wait for Flushed confirmation, then stop
   * delivering audio to this utterance's onAudio callback.
   */
  async finish(): Promise<void> {
    this.live.flush();
    await new Promise<void>((resolve) => {
      this.live.once(LiveTTSEvents.Flushed, () => resolve());
      // Safety timeout
      setTimeout(() => resolve(), 5000);
    });
    this.live.removeAllListeners(LiveTTSEvents.Audio);
  }
}
