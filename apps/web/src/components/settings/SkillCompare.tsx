import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import type { TidyDuplicate } from "./SkillTidy.logic";

type Copies =
  | { status: "loading" }
  | { status: "ready"; global: string; project: string }
  | { status: "error" };

/**
 * The differences between Global's SKILL.md and this project's copy, read from disk when it
 * opens. Loaded on demand, since the diff view brings the highlighter with it.
 */
export default function SkillCompare({
  duplicate,
  environmentId,
  cwd,
  onClose,
}: {
  duplicate: TidyDuplicate;
  environmentId: EnvironmentId;
  cwd: string;
  onClose: () => void;
}) {
  const readSkill = useAtomCommand(serverEnvironment.getSkill, { reportFailure: false });
  const { resolvedTheme } = useTheme();
  const [copies, setCopies] = useState<Copies>({ status: "loading" });
  const { skill, globalHome } = duplicate;
  useEffect(() => {
    let cancelled = false;
    const read = (scope: "project" | "global", home: string) =>
      readSkill({ environmentId, input: { cwd, scope, name: skill.name, home } }).then((result) =>
        result._tag === "Success" ? result.value.contents : null,
      );
    void Promise.all([read("global", globalHome), read("project", skill.home)])
      .then(([global, project]) => {
        if (cancelled) return;
        setCopies(
          global === null || project === null
            ? { status: "error" }
            : { status: "ready", global, project },
        );
      })
      .catch(() => {
        if (!cancelled) setCopies({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [readSkill, environmentId, cwd, skill.name, skill.home, globalHome]);
  const diff = useMemo(
    () =>
      copies.status === "ready" && copies.global !== copies.project
        ? parseDiffFromFile(
            { name: "SKILL.md", contents: copies.global },
            { name: "SKILL.md", contents: copies.project },
          )
        : null,
    [copies],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Compare “{skill.name}”</DialogTitle>
          <DialogDescription>From Global's copy to this project's.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {copies.status === "loading" ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Reading both copies…
            </p>
          ) : copies.status === "error" ? (
            <p role="alert" className="text-sm text-warning-foreground">
              Couldn't read both copies.
            </p>
          ) : diff ? (
            <div className="overflow-auto rounded-lg border text-xs" aria-label="Differences">
              <FileDiff
                fileDiff={diff}
                options={{
                  diffStyle: "unified",
                  theme: resolveDiffThemeName(resolvedTheme),
                  overflow: "wrap",
                }}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The two copies are the same.</p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
