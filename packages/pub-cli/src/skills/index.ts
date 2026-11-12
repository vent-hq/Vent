import body from "./body.md";
import claudeCodeExecution from "./claude-code.md";
import cursorExecution from "./cursor.md";
import codexExecution from "./codex.md";
import windsurfExecution from "./windsurf.md";

const DESCRIPTION =
  "Place real calls against the user's voice agent to verify code changes work end-to-end. Use on test requests, after a major voice-agent change, or to iterate until a voice agent works.";

interface EditorParts {
  /** YAML frontmatter lines; omitted for Codex, whose skill is appended to AGENTS.md. */
  frontmatter?: string[];
  /** The "## <Editor> Execution" section. */
  execution: string;
  /** Appended to the local-LiveKit workflow step. */
  liveKitNote?: string;
  /** How parallel calls are launched, quoted in the Concurrency section. */
  parallelExample?: string;
}

function assemble(parts: EditorParts): string {
  const skill = body
    .replace("{{EXECUTION}}\n", () => parts.execution)
    .replace("{{LIVEKIT_NOTE}}", () => parts.liveKitNote ?? "")
    .replace("{{PARALLEL_EXAMPLE}}", () => parts.parallelExample ?? "");
  return parts.frontmatter ? `---\n${parts.frontmatter.join("\n")}\n---\n\n${skill}` : skill;
}

export const claudeCodeSkill = assemble({
  frontmatter: ["name: vent", `description: ${DESCRIPTION}`, "allowed-tools: Bash(npx vent-hq *)"],
  execution: claudeCodeExecution,
  liveKitNote: " (See `Claude Code Execution` for how to run the restart and wait as one foreground command before the run.)",
  parallelExample: " with `&` and `wait`",
});

export const cursorSkill = assemble({
  frontmatter: [`description: ${DESCRIPTION}`, "alwaysApply: true"],
  execution: cursorExecution,
  parallelExample: " with `&` and `wait`",
});

export const codexSkill = assemble({ execution: codexExecution });

export const windsurfSkill = assemble({
  frontmatter: ["name: vent", `description: ${DESCRIPTION}`],
  execution: windsurfExecution,
});
