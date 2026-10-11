import type { EnvironmentId, SkillChangesResult, SkillUpdateEntry } from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useState } from "react";

import { useAfterDelay } from "../../hooks/useAfterDelay";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { SkillDiffItem } from "./SkillChangesDiff";
import type { Skill, SkillPlan } from "./SkillsSettings.logic";
import {
  changesTitle,
  conflictsOf,
  needsChoice,
  planUpdateOne,
  previewOf,
  problemText,
  type Resolutions,
  type UpdateChoice,
} from "./SkillUpdates.logic";

const SkillChangesDiff = lazy(() => import("./SkillChangesDiff"));

const SKELETON_DELAY_MS = 150;

type State =
  | { status: "loading" }
  | { status: "ready"; changes: SkillChangesResult }
  | { status: "error" };

const CHOICES: ReadonlyArray<{ value: UpdateChoice; label: string; detail: string }> = [
  { value: "merge", label: "Merge", detail: "Keeps your edits and adds theirs" },
  { value: "theirs", label: "Use their version", detail: "Replaces your edits" },
  { value: "mine", label: "Keep mine", detail: "Skips this update" },
];

const isChoice = (value: unknown): value is UpdateChoice =>
  value === "merge" || value === "theirs" || value === "mine";

/**
 * A skill's update, read when its page opens: what would change, shown before anything is
 * written, and the choice of how to take it when you've edited the skill.
 */
export function SkillUpdatePanel({
  skill,
  environmentId,
  projectRoot,
  busy,
  locked,
  onEntry,
  onPlan,
}: {
  skill: Skill;
  environmentId: EnvironmentId;
  projectRoot: string | null;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  /** The connection's grant doesn't allow writing files. */
  locked: boolean;
  /** The comparison as reading the changes found it, which is more exact than the check's. */
  onEntry: (entry: SkillUpdateEntry) => void;
  onPlan: (plan: SkillPlan) => void;
}) {
  const getChanges = useAtomCommand(serverEnvironment.getSkillChanges, { reportFailure: false });
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState<UpdateChoice>("merge");
  const [resolutions, setResolutions] = useState<Resolutions>({});
  const { scope, name, home } = skill;
  const reportEntry = useEffectEvent(onEntry);
  useEffect(() => {
    let cancelled = false;
    void getChanges({
      environmentId,
      input: { scope, name, home, ...(projectRoot ? { cwd: projectRoot } : {}) },
    }).then((result) => {
      if (cancelled) return;
      if (result._tag !== "Success") {
        setState({ status: "error" });
        return;
      }
      setState({ status: "ready", changes: result.value });
      // A source that couldn't be read says so here, and leaves the check's answer as it was.
      if (result.value.entry && result.value.entry.state !== "unknown") {
        reportEntry(result.value.entry);
      }
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Try again reads the changes again.
  }, [environmentId, scope, name, home, projectRoot, getChanges, attempt]);

  const changes = state.status === "ready" ? state.changes : null;
  const entry = changes?.entry ?? null;
  const files = useMemo(() => changes?.files ?? [], [changes]);
  const conflicts = useMemo(() => conflictsOf(files), [files]);
  const items = useMemo(
    () =>
      files.flatMap((file): SkillDiffItem[] => {
        const preview = previewOf(file, choice, resolutions);
        return preview === null
          ? []
          : [{ path: file.path, ...preview, script: file.script, omitted: file.omitted }];
      }),
    [files, choice, resolutions],
  );
  const showSkeleton = useAfterDelay(state.status === "loading", SKELETON_DELAY_MS);

  if (state.status === "loading") {
    return (
      <div role="status" aria-label="Reading the update" className="space-y-2">
        {showSkeleton ? (
          <>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-16 w-full" />
          </>
        ) : (
          <span className="block h-12" />
        )}
      </div>
    );
  }
  if (state.status === "error" || entry?.state === "unknown") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-warning-foreground">
        {entry ? problemText(entry) : "Couldn't read this skill's update."}
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setState({ status: "loading" });
            setAttempt((count) => count + 1);
          }}
        >
          Try again
        </Button>
      </p>
    );
  }
  if (
    entry === null ||
    changes === null ||
    (entry.state !== "update" && entry.state !== "differs")
  ) {
    return null;
  }

  const asks = needsChoice(entry);
  const chosen = asks ? choice : "merge";
  const unsettled = chosen === "merge" && conflicts.some((file) => !resolutions[file.path]);
  const plan = planUpdateOne({ skill, changes, choice: chosen, resolutions });
  // With nothing to say which side changed a file, merging is choosing each file yourself.
  const everyFileAsks = conflicts.length > 0 && conflicts.length === files.length;

  return (
    <section
      aria-label="Update"
      className="space-y-3 rounded-xl border border-border/60 bg-card/40 px-3 py-3 sm:px-4"
    >
      <h3 className="text-sm font-medium">{changesTitle(entry)}</h3>
      {items.length > 0 && (
        <Suspense fallback={<Skeleton className="h-16 w-full" />}>
          <SkillChangesDiff items={items} />
        </Suspense>
      )}
      {changes.more > 0 && (
        <p className="text-xs text-muted-foreground">
          {changes.more === 1 ? "1 more file changes." : `${changes.more} more files change.`}
        </p>
      )}
      {asks && (
        <RadioGroup
          aria-label="How to update"
          value={choice}
          onValueChange={(value) => {
            if (isChoice(value)) setChoice(value);
          }}
        >
          {CHOICES.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <Radio value={option.value} />
              <span className="min-w-0">
                <span className="block">
                  {option.value === "merge" && everyFileAsks ? "Choose each file" : option.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {option.value === "merge" && everyFileAsks
                    ? "Keeps what you pick"
                    : option.detail}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      )}
      {chosen === "merge" && conflicts.length > 0 && (
        <ul aria-label="Files to choose" className="space-y-2">
          {conflicts.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
              <ToggleGroup
                aria-label={`Which ${file.path} to keep`}
                variant="segmented"
                value={resolutions[file.path] ? [resolutions[file.path]!] : []}
                onValueChange={(next) => {
                  const picked = next[0];
                  if (picked === "mine" || picked === "theirs") {
                    setResolutions((current) => ({ ...current, [file.path]: picked }));
                  }
                }}
              >
                <Toggle value="mine">Keep mine</Toggle>
                <Toggle value="theirs">Take theirs</Toggle>
              </ToggleGroup>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={busy || locked || unsettled || plan === null}
          title={locked ? "This connection can't change files" : undefined}
          onClick={() => plan && onPlan(plan)}
        >
          {chosen === "mine" ? "Keep mine" : "Update"}
        </Button>
      </div>
    </section>
  );
}
