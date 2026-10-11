import {
  SKILL_NAME_MAX_LENGTH,
  type EnvironmentId,
  type SkillCreateResult,
  type SkillScope,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { createFailure, skillNameHint } from "./SkillsSettings.logic";

type NewSkillFormProps = {
  environmentId: EnvironmentId;
  /** The project picked above the page, whose folder a project skill goes in; null when none is. */
  projectRoot: string | null;
  onCreated: (result: SkillCreateResult) => void;
};

/** Asks for a new skill's name, description and place, and has the server make it. */
export function NewSkillDialog({
  open,
  onOpenChange,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & NewSkillFormProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
        </DialogHeader>
        <NewSkillForm {...form} onCancel={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

const SCOPE_LABEL: Record<SkillScope, string> = { project: "This project", global: "Global" };

function NewSkillForm({
  environmentId,
  projectRoot,
  onCreated,
  onCancel,
}: NewSkillFormProps & { onCancel: () => void }) {
  const createSkill = useAtomCommand(serverEnvironment.createSkill, { reportFailure: false });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<SkillScope>(projectRoot ? "project" : "global");
  const [pending, setPending] = useState(false);
  /** What the server said, until the person changes what it was about. */
  const [failure, setFailure] = useState<ReturnType<typeof createFailure> | null>(null);
  const nameHint = skillNameHint(name) ?? (failure?.name ? failure.text : null);
  const canCreate =
    !pending && name !== "" && skillNameHint(name) === null && description.trim() !== "";

  const create = async () => {
    if (!canCreate) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await createSkill({
        environmentId,
        input: {
          ...(projectRoot ? { cwd: projectRoot } : {}),
          scope,
          name,
          description: description.trim(),
        },
      });
      if (result._tag === "Success") {
        onCreated(result.value);
        return;
      }
      setFailure(createFailure(squashAtomCommandFailure(result)));
    } catch {
      setFailure(createFailure(null));
    }
    setPending(false);
  };

  return (
    <>
      <DialogPanel>
        <form
          id="new-skill"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="new-skill-name">Name</Label>
            <Input
              id="new-skill-name"
              autoFocus
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              placeholder="review-pull-request"
              value={name}
              maxLength={SKILL_NAME_MAX_LENGTH + 1}
              aria-invalid={nameHint !== null}
              aria-describedby={nameHint ? "new-skill-name-hint" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setFailure(null);
              }}
            />
            {nameHint && (
              <p id="new-skill-name-hint" className="text-xs text-destructive">
                {nameHint}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-skill-description">Description</Label>
            <Input
              id="new-skill-description"
              placeholder="When should an agent use it?"
              value={description}
              maxLength={1024}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {projectRoot && (
            <div className="grid gap-1.5">
              <Label id="new-skill-where">Where</Label>
              <Select
                value={scope}
                onValueChange={(value) => {
                  if (value === "project" || value === "global") {
                    setScope(value);
                    setFailure(null);
                  }
                }}
              >
                <SelectTrigger aria-labelledby="new-skill-where">
                  <SelectValue>{(value: SkillScope) => SCOPE_LABEL[value]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {(["project", "global"] as const).map((option) => (
                    <SelectItem key={option} value={option}>
                      {SCOPE_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}
          {failure && !failure.name && (
            <p role="alert" className="text-sm text-destructive">
              {failure.text}
            </p>
          )}
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" form="new-skill" disabled={!canCreate}>
          {pending ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}
