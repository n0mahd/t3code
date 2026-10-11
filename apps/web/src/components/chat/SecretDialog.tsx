import {
  isValidAgentSecretName,
  normalizeAgentSecretName,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useId, useState, type ChangeEvent, type FormEvent } from "react";

import { agentSecretEnvironment } from "../../state/agentSecrets";
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
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";

export type SecretDialogRequest =
  | { readonly mode: "add" }
  | { readonly mode: "replace"; name: string };

interface SecretDialogProps {
  environmentId: EnvironmentId;
  /** Names already saved, to catch a duplicate before the server does. */
  existingNames: ReadonlyArray<string>;
  request: SecretDialogRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SecretDialog({
  environmentId,
  existingNames,
  request,
  open,
  onOpenChange,
}: SecretDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        {request ? (
          <SecretForm
            environmentId={environmentId}
            existingNames={existingNames}
            request={request}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** A server message worth showing; anything else would only confuse. */
export function secretFailureMessage(failure: unknown): string | undefined {
  return typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    (failure._tag === "AgentSecretError" || failure._tag === "EnvironmentAuthorizationError") &&
    "message" in failure &&
    typeof failure.message === "string"
    ? failure.message
    : undefined;
}

/**
 * The typed value lives only in this form's state and the RPC payload: it is
 * never logged, toasted, or persisted.
 */
function SecretForm({
  environmentId,
  existingNames,
  request,
  onClose,
}: {
  environmentId: EnvironmentId;
  existingNames: ReadonlyArray<string>;
  request: SecretDialogRequest;
  onClose: () => void;
}) {
  const formId = useId();
  const save = useAtomCommand(agentSecretEnvironment.set, {
    label: "save secret",
    // The failure cause can hold the request, value included; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const isReplace = request.mode === "replace";
  const [name, setName] = useState(isReplace ? request.name : "");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);

  const nameError =
    isReplace || name.length === 0
      ? null
      : !isValidAgentSecretName(name)
        ? "Use letters, numbers and underscores, starting with a letter."
        : existingNames.includes(name)
          ? "You already have a secret with this name."
          : null;
  const canSave =
    !saving && isValidAgentSecretName(name) && nameError === null && value.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const result = await save({
      environmentId,
      input: { name, value: value.trim(), mode: isReplace ? "replace" : "create" },
    }).finally(() => setSaving(false));
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `${isReplace ? "Replaced" : "Saved"} ${name}` });
      onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const description = secretFailureMessage(squashAtomCommandFailure(result));
    toastManager.add({
      type: "error",
      title: `Couldn't save ${name}`,
      ...(description === undefined ? {} : { description }),
    });
  };

  const valueInputProps = {
    id: `${formId}-value`,
    font: "mono",
    autoFocus: isReplace,
    type: "text",
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "none",
    spellCheck: false,
    // Password managers otherwise offer to save or fill this field.
    "data-1p-ignore": "",
    "data-lpignore": "true",
    placeholder: "Paste the secret",
    value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
  } as const;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isReplace ? `Replace ${request.name}` : "Add secret"}</DialogTitle>
        <DialogDescription>
          Agents in every project can use it. You won't be able to view it again.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} className="space-y-4" onSubmit={(event) => void submit(event)}>
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
              onChange={(event) => setName(normalizeAgentSecretName(event.target.value))}
            />
            {nameError ? <p className="text-sm text-destructive">{nameError}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-value`}>Value</Label>
            <InputGroup>
              {revealed ? (
                <InputGroupInput {...valueInputProps} />
              ) : (
                // Masked text rather than a password field: browsers offer to
                // save any submitted password, and this is not a login.
                <InputGroupInput {...valueInputProps} className="[-webkit-text-security:disc]" />
              )}
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
