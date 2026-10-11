import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Secrets the user saved for agents on an environment. The list holds names
 * and dates only; values go to the server and never come back.
 */
export function createAgentSecretEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:secrets:list",
    tag: WS_METHODS.secretsList,
  });
  const refreshList = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => registry.refresh(list({ environmentId: target.environmentId, input: {} })));
  return {
    list,
    set: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:secrets:set",
      tag: WS_METHODS.secretsSet,
      onSettled: refreshList,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:secrets:delete",
      tag: WS_METHODS.secretsDelete,
      onSettled: refreshList,
    }),
  };
}
