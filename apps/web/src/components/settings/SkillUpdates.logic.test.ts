import {
  SkillUpdateError,
  type SkillChangedFile,
  type SkillChangesResult,
  type SkillUpdateEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Skill } from "./SkillsSettings.logic";
import {
  checkSummary,
  describeUpdates,
  ingestUpdates,
  planUpdateAll,
  planUpdateOne,
  previewOf,
  updateErrorReason,
  withEntry,
} from "./SkillUpdates.logic";

const entry = (name: string, extra: Partial<SkillUpdateEntry> = {}): SkillUpdateEntry => ({
  scope: "global",
  name,
  home: `~/.agents/skills/${name}`,
  source: "acme/skills",
  state: "current",
  ...extra,
});

const skill = (name: string): Skill => ({
  id: `global\0${name}\0~/.agents/skills/${name}`,
  name,
  scope: "global",
  home: `~/.agents/skills/${name}`,
  description: "",
  copies: [],
  access: [],
  source: "acme/skills",
});

const file = (path: string, extra: Partial<SkillChangedFile> = {}): SkillChangedFile => ({
  path,
  change: "modified",
  merge: "theirs",
  mine: "mine\n",
  theirs: "theirs\n",
  script: false,
  ...extra,
});

const changes = (
  state: SkillUpdateEntry,
  files: readonly SkillChangedFile[],
): SkillChangesResult => ({
  entry: state,
  upstreamSha: "a".repeat(40),
  localSha: "b".repeat(40),
  files,
  more: 0,
});

describe("checkSummary", () => {
  it.each([
    [[], "No skills here were installed from GitHub."],
    [[entry("tdd"), entry("prd")], "Your skills are up to date."],
    [[entry("tdd", { state: "update" }), entry("prd")], "1 update available."],
    [
      [entry("tdd", { state: "update" }), entry("prd", { state: "update", edited: true })],
      "2 updates available.",
    ],
    [
      [entry("tdd", { state: "unknown", problem: "notFound" })],
      "Couldn't find acme/skills on GitHub.",
    ],
    [
      [
        entry("tdd", { state: "update" }),
        entry("prd", { state: "unknown", problem: "unavailable" }),
      ],
      "1 update available. Some skills couldn't be checked.",
    ],
    [
      [entry("tdd", { state: "unknown", problem: "rateLimited" })],
      "GitHub's limit for this network is used up. Try again later.",
    ],
  ] as const)("%#", (entries, text) => {
    expect(checkSummary({ entries })).toBe(text);
  });
});

describe("withEntry", () => {
  it("replaces one skill's answer with the more exact one", () => {
    const updates = ingestUpdates({ entries: [entry("tdd", { state: "update" }), entry("prd")] });
    const next = withEntry(updates, entry("tdd", { state: "edited" }));
    expect(next.get(skill("tdd").id)?.state).toBe("edited");
    expect(next.get(skill("prd").id)?.state).toBe("current");
    expect(updates.get(skill("tdd").id)?.state).toBe("update");
  });
});

describe("previewOf", () => {
  const conflict = file("notes.md", { merge: "conflict" });
  const merged = file("SKILL.md", { merge: "merged", merged: "both\n" });
  const yours = file("mine.md", { merge: "mine" });
  it.each([
    ["merge takes the merged text", merged, "merge", {}, { before: "mine\n", after: "both\n" }],
    ["merge keeps a file only you changed", yours, "merge", {}, null],
    [
      "an unsettled conflict shows theirs",
      conflict,
      "merge",
      {},
      { before: "mine\n", after: "theirs\n" },
    ],
    [
      "a conflict settled as yours changes nothing",
      conflict,
      "merge",
      { "notes.md": "mine" },
      null,
    ],
    [
      "their version replaces your change",
      yours,
      "theirs",
      {},
      { before: "mine\n", after: "theirs\n" },
    ],
    ["keeping yours changes nothing", merged, "mine", {}, null],
  ] as const)("%s", (_name, changed, choice, resolutions, expected) => {
    expect(previewOf(changed, choice, resolutions)).toEqual(expected);
  });
});

describe("planUpdateOne", () => {
  it("confirms an unedited update in plain words, naming changed scripts", () => {
    const plan = planUpdateOne({
      skill: skill("tdd"),
      changes: changes(entry("tdd", { state: "update", edited: false }), [
        file("SKILL.md"),
        file("scripts/run.sh", { script: true, change: "added", mine: null }),
      ]),
      choice: "merge",
      resolutions: {},
    });
    expect(plan?.change).toMatchObject({
      kind: "update",
      shown: { upstreamSha: "a".repeat(40), localSha: "b".repeat(40), choice: "merge" },
    });
    expect(plan?.confirmation).toEqual({
      title: "Update tdd?",
      body: "It gets the version from acme/skills.",
      notes: ["Changes the script scripts/run.sh."],
      confirm: "Update",
      destructive: false,
    });
  });

  it("warns that taking theirs replaces your edits", () => {
    const plan = planUpdateOne({
      skill: skill("tdd"),
      changes: changes(entry("tdd", { state: "update", edited: true }), [
        file("SKILL.md", { merge: "merged", merged: "both\n" }),
        file("notes.md", { merge: "mine" }),
      ]),
      choice: "theirs",
      resolutions: {},
    });
    expect(plan?.confirmation).toMatchObject({
      title: "Use their tdd?",
      notes: ["Your changes to 2 files are replaced."],
      confirm: "Use their version",
      destructive: true,
    });
  });

  it("asks nothing when you keep your copy, since no file changes", () => {
    const plan = planUpdateOne({
      skill: skill("tdd"),
      changes: changes(entry("tdd", { state: "update", edited: true }), [file("SKILL.md")]),
      choice: "mine",
      resolutions: {},
    });
    expect(plan?.confirmation).toBeUndefined();
    expect(plan?.change).toMatchObject({ kind: "update", shown: { choice: "mine" } });
  });
});

describe("planUpdateAll", () => {
  it("takes only the skills with an update", () => {
    const updates = ingestUpdates({
      entries: [
        entry("tdd", { state: "update", edited: false }),
        entry("prd", { state: "edited" }),
      ],
    });
    const plan = planUpdateAll([skill("tdd"), skill("prd")], updates);
    expect(plan?.change.skills.map((item) => item.name)).toEqual(["tdd"]);
    expect(plan?.confirmation).toMatchObject({ title: "Update tdd?", body: "" });
    expect(planUpdateAll([skill("prd")], updates)).toBeNull();
    expect(planUpdateAll([skill("tdd")], null)).toBeNull();
  });
});

describe("describeUpdates", () => {
  it.each([
    [[{ name: "tdd", result: { status: "updated", conflicts: [] } }], "Updated tdd."],
    [[{ name: "tdd", result: { status: "kept", conflicts: [] } }], "Kept your tdd."],
    [
      [
        { name: "tdd", result: { status: "updated", conflicts: [] } },
        { name: "prd", result: { status: "conflicts", conflicts: ["SKILL.md"] } },
      ],
      "Updated 1 skill. prd needs you to choose between your edits and theirs.",
    ],
    [
      [{ name: "tdd", result: { status: "changed", conflicts: [] } }],
      "tdd changed meanwhile, so it was left as it was. Check again.",
    ],
    [
      [{ name: "tdd", error: "rateLimited" }],
      "GitHub's limit for this network is used up. Try again later.",
    ],
    [[{ name: "tdd", error: "writeFailed" }], "Couldn't update tdd."],
    [
      [{ name: "tdd", result: { status: "updated", conflicts: [], lockStale: true } }],
      "Updated tdd. The skills CLI's record couldn't be updated, so it may offer the update again.",
    ],
  ] as const)("%#", (outcomes, text) => {
    expect(describeUpdates(outcomes)).toBe(text);
  });
});

describe("updateErrorReason", () => {
  it("reads the server's reason, and anything else as a failure", () => {
    expect(updateErrorReason(new SkillUpdateError({ reason: "lockUnsupported" }))).toBe(
      "lockUnsupported",
    );
    expect(updateErrorReason(new Error("socket closed"))).toBe("failed");
  });
});
