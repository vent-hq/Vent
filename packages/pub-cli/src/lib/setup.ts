import * as fs from "node:fs/promises";
import * as path from "node:path";
import { printSuccess } from "./output.js";
import { claudeCodeSkill, codexSkill, cursorSkill, windsurfSkill } from "../skills/index.js";

async function installClaudeCode(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".claude", "skills", "vent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), claudeCodeSkill);
  printSuccess("Claude Code: .claude/skills/vent/SKILL.md", { force: true });
}

async function installCursor(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".cursor", "rules");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "vent.mdc"), cursorSkill);
  printSuccess("Cursor: .cursor/rules/vent.mdc", { force: true });
}

async function installWindsurf(cwd: string): Promise<void> {
  const dir = path.join(cwd, ".windsurf", "skills", "vent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), windsurfSkill);
  printSuccess("Windsurf: .windsurf/skills/vent/SKILL.md", { force: true });
}

const VENT_MARKERS = [
  "# Vent - Voice Agent Calls",
  "# Vent — Voice Agent Calls",
];

async function installCodex(cwd: string): Promise<void> {
  const filePath = path.join(cwd, "AGENTS.md");

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  const markerIndex = VENT_MARKERS
    .map((marker) => existing.indexOf(marker))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];

  if (markerIndex != null) {
    // Replace everything from the Vent heading to end of file
    await fs.writeFile(filePath, existing.slice(0, markerIndex).trimEnd() + "\n\n" + codexSkill + "\n");
  } else if (existing) {
    // Append to existing AGENTS.md
    await fs.writeFile(filePath, existing.trimEnd() + "\n\n" + codexSkill + "\n");
  } else {
    // Create new file
    await fs.writeFile(filePath, codexSkill + "\n");
  }

  printSuccess("Codex: AGENTS.md", { force: true });
}

/** Install skill files for every supported editor. */
export async function installSkills(cwd: string): Promise<void> {
  await installClaudeCode(cwd);
  await installCursor(cwd);
  await installCodex(cwd);
  await installWindsurf(cwd);
}
