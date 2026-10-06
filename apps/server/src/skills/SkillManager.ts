/**
 * SkillManager - turns skills on or off for each agent by making and removing links.
 *
 * A skill has one home, a real folder. An agent reads it either because the agent reads that
 * folder itself (`direct`) or because a link in a folder the agent reads points at it (`link`).
 * Turning a skill on makes such a link in the agent's own folder; turning it off removes it. Those
 * writes only touch links this service can show lead to the skill's home: a real folder is never
 * replaced by them. Moving and deleting are the only writes that take a real folder, and only one
 * that sits in an agent's skill folder itself (`own`), never a synced library behind a link.
 *
 * Every write starts from what the folders hold now, not from what a client last saw: a skill
 * whose home is not where the client said is refused, and each link is checked again right
 * before it is made or removed (see `SkillLinks`). Writes run one request at a time, and an agent
 * whose skills changed has its skill list for the composer refreshed afterwards.
 *
 * @module SkillManager
 */
import {
  SkillRequestError,
  type ProviderInstanceId,
  type SkillBatchResult,
  type SkillDeleteInput,
  type SkillDisableInput,
  type SkillEnableInput,
  type SkillMoveInput,
  type SkillOutcome,
  type SkillOutcomeReason,
  type SkillRef,
  type SkillRemoveInput,
  type SkillScope,
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
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import { createLink, removeLink, type RemoveLinkResult } from "./SkillLinks.ts";
import { deleteFolder, moveFolder } from "./SkillMove.ts";

type Blocked = SkillOutcome["blocked"][number];

/** What was done to one skill, before it is told to a client. */
interface SkillChange {
  /** A link was made or removed. */
  readonly wrote: boolean;
  /** Agents the change didn't reach. */
  readonly blocked: readonly Blocked[];
  /** Something about the skill as a whole kept the change from being complete. */
  readonly reason?: SkillOutcomeReason | undefined;
  /** Agents that gained or lost the skill without being asked, when the change works that out. */
  readonly affected?: readonly ProviderInstanceId[] | undefined;
  /** Agents whose skill list changed, when the change works that out; their `$` picker is refreshed. */
  readonly touched?: readonly ProviderInstanceId[] | undefined;
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
    /**
     * Make a link in each agent's own folder so it can use each skill. `"all"` means every
     * enabled agent. An agent is named by its instance id, or by its driver kind to mean every
     * instance of that driver when no instance has that id.
     */
    readonly enable: (
      input: Omit<SkillEnableInput, "agents"> & {
        readonly agents: SkillEnableInput["agents"] | "all";
      },
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Remove each agent's link to each skill. Agents are named as for `enable`. */
    readonly disable: (
      input: SkillDisableInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Remove every link to each skill. The skills' own folders are never touched. */
    readonly remove: (
      input: SkillRemoveInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Move each skill's folder to the other scope; the agents that used it keep using it. */
    readonly move: (input: SkillMoveInput) => Effect.Effect<SkillBatchResult, SkillRequestError>;
    /** Delete each skill's own folder and every link to it. */
    readonly delete: (
      input: SkillDeleteInput,
    ) => Effect.Effect<SkillBatchResult, SkillRequestError>;
  }
>()("t3/skills/SkillManager") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const catalog = yield* SkillCatalog.SkillCatalog;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
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

  /** The links among the skills' entries, with what each points at as written. */
  const linksTo = (skills: ReadonlyArray<SkillCatalog.ResolvedSkill>) =>
    skills.flatMap((skill) =>
      skill.entries.flatMap((entry) =>
        entry.target === undefined ? [] : [{ path: entry.path, target: entry.target }],
      ),
    );

  const removeOne = Effect.fnUntraced(function* (skill: SkillCatalog.ResolvedSkill) {
    const results = new Set((yield* removeAll(linksTo([skill]))).values());
    const reason: SkillOutcomeReason | undefined = results.has("failed")
      ? "failed"
      : results.has("changed")
        ? "changed"
        : undefined;
    return { wrote: results.has("removed"), blocked: [], reason } satisfies SkillChange;
  });

  const skipped = (reason: SkillOutcomeReason): SkillChange => ({
    wrote: false,
    blocked: [],
    reason,
  });

  /** Every group that reaches this skill's folder, in either scope: the folder's whole audience. */
  const reaching = (
    skill: SkillCatalog.ResolvedSkill,
    all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
  ) => all.filter((other) => other.name === skill.name && other.home === skill.home);

  const agentsWith = (skills: ReadonlyArray<SkillCatalog.ResolvedSkill>) =>
    new Set(
      skills.flatMap((skill) =>
        skill.agents.filter((agent) => hasSkill(agent.state)).map((agent) => agent.instanceId),
      ),
    );

  const moveOne = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    to: SkillScope,
    cwd: string,
    projectRoot: string | undefined,
    all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
  ) {
    if (skill.scope === to) return { wrote: false, blocked: [] } satisfies SkillChange;
    if (!skill.own) return skipped("linked");
    const folder = skill.standardFolders[to];
    if (folder === undefined) return skipped("failed");
    const destination = path.join(folder, skill.name);
    // Whatever is under the name there, a skill or not, is never merged into or replaced.
    if (all.some((other) => other.scope === to && other.name === skill.name)) {
      return skipped("destinationTaken");
    }

    const audience = reaching(skill, all);
    const had = agentsWith(audience);
    const stale = linksTo(audience);
    const moved = yield* moveFolder({ from: skill.home, to: destination, platform }).pipe(
      Effect.provideContext(filesystemContext),
      Effect.catchTags({ SkillMoveError: () => Effect.succeed("failed" as const) }),
    );
    if (moved === "taken") return skipped("destinationTaken");
    if (moved === "inUse") return skipped("inUse");
    if (moved === "failed") return skipped("failed");

    // The folder is in its new place; the links that led to the old one lead nowhere now. They go
    // before new ones are made, because a new link may need the same path.
    yield* removeAll(stale);
    const real = yield* fileSystem
      .realPath(destination)
      .pipe(Effect.orElseSucceed(() => destination));
    const landed = (yield* catalog.resolve({
      cwd,
      skills: [{ scope: to, name: skill.name }],
    })).find((item) => item.scope === to && item.home === real);
    const reason = moved === "movedWithLeftover" ? ("failed" as const) : undefined;
    if (landed === undefined) {
      return {
        wrote: true,
        blocked: [],
        reason: "failed",
        touched: [...had],
      } satisfies SkillChange;
    }

    // Every agent that used the skill keeps using it. One that reads the new scope's shared folder
    // already does; any other gets a link in its own folder, by the same rules as turning it on.
    const lacking = new Set(
      landed.agents
        .filter((agent) => had.has(agent.instanceId) && agent.state === "none")
        .map((agent) => agent.instanceId),
    );
    const relinked =
      lacking.size === 0
        ? { wrote: false, blocked: [] as readonly Blocked[] }
        : yield* enableOne(landed, lacking, projectRoot);
    const settled = relinked.wrote
      ? ((yield* catalog.resolve({ cwd, skills: [{ scope: to, name: skill.name }] })).find(
          (item) => item.scope === to && item.home === real,
        ) ?? landed)
      : landed;
    const has = agentsWith([settled]);
    const unreached = new Set(relinked.blocked.map((item) => item.instanceId));
    const touched = [...new Set([...had, ...has])];
    return {
      wrote: true,
      blocked: relinked.blocked,
      reason,
      touched,
      affected: touched.filter((id) => had.has(id) !== has.has(id) && !unreached.has(id)),
    } satisfies SkillChange;
  });

  const deleteOne = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
  ) {
    if (!skill.own) return skipped("linked");
    const audience = reaching(skill, all);
    const had = [...agentsWith(audience)];
    const failed = yield* deleteFolder(skill.home).pipe(
      Effect.provideContext(filesystemContext),
      Effect.as(false),
      Effect.catchTags({ SkillMoveError: () => Effect.succeed(true) }),
    );
    // A delete that stopped before touching SKILL.md changed nothing an agent can see.
    if (
      failed &&
      (yield* fileSystem
        .exists(path.join(skill.home, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => true)))
    ) {
      return skipped("failed");
    }
    const results = new Set((yield* removeAll(linksTo(audience))).values());
    const reason: SkillOutcomeReason | undefined =
      failed || results.has("failed") ? "failed" : results.has("changed") ? "changed" : undefined;
    return {
      wrote: true,
      blocked: [],
      reason,
      affected: had,
      touched: had,
    } satisfies SkillChange;
  });

  /**
   * Refreshes the skills the composer's `$` picker lists for agents whose skills changed: the
   * project's own list when a project is open, else the agent's machine-wide one. A scan can take
   * seconds, since some agents answer through their CLI, and the change is already on disk, so it
   * runs in the background and a scan that fails changes nothing.
   */
  const refreshPickers = (cwd: string | undefined, instances: Iterable<ProviderInstanceId>) =>
    Effect.forEach(
      instances,
      (instanceId) =>
        cwd === undefined
          ? providers.refreshInstance(instanceId)
          : providers.refreshWorkspaceSnapshot({ instanceId, cwd, fresh: true }),
      { discard: true },
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  /**
   * Looks every skill up as the folders hold it now, applies `change` to those that are still
   * where the client said, and tells what happened to each. An agent that gained or lost a skill
   * without being asked is found by reading the folders again afterwards.
   */
  const run = (input: {
    readonly cwd: string | undefined;
    readonly skills: ReadonlyArray<SkillRef>;
    readonly agents: "all" | ReadonlySet<string>;
    /** Skills to look up besides those asked for, such as the same names in the other scope. */
    readonly alsoLookUp?: ReadonlyArray<{ readonly scope: SkillScope; readonly name: string }>;
    readonly change: (
      skill: SkillCatalog.ResolvedSkill,
      agents: ReadonlySet<ProviderInstanceId>,
      projectRoot: string | undefined,
      /** Everything looked up, which includes the skills asked for. */
      all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
    ) => Effect.Effect<SkillChange>;
  }) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        if (input.cwd !== undefined) yield* requireProject(input.cwd);
        const before = yield* catalog.resolve({
          cwd: input.cwd,
          skills: [...input.skills, ...(input.alsoLookUp ?? [])],
        });
        const instances = before[0]?.agents ?? [];
        const agents = new Set<ProviderInstanceId>();
        for (const name of input.agents === "all" ? [] : input.agents) {
          const byId = instances.filter((agent) => agent.instanceId === name);
          const matches =
            byId.length > 0 ? byId : instances.filter((agent) => agent.driver === name);
          if (matches.length === 0 && instances.length > 0) {
            return yield* new SkillRequestError({ reason: "unknownAgent" });
          }
          for (const agent of matches) agents.add(agent.instanceId);
        }
        if (input.agents === "all") for (const agent of instances) agents.add(agent.instanceId);
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
            return { ref, found, change: yield* input.change(found, agents, projectRoot, before) };
          }),
        );

        const after = changes.some((entry) => entry.change.wrote)
          ? yield* catalog.resolve({ cwd: input.cwd, skills: input.skills })
          : before;
        const results = changes.map(({ ref, found, change }) => {
          const now = after.find(
            (skill) =>
              skill.scope === ref.scope &&
              skill.name === ref.name &&
              skill.displayHome === ref.home,
          );
          // Agents whose use of the skill flipped, whether they were asked for or not.
          const flipped =
            found === undefined
              ? []
              : found.agents
                  .filter(
                    (agent) =>
                      hasSkill(agent.state) !==
                      hasSkill(
                        now?.agents.find((other) => other.instanceId === agent.instanceId)?.state ??
                          "none",
                      ),
                  )
                  .map((agent) => agent.instanceId);
          return {
            // Only what this request wrote counts; a change someone else made meanwhile doesn't.
            touched: change.wrote ? (change.touched ?? flipped) : [],
            outcome: {
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
              affected: change.affected ?? flipped.filter((id) => !agents.has(id)),
            } satisfies SkillOutcome,
          };
        });

        const touched = new Set(results.flatMap((result) => result.touched));
        if (touched.size > 0) yield* refreshPickers(input.cwd, touched);
        return { outcomes: results.map((result) => result.outcome) } satisfies SkillBatchResult;
      }),
    );

  return SkillManager.of({
    enable: Effect.fn("SkillManager.enable")(function* (input) {
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: input.agents === "all" ? "all" : new Set(input.agents),
        change: enableOne,
      });
    }),
    disable: Effect.fn("SkillManager.disable")(function* (input) {
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: new Set(input.agents),
        change: disableOne,
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
    move: Effect.fn("SkillManager.move")(function* (input) {
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: new Set(),
        alsoLookUp: input.skills.map((ref) => ({ scope: input.to, name: ref.name })),
        change: (skill, _agents, projectRoot, all) =>
          moveOne(skill, input.to, input.cwd, projectRoot, all),
      });
    }),
    delete: Effect.fn("SkillManager.delete")(function* (input) {
      return yield* run({
        cwd: input.cwd,
        skills: input.skills,
        agents: new Set(),
        // Links from the other scope lead to the folder too, and would be left dangling.
        alsoLookUp: input.skills.map((ref) => ({
          scope: ref.scope === "project" ? ("global" as const) : ("project" as const),
          name: ref.name,
        })),
        change: (skill, _agents, _projectRoot, all) => deleteOne(skill, all),
      });
    }),
  });
});

export const layer = Layer.effect(SkillManager, make);
