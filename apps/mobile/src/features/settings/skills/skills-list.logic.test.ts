import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { InstructionEntry } from "@t3tools/contracts";
import { ingestInstructions, instructionItems } from "@t3tools/client-runtime/skills/instructions";

import { withoutMissingFiles } from "./skills-list.logic";

const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
};
const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Codex",
};
const ctx = { installed: [claude, codex] };

function entry(id: string, over: Partial<InstructionEntry>): InstructionEntry {
  return {
    id,
    scope: "project",
    kind: "shared",
    path: `/home/user/acme-web/${id}`,
    exists: true,
    size: 120,
    readOnly: false,
    access: [claude, codex].map((agent) => ({
      instanceId: agent.instanceId,
      driver: agent.driverKind,
      state: "direct" as const,
    })),
    ...over,
  };
}

const projectAgents = (exists: boolean) =>
  entry("project:shared:AGENTS.md", { relativePath: "AGENTS.md", exists });
const localClaude = (exists: boolean) =>
  entry("project:claudeLocal:CLAUDE.local.md", {
    kind: "claudeLocal",
    relativePath: "CLAUDE.local.md",
    exists,
  });
const globalAgents = (exists: boolean) =>
  entry("global:shared", { scope: "global", path: "/home/user/.agents/AGENTS.md", exists });
const nested = entry("project:nested:apps/web/AGENTS.md", {
  kind: "nested",
  relativePath: "apps/web/AGENTS.md",
});

/** The items' kinds and titles, in order, after the phone leaves out what it can't open. */
function shown(entries: InstructionEntry[], withClaude = false) {
  const data = ingestInstructions({
    entries,
    claude: withClaude
      ? [
          {
            instanceId: claude.instanceId,
            value: "claude-md-or-agents-md",
            explicit: false,
            supported: true,
            version: "2.1.291",
          },
        ]
      : [],
    sharedPath: "/home/user/.agents/AGENTS.md",
    unreadable: [],
  });
  return withoutMissingFiles(instructionItems(data, ctx, { needle: "", onlyAttention: false })).map(
    (item) =>
      item.kind === "group"
        ? `# ${item.label}`
        : item.kind === "file"
          ? item.row.title
          : item.kind === "subfolders"
            ? "In subfolders"
            : item.row.title,
  );
}

describe("withoutMissingFiles", () => {
  it.each([
    {
      name: "keeps every file that exists",
      entries: [projectAgents(true), localClaude(true), globalAgents(true)],
      expected: ["# Project", "AGENTS.md", "CLAUDE.local.md", "# Global", "AGENTS.md"],
    },
    {
      name: "drops files that aren't there yet",
      entries: [projectAgents(true), localClaude(false), globalAgents(true)],
      expected: ["# Project", "AGENTS.md", "# Global", "AGENTS.md"],
    },
    {
      name: "drops a heading left with nothing under it",
      entries: [projectAgents(false), localClaude(false), globalAgents(true)],
      expected: ["# Global", "AGENTS.md"],
    },
    {
      name: "keeps a heading over subfolder files",
      entries: [projectAgents(false), nested, globalAgents(false)],
      expected: ["# Project", "In subfolders"],
    },
    {
      name: "shows nothing when no file exists",
      entries: [projectAgents(false), localClaude(false), globalAgents(false)],
      expected: [],
    },
  ])("$name", ({ entries, expected }) => {
    expect(shown(entries)).toEqual(expected);
  });

  it("keeps the Global heading over Claude's choice when the Global file isn't there", () => {
    expect(shown([globalAgents(false)], true)).toEqual(["# Global", "Claude reads AGENTS.md"]);
  });
});
