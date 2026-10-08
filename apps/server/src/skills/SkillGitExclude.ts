/**
 * SkillGitExclude - keeps the links to library skills out of a project's git status.
 *
 * Those links are the user's own wiring, not part of the project, so they are listed in the
 * repository's `info/exclude` (in the common git dir, so every worktree of the repository shares
 * it) instead of a `.gitignore` that gets committed. T3 Code owns one marked block there and
 * leaves every other line alone; the block goes when its last line does. A project that isn't in a
 * git repository has no exclude file, so its links need nothing.
 *
 * @module SkillGitExclude
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import * as VcsProcess from "../vcs/VcsProcess.ts";

export const EXCLUDE_BLOCK_START = "# T3 Code: skills used from Global";
export const EXCLUDE_BLOCK_END = "# End T3 Code: skills used from Global";

/** A path as one exclude line: anchored at the repository root, with its glob characters quoted. */
const excludeLine = (relative: string) =>
  `/${relative.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length))}`;

/**
 * `text` with the lines in `add` in T3 Code's block and those in `remove` out of it. A block left
 * empty is removed whole. An unfinished block (a start without its end) is left as it is.
 */
export const editExcludeBlock = (
  text: string,
  change: { readonly add: readonly string[]; readonly remove: readonly string[] },
) => {
  const lines = text === "" ? [] : text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = lines.indexOf(EXCLUDE_BLOCK_START);
  const end = start < 0 ? -1 : lines.indexOf(EXCLUDE_BLOCK_END, start + 1);
  const kept = start >= 0 && end > start ? lines.slice(start + 1, end) : [];
  const removed = new Set(change.remove);
  const inBlock = [...kept.filter((line) => !removed.has(line)), ...change.add].filter(
    (line, index, all) => all.indexOf(line) === index,
  );
  const block = inBlock.length === 0 ? [] : [EXCLUDE_BLOCK_START, ...inBlock, EXCLUDE_BLOCK_END];
  const next =
    start >= 0 && end > start
      ? [...lines.slice(0, start), ...block, ...lines.slice(end + 1)]
      : [...lines, ...block];
  return next.length === 0 ? "" : `${next.join("\n")}\n`;
};

/**
 * Adds the links to, or removes them from, the block in the repository's exclude file. `links`
 * are absolute paths inside `projectRoot`. Nothing happens outside a git repository, and a repo
 * whose exclude file can't be written fails.
 */
export const updateExclude = Effect.fn("SkillGitExclude.updateExclude")(function* (input: {
  readonly projectRoot: string;
  readonly links: ReadonlyArray<string>;
  readonly action: "add" | "remove";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  if (input.links.length === 0) return;
  const result = yield* vcs
    .run({
      operation: "SkillGitExclude.updateExclude",
      command: "git",
      args: ["rev-parse", "--git-common-dir", "--show-prefix"],
      cwd: input.projectRoot,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  if (result === undefined || result.exitCode !== 0) return;
  const [commonDir = "", prefix = ""] = result.stdout.split("\n");
  if (commonDir === "") return;
  const file = path.join(path.resolve(input.projectRoot, commonDir), "info", "exclude");
  const lines = input.links.map((link) =>
    excludeLine(`${prefix}${path.relative(input.projectRoot, link).replaceAll("\\", "/")}`),
  );
  const text = yield* fileSystem.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
  );
  const next = editExcludeBlock(
    text,
    input.action === "add" ? { add: lines, remove: [] } : { add: [], remove: lines },
  );
  if (next === text || (text === "" && next === "")) return;
  yield* writeFileStringAtomically({ filePath: file, contents: next });
});
