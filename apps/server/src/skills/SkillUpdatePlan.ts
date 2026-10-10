/**
 * SkillUpdatePlan - the pure part of updating a skill from its source: git's hashes, what the
 * `skills` CLI leaves out of an install, and what an update does to each file.
 *
 * A skill folder is compared as a map from each file's path to its git blob SHA, so a local
 * folder and a GitHub tree listing compare without downloading anything. Modes are kept for
 * writing, but a mode-only difference is never a change: the CLI's fast install path drops the
 * executable bit.
 *
 * @module SkillUpdatePlan
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - git's object ids are SHA-1 over buffers, computed synchronously.
import * as NodeCrypto from "node:crypto";

/** Folders the `skills` CLI never installs, and the litter running a skill leaves behind. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  "__pypackages__",
]);
/** Files the CLI never installs (`metadata.json`), and the litter macOS leaves. */
const SKIPPED_FILES = new Set(["metadata.json", ".DS_Store"]);

/** Whether a path in a skill's folder is left out of every comparison. */
export const isIgnoredPath = (path: string) => {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  return SKIPPED_FILES.has(name) || parts.some((part) => SKIPPED_DIRECTORIES.has(part));
};

const objectSha = (kind: "blob" | "tree", body: Uint8Array) =>
  NodeCrypto.createHash("sha1").update(`${kind} ${body.byteLength}\0`).update(body).digest();

/** What git names these bytes as a file. */
export const gitBlobSha = (bytes: Uint8Array) => objectSha("blob", bytes).toString("hex");

/** One file of a folder, by its git blob SHA. */
export interface TreeItem {
  /** Relative to the folder, with `/`. */
  readonly path: string;
  /** `100644`, `100755` or `120000` (a link, whose blob is its target). */
  readonly mode: string;
  readonly sha: string;
}

type TreeNode = Map<string, TreeNode | TreeItem>;

const encodeTree = (node: TreeNode): Buffer => {
  const entries = [...node]
    .map(([name, child]) =>
      child instanceof Map
        ? {
            // Git sorts a folder as if its name ended with a slash.
            key: Buffer.from(`${name}/`),
            head: Buffer.from(`40000 ${name}\0`),
            sha: objectSha("tree", encodeTree(child)),
          }
        : {
            key: Buffer.from(name),
            head: Buffer.from(`${child.mode} ${name}\0`),
            sha: Buffer.from(child.sha, "hex"),
          },
    )
    .toSorted((a, b) => Buffer.compare(a.key, b.key));
  return Buffer.concat(entries.flatMap((entry) => [entry.head, entry.sha]));
};

/**
 * The tree SHA git gives a folder holding these files: what `git write-tree` prints, and what
 * GitHub lists as the folder's `sha`.
 */
export const treeShaOfEntries = (items: ReadonlyArray<TreeItem>) => {
  const root: TreeNode = new Map();
  for (const item of items) {
    const parts = item.path.split("/");
    const name = parts.pop() ?? "";
    let node = root;
    for (const part of parts) {
      const existing = node.get(part);
      if (existing instanceof Map) {
        node = existing;
        continue;
      }
      const created: TreeNode = new Map();
      node.set(part, created);
      node = created;
    }
    node.set(name, item);
  }
  return objectSha("tree", encodeTree(root)).toString("hex");
};

/** A folder as compared: each file's blob SHA and mode, by path. */
export type Side = ReadonlyMap<string, { readonly sha: string; readonly mode: string }>;

/** The files of a folder that comparisons look at. */
export const comparedSide = (items: ReadonlyArray<TreeItem>): Side =>
  new Map(
    items
      .filter((item) => !isIgnoredPath(item.path))
      .map((item) => [item.path, { sha: item.sha, mode: item.mode }]),
  );

/** Both sides hold the same files with the same contents. */
export const sameFiles = (a: Side, b: Side) =>
  a.size === b.size && [...a].every(([path, file]) => b.get(path)?.sha === file.sha);

/** What updating does to one file that differs between the local copy and the source. */
export type FileOutcome =
  /** Only the source changed it: the source's version is taken. */
  | "theirs"
  /** Only you changed it: yours stays. */
  | "mine"
  /** Both changed it: the two are merged, which may still conflict. */
  | "merge"
  /** Both changed it in ways that can't merge, or nothing says which side changed it. */
  | "conflict";

export interface PlannedFile {
  readonly path: string;
  /** From the local copy to the source's. */
  readonly change: "added" | "modified" | "removed";
  readonly outcome: FileOutcome;
}

/**
 * Each file that differs between `mine` and `theirs`, and what a merge does with it. `base` is the
 * version the local copy was installed from; without it no file can be said to be only one side's
 * change, so every difference is a conflict. `SKILL.md` comes first, then by path.
 */
export const planFiles = (mine: Side, theirs: Side, base: Side | undefined): PlannedFile[] => {
  const paths = new Set([...mine.keys(), ...theirs.keys()]);
  const planned: PlannedFile[] = [];
  for (const path of paths) {
    const m = mine.get(path)?.sha;
    const t = theirs.get(path)?.sha;
    if (m === t) continue;
    const change = m === undefined ? "added" : t === undefined ? "removed" : "modified";
    const b = base?.get(path)?.sha;
    const outcome: FileOutcome =
      base === undefined
        ? "conflict"
        : m === b
          ? "theirs"
          : t === b
            ? "mine"
            : m !== undefined && t !== undefined && b !== undefined
              ? "merge"
              : "conflict";
    planned.push({ path, change, outcome });
  }
  const rank = (path: string) => (path.toLowerCase() === "skill.md" ? 0 : 1);
  return planned.toSorted(
    (a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
};

const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat)$/i;

/** A file an agent may run rather than read. */
export const isScript = (path: string, executable: boolean, firstBytes?: Uint8Array) =>
  executable ||
  SCRIPT_EXTENSION.test(path) ||
  /(?:^|\/)(?:bin|scripts)\//.test(path) ||
  (firstBytes !== undefined && firstBytes[0] === 0x23 && firstBytes[1] === 0x21);

/** Bytes that look like a binary file: a NUL early on, or not UTF-8. */
export const isBinary = (bytes: Uint8Array) => {
  if (bytes.subarray(0, 8000).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
};
