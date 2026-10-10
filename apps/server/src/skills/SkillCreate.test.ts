import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseSkillFrontmatter } from "../provider/Drivers/ClaudeSkills.ts";
import { skillFileText, writeNewSkill } from "./SkillCreate.ts";

describe("skillFileText", () => {
  // Each is text YAML would read as something else, or not at all, if it were written bare.
  it.each([
    "Review a pull request.",
    "Use when: the diff touches the API",
    "Say \"hello\" and 'goodbye'",
    "# not a comment",
    "- not a list item",
    "{ not: a map }",
    "yes",
    "null",
    "1024",
    "a tab\there and a back\\slash",
    `Ünïcode, emoji 🚀 and a line separator ${String.fromCharCode(0x2028)} inside`,
  ])("reads back %j as the description, as Claude Code reads the header", (description) => {
    expect(parseSkillFrontmatter(skillFileText("review-code", description))).toEqual({
      kind: "parsed",
      name: "review-code",
      description,
    });
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("writeNewSkill", (it) => {
  const makeFolder = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-create-" });
    return { fs, path, folder: path.join(root, ".agents/skills") };
  });

  it.effect("makes the folder it goes in, and leaves nothing else behind", () =>
    Effect.gen(function* () {
      const { fs, path, folder } = yield* makeFolder;
      const result = yield* writeNewSkill({ folder, name: "ship-it", description: "Ship it." });
      expect(result).toBe("created");
      expect(yield* fs.readDirectory(folder)).toEqual(["ship-it"]);
      expect(yield* fs.readDirectory(path.join(folder, "ship-it"))).toEqual(["SKILL.md"]);
    }),
  );

  it.effect("leaves a file or a folder with that name as it was", () =>
    Effect.gen(function* () {
      const { fs, path, folder } = yield* makeFolder;
      yield* fs.makeDirectory(path.join(folder, "notes"), { recursive: true });
      yield* fs.writeFileString(path.join(folder, "notes/todo.md"), "keep me");
      yield* fs.writeFileString(path.join(folder, "plain"), "keep me too");

      expect(yield* writeNewSkill({ folder, name: "notes", description: "x" })).toBe("taken");
      expect(yield* writeNewSkill({ folder, name: "plain", description: "x" })).toBe("taken");
      expect((yield* fs.readDirectory(folder)).toSorted()).toEqual(["notes", "plain"]);
      expect(yield* fs.readDirectory(path.join(folder, "notes"))).toEqual(["todo.md"]);
      expect(yield* fs.readFileString(path.join(folder, "plain"))).toBe("keep me too");
    }),
  );
});
