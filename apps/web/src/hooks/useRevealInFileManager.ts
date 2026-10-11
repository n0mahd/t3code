import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { revealInFileManagerLabel } from "../components/preview/fileExplorerLabel";
import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Shows a file or folder in the file manager of the machine running the T3 server. That is the
 * person's own machine only in the desktop app's local environment, so `label` ("Reveal in
 * Finder") is undefined on the web, for a remote environment, and where the server can't reveal.
 */
export function useRevealInFileManager(environmentId: EnvironmentId) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const primaryId = usePrimaryEnvironmentId();
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const label =
    isElectron && environmentId === primaryId ? revealInFileManagerLabel(serverConfig) : undefined;
  const reveal = useCallback(
    async (path: string) => {
      const result = await openInEditor({
        environmentId,
        input: { cwd: path, editor: "file-manager", reveal: true },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Unable to reveal", description: path });
      }
    },
    [environmentId, openInEditor],
  );
  return { label, reveal };
}
