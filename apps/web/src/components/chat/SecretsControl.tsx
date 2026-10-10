// PROTOTYPE(agent-secrets): design review only, mock data, not wired to the server.
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
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
import { SecretDialog, type SecretDialogRequest } from "./SecretDialog";
import { deletePrototypeSecret, usePrototypeSecrets } from "./secretsPrototypeStore";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

export function SecretsControl() {
  const secrets = usePrototypeSecrets();
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

  return (
    <>
      <div ref={anchorRef} role="group" aria-label="Secrets">
        <Menu>
          <MenuTrigger render={<ThreadDetailsControl part="select" aria-label="Secrets" />}>
            <KeyRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              Secrets
            </span>
            {secrets.length > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {secrets.length}
              </span>
            ) : null}
          </MenuTrigger>
          <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
            {secrets.length === 0 ? (
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
                    <MenuItem onClick={() => openDialog({ mode: "replace", name: secret.name })}>
                      <MenuItemLabel>Replace value…</MenuItemLabel>
                    </MenuItem>
                    <MenuItem variant="destructive" onClick={() => openDelete(secret.name)}>
                      <MenuItemLabel>Delete…</MenuItemLabel>
                    </MenuItem>
                  </MenuSubPopup>
                </MenuSub>
              ))
            )}
            <MenuSeparator />
            <MenuItem onClick={() => openDialog({ mode: "add" })}>
              <PlusIcon className="size-4" />
              <MenuItemLabel>Add secret…</MenuItemLabel>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <SecretDialog request={dialogRequest} open={dialogOpen} onOpenChange={setDialogOpen} />

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
                if (deleteName === null) return;
                deletePrototypeSecret(deleteName);
                toastManager.add({ type: "success", title: `Deleted ${deleteName}` });
                setDeleteOpen(false);
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
