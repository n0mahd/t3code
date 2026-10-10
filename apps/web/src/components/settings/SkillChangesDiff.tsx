// What updating a skill would change, in T3's diff renderer. It pulls in the renderer and its
// highlighter, so it loads when a skill with an update opens.
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { Badge } from "../ui/badge";

/** One file as it is now and as it would be. */
export type SkillDiffItem = {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly script: boolean;
  readonly omitted?: "binary" | "tooLarge" | undefined;
};

/** Files past the first few start folded, so a big update opens quickly. */
const OPEN_FILES = 3;

const OMITTED_TEXT = { binary: "Binary file", tooLarge: "Too large to show" } as const;

function ScriptBadge() {
  return (
    <Badge variant="warning" size="sm">
      Script
    </Badge>
  );
}

function ChangedFile({
  item,
  index,
  themeName,
}: {
  item: SkillDiffItem;
  index: number;
  themeName: ReturnType<typeof resolveDiffThemeName>;
}) {
  const fileDiff = useMemo(
    () =>
      item.omitted === undefined
        ? parseDiffFromFile(
            { name: item.path, contents: item.before ?? "" },
            { name: item.path, contents: item.after ?? "" },
          )
        : null,
    [item],
  );
  const options = useMemo(
    () => ({
      collapsed: index >= OPEN_FILES,
      diffStyle: "unified" as const,
      theme: themeName,
      overflow: "wrap" as const,
    }),
    [index, themeName],
  );
  if (!fileDiff) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">{item.path}</span>
        {item.script && <ScriptBadge />}
        <span className="shrink-0 text-muted-foreground">
          {item.omitted ? OMITTED_TEXT[item.omitted] : ""}
        </span>
      </div>
    );
  }
  return (
    <FileDiff
      fileDiff={fileDiff}
      options={options}
      renderHeaderMetadata={() => (item.script ? <ScriptBadge /> : null)}
    />
  );
}

export default function SkillChangesDiff({ items }: { items: readonly SkillDiffItem[] }) {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  return (
    <div
      aria-label="What changes"
      className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 text-xs"
    >
      {items.map((item, index) => (
        <ChangedFile key={item.path} item={item} index={index} themeName={themeName} />
      ))}
    </div>
  );
}
