/**
 * ClaudeInstructionSetting - Claude's "Project instructions" setting, the import line that lets a
 * CLAUDE.md read an AGENTS.md, and the Claude Code version that can read AGENTS.md at all.
 *
 * Pure functions over parsed JSON and text; the caller reads and writes the files. Sources:
 * https://code.claude.com/docs/en/memory ("Choose which instruction files load", "Import
 * additional files", "When AGENTS.md support is unavailable").
 *
 * The setting is `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles` in the
 * Claude config folder's `settings.json`. Claude Code ignores it in project and local settings.
 * Before 2.1.285 the plugin's id was `agents-md@builtin` and Claude Code 2.1.285 and later reads
 * either, so reading checks both ids and writing keeps a legacy entry that has a value in step.
 *
 * Imports are `@path` in the text of a CLAUDE.md. Only an import that is a line by itself is
 * managed here; Claude also imports a path mentioned inside a sentence, which these functions
 * neither detect nor remove. Lines inside fenced code blocks are not imports, as in Claude.
 *
 * @module ClaudeInstructionSetting
 */
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import type * as Path from "effect/Path";

export const CLAUDE_INSTRUCTION_VALUES = [
  "claude-md-or-agents-md",
  "claude-md-and-agents-md",
  "claude-md",
  "managed-only",
] as const;

export type ClaudeInstructionValue = (typeof CLAUDE_INSTRUCTION_VALUES)[number];

/** What Claude does when the setting is absent: AGENTS.md only when there is no CLAUDE.md. */
export const DEFAULT_CLAUDE_INSTRUCTION_VALUE: ClaudeInstructionValue = "claude-md-or-agents-md";

/** The first Claude Code release that reads AGENTS.md. */
const MIN_AGENTS_MD_CLAUDE_VERSION = "2.1.277";

const PLUGIN_ID = "cc-plugin-agents-md@builtin";
const LEGACY_PLUGIN_ID = "agents-md@builtin";
const OPTION = "instructionFiles";

const settingPath = (pluginId: string) => ["pluginConfigs", pluginId, "options", OPTION] as const;

/** A parsed JSON object, such as the contents of `settings.json`. */
export type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInstructionValue = (value: unknown): value is ClaudeInstructionValue =>
  CLAUDE_INSTRUCTION_VALUES.some((known) => known === value);

const getIn = (root: unknown, keys: readonly string[]): unknown => {
  let current = root;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
};

/** A copy of `root` with `keys` set, or `undefined` when a step on the way isn't an object. */
const setIn = (
  root: JsonObject,
  keys: readonly string[],
  value: unknown,
): JsonObject | undefined => {
  const [key, ...rest] = keys;
  if (key === undefined) return undefined;
  if (rest.length === 0) return { ...root, [key]: value };
  const child = root[key];
  if (child !== undefined && !isObject(child)) return undefined;
  const updated = setIn(child ?? {}, rest, value);
  return updated === undefined ? undefined : { ...root, [key]: updated };
};

const withoutKey = (root: JsonObject, key: string): JsonObject =>
  Object.fromEntries(Object.entries(root).filter(([name]) => name !== key));

/**
 * A copy of `root` without `keys`. Objects that this empties go too; objects that were already
 * empty, and anything the removal doesn't touch, stay. Returns `root` itself when nothing changed.
 */
const deleteIn = (root: JsonObject, keys: readonly string[]): JsonObject => {
  const [key, ...rest] = keys;
  if (key === undefined || !Object.hasOwn(root, key)) return root;
  if (rest.length === 0) return withoutKey(root, key);
  const child = root[key];
  if (!isObject(child)) return root;
  const updated = deleteIn(child, rest);
  if (updated === child) return root;
  return Object.keys(updated).length === 0 ? withoutKey(root, key) : { ...root, [key]: updated };
};

export interface ClaudeInstructionSetting {
  readonly value: ClaudeInstructionValue;
  /** False when no known value is set and `value` is Claude's default. */
  readonly explicit: boolean;
}

/** The "Project instructions" value in a parsed `settings.json`. */
export const readClaudeInstructionSetting = (settings: unknown): ClaudeInstructionSetting => {
  for (const pluginId of [PLUGIN_ID, LEGACY_PLUGIN_ID]) {
    const value = getIn(settings, settingPath(pluginId));
    if (isInstructionValue(value)) return { value, explicit: true };
  }
  return { value: DEFAULT_CLAUDE_INSTRUCTION_VALUE, explicit: false };
};

/**
 * `settings` with "Project instructions" set to `value`, or back at Claude's default when `value`
 * is null: the entry goes, and so do objects it leaves empty. A legacy entry that has a value is
 * kept in step. Everything else is untouched and `settings` is never modified. Returns
 * `undefined` when `value` is set but `pluginConfigs` or the plugin's entry isn't an object, so
 * a caller never overwrites something it doesn't understand.
 */
export const withClaudeInstructionSetting = (
  settings: JsonObject,
  value: ClaudeInstructionValue | null,
): JsonObject | undefined => {
  if (value === null) {
    return deleteIn(deleteIn(settings, settingPath(PLUGIN_ID)), settingPath(LEGACY_PLUGIN_ID));
  }
  const updated = setIn(settings, settingPath(PLUGIN_ID), value);
  if (updated === undefined) return undefined;
  if (getIn(updated, settingPath(LEGACY_PLUGIN_ID)) === undefined) return updated;
  return setIn(updated, settingPath(LEGACY_PLUGIN_ID), value);
};

/**
 * Whether a Claude Code version can read AGENTS.md. Takes the first word, so
 * `2.1.291 (Claude Code)` works. Prereleases sort below their release, and anything that isn't a
 * version is false.
 */
export const supportsAgentsMd = (version: string | null | undefined): boolean => {
  const word = version?.trim().split(/\s+/)[0]?.split("+")[0];
  if (word === undefined || word === "" || parseSemver(word) === null) return false;
  return compareSemverVersions(word, MIN_AGENTS_MD_CLAUDE_VERSION) >= 0;
};

export interface AgentsMdImportTarget {
  /** Resolves the paths, so the answer follows the platform the files are on. */
  readonly path: Path.Path;
  /** The AGENTS.md the import points at. */
  readonly agentsMdPath: string;
  /** The folder of the CLAUDE.md; a relative import resolves against it. */
  readonly claudeMdDirectory: string;
  /** What `~` means in an import. */
  readonly homeDirectory: string;
}

/** The import line for the target: `@~/...` under the home directory, else the absolute path. */
export const agentsMdImportLine = (target: AgentsMdImportTarget): string => {
  const { path } = target;
  const relative = path.relative(target.homeDirectory, target.agentsMdPath);
  const inHome =
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  const written = inHome ? `~/${relative.split(path.sep).join("/")}` : target.agentsMdPath;
  return `@${written.replaceAll(" ", "\\ ")}`;
};

/** The path an import line points at, or `undefined` when the line is not an import by itself. */
const importedPath = (line: string, target: AgentsMdImportTarget): string | undefined => {
  const body = line.trim();
  if (!body.startsWith("@")) return undefined;
  const written = body.slice(1);
  if (written === "" || /(?<!\\)\s/.test(written)) return undefined;
  const imported = written.replaceAll("\\ ", " ");
  if (imported === "~" || imported.startsWith("~/")) {
    return target.path.resolve(target.homeDirectory, imported.slice(2));
  }
  return target.path.resolve(target.claudeMdDirectory, imported);
};

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Each line of the text with its line ending, and whether it is an import of the target. */
const scanImports = (text: string, target: AgentsMdImportTarget) => {
  const resolvedTarget = target.path.resolve(target.agentsMdPath);
  let fence: { readonly marker: string; readonly length: number } | undefined;
  return text
    .split(/(?<=\n)/)
    .filter((line) => line !== "")
    .map((line) => {
      const content = line.replace(/\r?\n$/, "");
      const opened = FENCE.exec(content);
      if (fence === undefined) {
        if (opened?.[1] !== undefined) {
          fence = { marker: opened[1].charAt(0), length: opened[1].length };
          return { line, isImport: false };
        }
        return { line, isImport: importedPath(content, target) === resolvedTarget };
      }
      const closes =
        opened?.[1] !== undefined &&
        opened[1].charAt(0) === fence.marker &&
        opened[1].length >= fence.length &&
        opened[2]?.trim() === "";
      if (closes) fence = undefined;
      return { line, isImport: false };
    });
};

/** Whether the text has a line that imports the target. */
export const hasAgentsMdImport = (text: string, target: AgentsMdImportTarget): boolean =>
  scanImports(text, target).some((entry) => entry.isImport);

/**
 * The text with an import of the target as its first line and everything else as it was. Text
 * that already imports the target comes back as it is.
 */
export const addAgentsMdImport = (text: string, target: AgentsMdImportTarget): string => {
  if (hasAgentsMdImport(text, target)) return text;
  const lineEnding = /\r?\n/.exec(text)?.[0] ?? "\n";
  const bom = text.startsWith("﻿") ? "﻿" : "";
  return `${bom}${agentsMdImportLine(target)}${lineEnding}${text.slice(bom.length)}`;
};

/** The text without any line that imports the target, everything else as it was. */
export const removeAgentsMdImport = (text: string, target: AgentsMdImportTarget): string => {
  const kept = scanImports(text, target)
    .filter((entry) => !entry.isImport)
    .map((entry) => entry.line)
    .join("");
  return kept !== "" && text.startsWith("\uFEFF") && !kept.startsWith("\uFEFF")
    ? `\uFEFF${kept}`
    : kept;
};
