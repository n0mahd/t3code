// PROTOTYPE(agent-secrets): design review only, mock data, not wired to the server.
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

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
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import {
  isValidSecretName,
  normalizeSecretName,
  savePrototypeSecret,
  usePrototypeSecrets,
} from "./secretsPrototypeStore";

export type SecretDialogRequest =
  | { readonly mode: "add" }
  | { readonly mode: "replace"; name: string };

interface SecretDialogProps {
  request: SecretDialogRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SecretDialog({ request, open, onOpenChange }: SecretDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        {request ? <SecretForm request={request} onClose={() => onOpenChange(false)} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function SecretForm({ request, onClose }: { request: SecretDialogRequest; onClose: () => void }) {
  const formId = useId();
  const existing = usePrototypeSecrets();
  const isReplace = request.mode === "replace";
  const [name, setName] = useState(isReplace ? request.name : "");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);

  const nameError =
    isReplace || name.length === 0
      ? null
      : !isValidSecretName(name)
        ? "Use letters, numbers and underscores, starting with a letter."
        : existing.some((secret) => secret.name === name)
          ? "You already have a secret with this name."
          : null;
  const canSave = isValidSecretName(name) && nameError === null && value.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    // The value is dropped here; only the name and a timestamp are kept.
    savePrototypeSecret(name);
    toastManager.add({ type: "success", title: `${isReplace ? "Replaced" : "Saved"} ${name}` });
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isReplace ? `Replace ${request.name}` : "Add secret"}</DialogTitle>
        <DialogDescription>
          Agents in every project can use it. You won't be able to view it again.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>Name</Label>
            <Input
              id={`${formId}-name`}
              font="mono"
              autoFocus={!isReplace}
              readOnly={isReplace}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={64}
              placeholder="CLOUDFLARE_API_TOKEN"
              aria-invalid={nameError !== null}
              value={name}
              onChange={(event) => setName(normalizeSecretName(event.target.value))}
            />
            {nameError ? <p className="text-sm text-destructive">{nameError}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-value`}>Value</Label>
            <InputGroup>
              <InputGroupInput
                id={`${formId}-value`}
                font="mono"
                autoFocus={isReplace}
                type={revealed ? "text" : "password"}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                data-1p-ignore=""
                placeholder="Paste the secret"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={revealed ? "Hide value" : "Show value"}
                  aria-pressed={revealed}
                  onClick={() => setRevealed((current) => !current)}
                >
                  {revealed ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </div>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={!canSave}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
