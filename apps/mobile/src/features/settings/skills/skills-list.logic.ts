import type { InstructionItem } from "@t3tools/client-runtime/skills/instructions";

/**
 * The Instructions items a phone shows. It only reads files, so one that doesn't exist yet has
 * nothing to open and is left out, along with a heading left with nothing under it.
 */
export function withoutMissingFiles(items: readonly InstructionItem[]): InstructionItem[] {
  const kept = items.filter((item) => item.kind !== "file" || !item.row.missing);
  return kept.filter((item, index) => {
    if (item.kind !== "group") return true;
    const next = kept[index + 1];
    return next !== undefined && next.kind !== "group";
  });
}
