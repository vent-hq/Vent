/**
 * Caller LLM — generates dynamic caller utterances from a persona prompt.
 *
 * Uses Anthropic Haiku for speed. Maintains conversation history
 * and returns a structured decision for whether the call should continue.
 *
 * Optional CallerPersona injects behavioral modifiers into the system prompt,
 * keeping persona traits (HOW the caller behaves) separate from the caller_prompt
 * (WHAT the caller wants).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CallerPersona } from "@vent/shared";

// @ts-expect-error — esbuild inlines .txt files as strings via loader
import SYSTEM_PROMPT from "./caller-system-prompt.txt";

const MODEL = "claude-haiku-5-5";
// The caller thinks only on turns that need it (e.g. working out a date), so its
// reasoning stays out of the JSON reply. Thinking counts toward MAX_TOKENS.
const CALLER_THINKING = { type: "adaptive" } as const;
const CALLER_EFFORT = "low";
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Persona trait → behavioral instruction mapping
// ---------------------------------------------------------------------------

const PERSONA_TRAIT_MAP: Record<string, Record<string, string>> = {
  pace: {
    slow: "Speak slowly. Take your time with responses. Use longer pauses between thoughts. Sometimes trail off or start over.",
    normal: "",
    fast: "Speak quickly. Give short, rapid responses. Don't linger on any topic.",
  },
  clarity: {
    clear: "",
    vague: "Be vague in your descriptions. Use imprecise language like 'that thing' or 'you know, the stuff'. Don't volunteer specific details unless pushed.",
    rambling: "Ramble and go off on tangents. Tell unnecessary backstory. Circle back to your main point eventually but take detours.",
  },
  cooperation: {
    cooperative: "",
    reluctant: "Be reluctant to provide information. Make the agent work for every detail. Sigh, hesitate, and give partial answers.",
    hostile: "Be confrontational. Challenge the agent's competence. Express irritation and demand better service.",
  },
  emotion: {
    neutral: "",
    cheerful: "Be upbeat, friendly, and positive. Use warm language and express gratitude.",
    confused: "Be confused about the process. Ask clarifying questions. Misunderstand things occasionally and need them re-explained.",
    frustrated: "Express frustration about the situation. Be impatient. If the agent doesn't help quickly, escalate your displeasure.",
    skeptical: "Be skeptical of what the agent says. Question claims and ask for proof or details. Don't take things at face value.",
    rushed: "Be in a hurry. Mention you don't have much time. Push for quick resolution. Cut short long explanations.",
  },
  memory: {
    reliable: "",
    unreliable: "Have unreliable memory. Forget details you mentioned earlier. Contradict yourself occasionally. Need things repeated.",
  },
  intent_clarity: {
    clear: "",
    indirect: "Don't state your goal directly. Hint at what you need. Make the agent figure out your actual intent through conversation.",
    vague: "Be very vague about what you want. Say things like 'I need help with something' without specifying what. Force the agent to ask clarifying questions.",
  },
  confirmation_style: {
    explicit: "",
    vague: "Give vague confirmations. Say 'I guess so', 'sure, whatever', or 'if you say so' instead of clear yes/no answers.",
  },
};

function compilePersona(persona: CallerPersona): string {
  const instructions: string[] = [];

  for (const [trait, value] of Object.entries(persona)) {
    if (value === undefined || value === null) continue;

    if (trait === "disfluencies") {
      if (value === true) {
        instructions.push(
          "Include natural speech disfluencies — 'um', 'uh', 'like', 'you know'. Start some sentences over. Don't overdo it, keep it natural."
        );
      }
      continue;
    }

    const traitMap = PERSONA_TRAIT_MAP[trait];
    if (traitMap) {
      const instruction = traitMap[String(value)];
      if (instruction) {
        instructions.push(instruction);
      }
    }
  }

  if (instructions.length === 0) return "";

  return (
    "\n\nBehavioral modifiers (apply these consistently across ALL turns, but never override the JSON format, turn-taking, or brevity rules above):\n" +
    instructions.map((i) => `- ${i}`).join("\n")
  );
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  ja: "Japanese",
};

function compileLanguage(language: string): string {
  const name = LANGUAGE_NAMES[language] ?? language;
  return `\n\nLANGUAGE: You must speak entirely in ${name}. Every utterance must be in ${name}. Do not use English.`;
}

// ---------------------------------------------------------------------------
// CallerLLM
// ---------------------------------------------------------------------------

export class CallerLLM {
  private client: Anthropic;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private callerPrompt: string;
  private systemPrompt: string;

  constructor(callerPrompt: string, persona?: CallerPersona, language?: string) {
    this.client = new Anthropic();
    this.callerPrompt = callerPrompt;
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    this.systemPrompt =
      SYSTEM_PROMPT +
      `\n\nToday's date is ${today}.` +
      (persona ? compilePersona(persona) : "") +
      (language && language !== "en" ? compileLanguage(language) : "");
  }

  /**
   * Stream the caller's next utterance, yielding sentence-sized chunks
   * as they are detected in the LLM token stream.
   * Returns the full CallerDecision after the stream completes.
   * Automatically commits the decision to history.
   */
  async streamNextUtterance(
    agentResponse: string | null,
    onSentence: (sentence: string) => void,
  ): Promise<CallerDecision | null> {
    const prompt = this.buildNextPrompt(agentResponse);
    const messages = [...this.history, { role: "user" as const, content: prompt }];

    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: CALLER_THINKING,
      output_config: { effort: CALLER_EFFORT },
      system: this.systemPrompt,
      messages,
    });

    let fullText = "";
    let extractedSoFar = 0; // chars of extracted text already yielded

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullText += event.delta.text;

        // Try to extract the "text" field progressively from the JSON
        const extracted = extractPartialTextField(fullText);
        if (extracted && extracted.length > extractedSoFar) {
          const newText = extracted.slice(extractedSoFar);
          // Find sentence boundaries in the new text
          const boundary = findLastSentenceBoundary(newText);
          if (boundary > 0) {
            const sentence = newText.slice(0, boundary).trim();
            if (sentence) {
              onSentence(sentence);
              extractedSoFar += boundary;
            }
          }
        }
      }
    }

    // Flush any remaining text
    const extracted = extractPartialTextField(fullText);
    if (extracted && extracted.length > extractedSoFar) {
      const remaining = extracted.slice(extractedSoFar).trim();
      if (remaining) {
        onSentence(remaining);
      }
    }

    const responseText = fullText.trim();

    const lastUserMsg = messages[messages.length - 1]?.content ?? "(none)";
    const preview = typeof lastUserMsg === "string" ? lastUserMsg.slice(0, 120) : "(structured)";
    console.log(`[caller-llm] prompt="${preview}" raw_response="${responseText.slice(0, 200)}" history_len=${this.history.length}`);

    const decision = parseCallerDecision(responseText);
    if (decision && "text" in decision) {
      console.log(`[caller-llm] parsed mode=${decision.mode} text="${decision.text}"`);
    } else {
      console.log(`[caller-llm] parsed mode=${decision?.mode ?? "null"}`);
    }

    if (decision) {
      this.commitDecision(agentResponse, decision);
    }
    return decision;
  }

  private commitDecision(agentResponse: string | null, decision: CallerDecision): void {
    const prompt = this.buildNextPrompt(agentResponse);
    this.history.push({ role: "user", content: prompt });
    if (decision.mode === "wait") {
      this.history.push({
        role: "assistant",
        content: '{"mode":"wait"}',
      });
      return;
    }
    if (decision.mode === "end_now") {
      return;
    }
    this.history.push({
      role: "assistant",
      content: `{"mode":"${decision.mode}","text":"${decision.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"}`,
    });
  }

  /**
   * Classify agent speech as filler (transitional/holding before a tool result)
   * or complete (substantive response). Used to detect when an agent says
   * "Let me check that" before executing a tool call — so Vent can wait
   * for the actual answer instead of advancing to the next caller turn.
   */
  async classifyAgentSpeech(agentText: string): Promise<FillerClassification> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 16,
      thinking: { type: "disabled" },
      system: `Classify the agent's speech as either "filler" or "complete".

filler = A very short (under 10 words) transitional phrase where the agent says they will do something but has NOT done it yet, and says NOTHING else. The ENTIRE utterance must be a pure holding statement. Examples: "Let me check that for you", "One moment please", "Sure, let me look that up".

complete = everything else, including:
- Any response that reports a result or outcome (e.g., "I wasn't able to find...", "I don't see...")
- Any response with two or more sentences
- Any response that asks the caller a question
- Any response containing information, instructions, or findings
- Greetings and farewells
- Any response that appears truncated or cut off

Default to "complete". Only return "filler" for very short, purely transitional phrases with zero substantive content.

Return exactly one word: filler or complete`,
      messages: [{ role: "user", content: agentText }],
    });

    const raw = response.content[0]?.type === "text"
      ? response.content[0].text.trim().toLowerCase()
      : "";

    const result: FillerClassification = raw === "filler" ? "filler" : "complete";
    console.log(`[filler-detect] text="${agentText.slice(0, 80)}" classification=${result}`);
    return result;
  }

  private buildNextPrompt(agentResponse: string | null): string {
    const isFirstTurn = this.history.length === 0;
    if (isFirstTurn) {
      return agentResponse
        ? `Your persona and goal:\n${this.callerPrompt}\n\nThe agent just greeted you with: "${agentResponse}"\nRespond with a greeting AND state why you are calling. Do both in one turn.`
        : `Your persona and goal:\n${this.callerPrompt}\n\nYou are starting the phone call. Greet AND state why you are calling.`;
    }
    if (agentResponse) {
      return `The agent said: "${agentResponse}"`;
    }
    return "[The agent has not spoken yet. Use \"wait\".]";
  }

}

export type CallerDecision =
  | { mode: "continue"; text: string }
  | { mode: "wait" }
  | { mode: "closing"; text: string }
  | { mode: "end_now" };

export type FillerClassification = "filler" | "complete";

/** Reads the caller's JSON reply. Returns null if it isn't a valid decision. */
function parseCallerDecision(raw: string): CallerDecision | null {
  const parsed = firstJsonObject(raw);
  const mode = parsed?.mode;
  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";

  if (mode === "end_now" || mode === "wait") return { mode };
  if ((mode === "continue" || mode === "closing") && text) return { mode, text };
  return null;
}

/** Returns the first JSON object in the reply and ignores anything after it. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  // Try each "}" as the end until one parses.
  let end = text.indexOf("}", start);
  while (end >= 0) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      end = text.indexOf("}", end + 1);
    }
  }
  return null;
}

/**
 * Extract the "text" field value progressively from partially streamed JSON.
 * Handles: {"mode":"continue","text":"sentence here."} and variations.
 */
function extractPartialTextField(partial: string): string | null {
  // Find "text" key followed by colon and opening quote
  const match = partial.match(/"text"\s*:\s*"/);
  if (!match || match.index === undefined) return null;

  const textStart = match.index + match[0].length;
  let result = "";
  let escaped = false;
  for (let i = textStart; i < partial.length; i++) {
    if (escaped) {
      if (partial[i] === "n") result += "\n";
      else if (partial[i] === "t") result += "\t";
      else result += partial[i];
      escaped = false;
      continue;
    }
    if (partial[i] === "\\") { escaped = true; continue; }
    if (partial[i] === '"') break;
    result += partial[i];
  }
  return result || null;
}

/**
 * Find the position just after the last sentence-ending punctuation.
 * Returns 0 if no boundary found.
 */
function findLastSentenceBoundary(text: string): number {
  const matches = [...text.matchAll(/[.!?]+\s/g)];
  if (matches.length === 0) return 0;
  const last = matches[matches.length - 1]!;
  return last.index! + last[0].length;
}
