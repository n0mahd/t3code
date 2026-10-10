/**
 * SkillCreate - writes a new skill's folder: a SKILL.md with the header agents read and a line
 * for the person to replace.
 *
 * The folder is made whole in a hidden folder beside where it goes, which no agent reads, and
 * then renamed into place. An agent never sees half a skill, and nothing already there is
 * replaced: a rename stops at a file, a link or a folder with something in it.
 *
 * @module SkillCreate
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * SKILL.md for a new skill. The name is one agents accept, which YAML reads as plain text; the
 * description is written as a JSON string, which YAML reads back as the same text whatever it holds.
 */
export const skillFileText = (name: string, description: string) =>
  [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Write the steps the agent should follow when it uses this skill.",
    "",
  ].join("\n");

/**
 * Makes `<folder>/<name>/SKILL.md`, making `folder` if it is missing. `taken` when something is
 * already at `<folder>/<name>`; nothing is changed then.
 */
export const writeNewSkill = Effect.fn("SkillCreate.writeNewSkill")(function* (input: {
  readonly folder: string;
  readonly name: string;
  readonly description: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(input.folder, input.name);
  yield* fs.makeDirectory(input.folder, { recursive: true });
  const staging = yield* fs.makeTempDirectory({ directory: input.folder, prefix: ".t3-new-" });
  // Made inside the private staging folder, the skill's own folder gets the usual permissions.
  const made = path.join(staging, input.name);
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(made);
    yield* fs.writeFileString(
      path.join(made, "SKILL.md"),
      skillFileText(input.name, input.description),
    );
    return yield* fs.rename(made, destination).pipe(
      Effect.as("created" as const),
      Effect.catchTag("PlatformError", (error) => {
        const cause: unknown = error.reason.cause;
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
        return error.reason._tag === "AlreadyExists" || code === "ENOTEMPTY" || code === "ENOTDIR"
          ? Effect.succeed("taken" as const)
          : Effect.fail(error);
      }),
    );
  }).pipe(
    // The staging folder is this request's own; whatever stopped the write, it goes.
    Effect.onExit(() => fs.remove(staging, { recursive: true }).pipe(Effect.ignore)),
  );
});
