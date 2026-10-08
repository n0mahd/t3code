import { useState } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SkillAgentIcon } from "./skillAgentIcon";
import {
  planDelete,
  planMove,
  planTurnOff,
  planTurnOnAll,
  type Skill,
  type SkillPlan,
  type SkillsContext,
} from "./SkillsSettings.logic";

/** Acts on every ticked row. It sticks to the bottom of the page, so it is in reach on a phone. */
export function BulkBar({
  selected,
  ctx,
  hasProject,
  busy,
  onClear,
  onPlan,
}: {
  selected: readonly Skill[];
  ctx: SkillsContext;
  /** A project is picked, so "Move to this project" means something. */
  hasProject: boolean;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  onClear: () => void;
  onPlan: (plan: SkillPlan) => void;
}) {
  const turnOn = planTurnOnAll(selected, ctx);
  const toGlobal = planMove(selected, "global");
  const toProject = hasProject ? planMove(selected, "project") : null;
  const del = planDelete(selected, ctx);
  return (
    <div
      role="region"
      aria-label="Actions for selected skills"
      className="sticky bottom-0 z-20 rounded-xl border border-border/60 bg-background px-3 py-2 shadow-xs/5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{selected.length} selected</span>
        <Button size="xs" variant="ghost-muted" onClick={onClear}>
          Clear
        </Button>
        <span className="hidden flex-1 sm:block" />
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !turnOn}
            title={turnOn ? undefined : "Already available to every agent"}
            onClick={() => turnOn && onPlan(turnOn)}
          >
            Turn on for all agents
          </Button>
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="outline" disabled={busy} />}>
              Turn off for…
            </MenuTrigger>
            <MenuPopup align="end">
              {ctx.installed.map((agent) => {
                const plan = planTurnOff(selected, agent, ctx);
                return (
                  <MenuItem
                    key={agent.instanceId}
                    disabled={!plan || plan.affected === 0}
                    onClick={() => plan && onPlan(plan)}
                  >
                    <SkillAgentIcon agent={agent} agents={ctx.installed} />
                    {agent.displayName}
                    {plan && plan.affected > 0 && (
                      <span className="text-xs text-muted-foreground">· {plan.affected}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
          {toGlobal && (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onPlan(toGlobal)}>
              Move to Global
            </Button>
          )}
          {toProject && (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onPlan(toProject)}>
              Move to this project
            </Button>
          )}
          {del && (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              title="Deletes the skills' folders. This can't be undone."
              onClick={() => onPlan(del)}
            >
              Delete…
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Asks before a plan changes anything, with the same plain words for one skill or many. */
export function ConfirmPlan({
  plan,
  onCancel,
  onConfirm,
}: {
  /** The plan to confirm; a plan without a confirmation never opens the dialog. */
  plan: SkillPlan | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Keep the last text while the dialog closes, so it doesn't blank out first.
  const [shown, setShown] = useState(plan?.confirmation);
  if (plan?.confirmation && plan.confirmation !== shown) setShown(plan.confirmation);
  return (
    <AlertDialog
      open={plan?.confirmation !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          <AlertDialogDescription>{shown?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {shown && shown.notes.length > 0 && (
          <ul className="space-y-1 px-6 pb-4 text-xs break-words text-muted-foreground">
            {shown.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={shown?.destructive ? "destructive" : "default"} onClick={onConfirm}>
            {shown?.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
