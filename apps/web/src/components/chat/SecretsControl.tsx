import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { agentSecretEnvironment } from "../../state/agentSecrets";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { SecretDialog, secretFailureMessage, type SecretDialogRequest } from "./SecretDialog";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/** The environment's saved agent secrets: names only, with replace, delete and add. */
export function SecretsControl({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(agentSecretEnvironment.list({ environmentId, input: {} }));
  const canWrite = useAtomValue(agentSecretEnvironment.set.permissionAtom(environmentId));
  const deleteSecret = useAtomCommand(agentSecretEnvironment.delete, "delete secret");
  const secrets = query.data?.secrets ?? null;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // The request outlives `open` so the dialog keeps its content while it fades out.
  const [dialogRequest, setDialogRequest] = useState<SecretDialogRequest | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const openDialog = (request: SecretDialogRequest) => {
    setDialogRequest(request);
    setDialogOpen(true);
  };
  const openDelete = (name: string) => {
    setDeleteName(name);
    setDeleteOpen(true);
  };
  const confirmDelete = async (name: string) => {
    setDeleteOpen(false);
    const result = await deleteSecret({ environmentId, input: { name } });
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Deleted ${name}` });
    } else if (!isAtomCommandInterrupted(result)) {
      const description = secretFailureMessage(squashAtomCommandFailure(result));
      toastManager.add({
        type: "error",
        title: `Couldn't delete ${name}`,
        ...(description === undefined ? {} : { description }),
      });
    }
  };

  return (
    <>
      <div ref={anchorRef} role="group" aria-label="Secrets">
        <Menu
          onOpenChange={(open) => {
            // Another device may have changed the list since it loaded.
            if (open) query.refresh();
          }}
        >
          <MenuTrigger render={<ThreadDetailsControl part="select" aria-label="Secrets" />}>
            <KeyRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              Secrets
            </span>
            {secrets !== null && secrets.length > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {secrets.length}
              </span>
            ) : null}
          </MenuTrigger>
          <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
            {secrets === null ? null : secrets.length === 0 ? (
              <MenuItem disabled>
                <span className="min-w-0 truncate text-muted-foreground">No secrets yet</span>
              </MenuItem>
            ) : (
              secrets.map((secret) => (
                <MenuSub key={secret.name}>
                  <MenuSubTrigger>
                    <span className="min-w-0 truncate font-mono">{secret.name}</span>
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuItem
                      disabled={!canWrite}
                      onClick={() => openDialog({ mode: "replace", name: secret.name })}
                    >
                      <MenuItemLabel>Replace value…</MenuItemLabel>
                    </MenuItem>
                    <MenuItem
                      variant="destructive"
                      disabled={!canWrite}
                      onClick={() => openDelete(secret.name)}
                    >
                      <MenuItemLabel>Delete…</MenuItemLabel>
                    </MenuItem>
                  </MenuSubPopup>
                </MenuSub>
              ))
            )}
            {secrets === null ? null : <MenuSeparator />}
            <MenuItem disabled={!canWrite} onClick={() => openDialog({ mode: "add" })}>
              <PlusIcon className="size-4" />
              <MenuItemLabel>Add secret…</MenuItemLabel>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <SecretDialog
        environmentId={environmentId}
        existingNames={secrets?.map((secret) => secret.name) ?? []}
        request={dialogRequest}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteName}?</AlertDialogTitle>
            <AlertDialogDescription>Agents can no longer use it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteName !== null) void confirmDelete(deleteName);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
