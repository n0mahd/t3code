/**
 * SkillManager - turns skills on or off for each agent by making and removing links.
 *
 * A skill has one home, a real folder. An agent reads it either because the agent reads that
 * folder itself (`direct`) or because a link in a folder the agent reads points at it (`link`).
 * Turning a skill on makes such a link in the agent's own folder; turning it off removes it. The
 * only things written are links this service can show lead to the skill's home: a real folder is
 * never replaced, moved or deleted here.
 *
 * Every write starts from what the folders hold now, not from what a client last saw: a skill
 * whose home is not where the client said is refused, and each link is checked again right
 * before it is made or removed (see `SkillLinks`). Writes run one request at a time.
 *
 * @module SkillManager
 */
import {
  SkillRequestError,
  type ProviderInstanceId,
  type SkillBatchResult,
  type SkillDisableInput,
  type SkillEnableInput,
  type SkillOutcome,
  type SkillOutcomeReason,
  type SkillRef,
  type SkillRemoveInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProjectService from "../project/ProjectService.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import { createLink, removeLink, type RemoveLinkResult } from "./SkillLinks.ts";

type Blocked = SkillOutcome["blocked"][number];

/** What was done to one skill, before it is told to a client. */
interface SkillChange {
  /** A link was made or removed. */
  readonly wrote: boolean;
  /** Agents the change didn't reach. */
  readonly blocked: readonly Blocked[];
  /** Something about the skill as a whole kept the change from being complete. */
  readonly reason?: SkillOutcomeReason | undefined;
}

/**
 * Links to make so each requested agent that doesn't use the skill yet gets it. An agent gets its
 * link in the shared folder when it reads that, else in its own first folder for the skill's
 * scope; agents that read the same folder share one link.
 */
export const planEnable = (
  skill: SkillCatalog.ResolvedSkill,
  requested: ReadonlySet<ProviderInstanceId>,
) => {
  const links = new Map<string, { directory: string; agents: ProviderInstanceId[] }>();
  const blocked: Blocked[] = [];
  for (const agent of skill.agents) {
    if (!requested.has(agent.instanceId) || agent.state !== "none") continue;
    const shared = agent.reads.findIndex((read) => read.scope === skill.scope && read.standard);
    const index =
      shared >= 0 ? shared : agent.reads.findIndex((read) => read.scope === skill.scope);
    const root = agent.reads[index];
    if (root === undefined) {
      blocked.push({ instanceId: agent.instanceId, reason: "failed" });
      continue;
    }
    // A link would never load if the agent finds another skill with this name first.
    if (
      agent.collision === "first-wins" &&
      agent.reads.slice(0, index).some((read) => read.rival)
    ) {
      blocked.push({ instanceId: agent.instanceId, reason: "shadowed" });
      continue;
    }
    // Linked there already, though the agent doesn't load it (Claude can't read its header).
    if (skill.entries.some((entry) => entry.directory === root.directory)) continue;
    const link = links.get(root.directory);
    if (link) link.agents.push(agent.instanceId);
    else links.set(root.directory, { directory: root.directory, agents: [agent.instanceId] });
  }
  return { links: [...links.values()], blocked };
};

/**
 * Links to remove so each requested agent stops using the skill. An agent that reads the
 * skill's own folder, or a link in the shared folder that serves other agents too, stays on.
 */
const planDisable = (
  skill: SkillCatalog.ResolvedSkill,
  requested: ReadonlySet<ProviderInstanceId>,
) => {
  const unlinks = new Map<string, { path: string; target: string; agents: ProviderInstanceId[] }>();
  const blocked: Blocked[] = [];
  for (const agent of skill.agents) {
    if (!requested.has(agent.instanceId) || agent.state === "none") continue;
    const entries = skill.entries.filter((entry) => agent.via.includes(entry.path));
    if (agent.state === "direct" || entries.some((entry) => entry.target === undefined)) {
      blocked.push({ instanceId: agent.instanceId, reason: "alwaysOn" });
      continue;
    }
    for (const entry of entries) {
      if (entry.target === undefined) continue;
      const unlink = unlinks.get(entry.path);
      if (unlink) unlink.agents.push(agent.instanceId);
      else
        unlinks.set(entry.path, {
          path: entry.path,
          target: entry.target,
          agents: [agent.instanceId],
        });
    }
  }
  return { unlinks: [...unlinks.values()], blocked };
};

const hasSkill = (state: "direct" | "link" | "none") => state !== "none";

export class SkillManager extends Context.Service<
  SkillManager,
  {
    /** Make a link in each agent's own folder so it can use each skill. */
    readonly enable: (
      input: SkillEnableInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Remove each agent's link to each skill. */
    readonly disable: (
      input: SkillDisableInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Remove every link to each skill. The skills' own folders are never touched. */
    readonly remove: (
      input: SkillRemoveInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
  }
>()("t3/skills/SkillManager") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const catalog = yield* SkillCatalog.SkillCatalog;
  const projects = yield* ProjectService.ProjectService;
  const writeLock = yield* Semaphore.make(1);
  // The link primitives take the filesystem from their environment.
  const filesystemContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  /** Links are only written under a folder the environment knows as a project. */
  const requireProject = (cwd: string) =>
    projects.getByWorkspaceRoot(cwd).pipe(
      Effect.orDie,
      Effect.filterOrFail(
        Option.isSome,
        () => new SkillRequestError({ reason: "projectNotRegistered" }),
      ),
    );

  const removeAll = Effect.fnUntraced(function* (
    entries: ReadonlyArray<{ readonly path: string; readonly target: string }>,
  ) {
    const results = new Map<string, RemoveLinkResult | "failed">();
    for (const entry of entries) {
      results.set(
        entry.path,
        yield* removeLink({ path: entry.path, expectedTarget: entry.target }).pipe(
          Effect.provideContext(filesystemContext),
          Effect.catchTags({ SkillLinkError: () => Effect.succeed("failed" as const) }),
        ),
      );
    }
    return results;
  });

  const enableOne = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    requested: ReadonlySet<ProviderInstanceId>,
    projectRoot: string | undefined,
  ) {
    const plan = planEnable(skill, requested);
    const blocked: Blocked[] = [...plan.blocked];
    let wrote = false;
    for (const link of plan.links) {
      const result = yield* createLink({
        link: path.join(link.directory, skill.name),
        home: skill.home,
        scope: skill.scope,
        platform,
        projectRoot,
      }).pipe(
        Effect.provideContext(filesystemContext),
        Effect.catchTags({ SkillLinkError: () => Effect.succeed("failed" as const) }),
      );
      if (result === "created") wrote = true;
      else if (result !== "unchanged") {
        const reason: SkillOutcomeReason =
          result === "taken" ? "entryTaken" : result === "notAllowed" ? "linkNotAllowed" : "failed";
        for (const instanceId of link.agents) blocked.push({ instanceId, reason });
      }
    }
    return { wrote, blocked } satisfies SkillChange;
  });

  const disableOne = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    requested: ReadonlySet<ProviderInstanceId>,
  ) {
    const plan = planDisable(skill, requested);
    const results = yield* removeAll(plan.unlinks);
    const blocked: Blocked[] = [...plan.blocked];
    let wrote = false;
    for (const unlink of plan.unlinks) {
      const result = results.get(unlink.path);
      if (result === "removed") wrote = true;
      else if (result === "changed" || result === "failed") {
        for (const instanceId of unlink.agents) {
          blocked.push({ instanceId, reason: result });
        }
      }
    }
    return { wrote, blocked } satisfies SkillChange;
  });

  const removeOne = Effect.fnUntraced(function* (skill: SkillCatalog.ResolvedSkill) {
    const links = skill.entries.flatMap((entry) =>
      entry.target === undefined ? [] : [{ path: entry.path, target: entry.target }],
    );
    const results = new Set((yield* removeAll(links)).values());
    const reason: SkillOutcomeReason | undefined = results.has("failed")
      ? "failed"
      : results.has("changed")
        ? "changed"
        : undefined;
    return { wrote: results.has("removed"), blocked: [], reason } satisfies SkillChange;
  });

  /**
   * Looks every skill up as the folders hold it now, applies `change` to those that are still
   * where the client said, and tells what happened to each. An agent that gained or lost a skill
   * without being asked is found by reading the folders again afterwards.
   */
  const run = (input: {
    readonly cwd: string | undefined;
    readonly skills: ReadonlyArray<SkillRef>;
    readonly agents: ReadonlySet<ProviderInstanceId>;
    readonly change: (
      skill: SkillCatalog.ResolvedSkill,
      projectRoot: string | undefined,
    ) => Effect.Effect<SkillChange>;
  }) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        if (input.cwd !== undefined) yield* requireProject(input.cwd);
        const before = yield* catalog.resolve({ cwd: input.cwd, skills: input.skills });
        const known = new Set((before[0]?.agents ?? []).map((agent) => agent.instanceId));
        if (known.size > 0 && [...input.agents].some((id) => !known.has(id))) {
          return yield* new SkillRequestError({ reason: "unknownAgent" });
        }
        const projectRoot =
          input.cwd === undefined
            ? undefined
            : yield* fileSystem.realPath(input.cwd).pipe(Effect.orElseSucceed(() => input.cwd));

        const changes = yield* Effect.forEach(input.skills, (ref) =>
          Effect.gen(function* () {
            const candidates = before.filter(
              (skill) => skill.scope === ref.scope && skill.name === ref.name,
            );
            const found = candidates.find((skill) => skill.displayHome === ref.home);
            if (found === undefined) {
              const reason = candidates.length > 0 ? "changed" : "notFound";
              return { ref, found, change: { wrote: false, blocked: [], reason } as SkillChange };
            }
            return { ref, found, change: yield* input.change(found, projectRoot) };
          }),
        );

        const after = changes.some((entry) => entry.change.wrote)
          ? yield* catalog.resolve({ cwd: input.cwd, skills: input.skills })
          : before;
        return {
          outcomes: changes.map(({ ref, found, change }): SkillOutcome => {
            const now = after.find(
              (skill) =>
                skill.scope === ref.scope &&
                skill.name === ref.name &&
                skill.displayHome === ref.home,
            );
            const affected =
              found === undefined
                ? []
                : found.agents
                    .filter(
                      (agent) =>
                        !input.agents.has(agent.instanceId) &&
                        hasSkill(agent.state) !==
                          hasSkill(
                            now?.agents.find((other) => other.instanceId === agent.instanceId)
                              ?.state ?? "none",
                          ),
                    )
                    .map((agent) => agent.instanceId);
            return {
              skill: ref,
              status: change.wrote
                ? "changed"
                : change.reason !== undefined || change.blocked.length > 0
                  ? "skipped"
                  : "unchanged",
              ...(change.reason === undefined ? {} : { reason: change.reason }),
              blocked: change.blocked.filter(
                (item, index, all) =>
                  all.findIndex((other) => other.instanceId === item.instanceId) === index,
              ),
              affected,
            };
          }),
        } satisfies SkillBatchResult;
      }),
    );

  return SkillManager.of({
    enable: Effect.fn("SkillManager.enable")(function* (input) {
      const agents = new Set(input.agents);
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents,
        change: (skill, projectRoot) => enableOne(skill, agents, projectRoot),
      });
    }),
    disable: Effect.fn("SkillManager.disable")(function* (input) {
      const agents = new Set(input.agents);
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents,
        change: (skill) => disableOne(skill, agents),
      });
    }),
    remove: Effect.fn("SkillManager.remove")(function* (input) {
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: new Set(),
        change: (skill) => removeOne(skill),
      });
    }),
  });
});

export const layer = Layer.effect(SkillManager, make);
