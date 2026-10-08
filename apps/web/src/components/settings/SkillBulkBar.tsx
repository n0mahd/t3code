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
import type { SkillPlan } from "./SkillsSettings.logic";

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
          {shown?.body && <AlertDialogDescription>{shown.body}</AlertDialogDescription>}
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
