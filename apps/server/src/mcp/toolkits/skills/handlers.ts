import {
  OrchestratorMcpFailure,
  type ProjectId,
  type SkillCreateError,
  type SkillPlacement,
  type SkillRef,
  type SkillRequestError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SkillCatalog from "../../../skills/SkillCatalog.ts";
import * as SkillManager from "../../../skills/SkillManager.ts";
import * as SkillTracking from "../../../skills/SkillTracking.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable, type Caller } from "../../threadAccess.ts";
import { planDelete, planMove } from "./plans.ts";
import { SkillsToolkit } from "./tools.ts";

const skillFailure = (error: SkillRequestError | SkillCreateError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** A registered project that hasn't been deleted. */
const registeredProject = Effect.fnUntraced(function* (id: ProjectId) {
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(id).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project) || project.value.deletedAt !== null)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  return project.value;
});

/**
 * The project the call is about: the one passed, else the calling thread's. Without either,
 * project skills can't be reached: `required` says whether that is a failure (a change to a
 * project skill) or just means the global skills alone (a read).
 */
const projectFolder = Effect.fnUntraced(function* (
  context: Caller,
  projectId: ProjectId | undefined,
  required: boolean,
) {
  if (projectId === undefined && context.caller === undefined && !required) return undefined;
  return (yield* registeredProject(yield* resolveProjectId(context, projectId))).workspaceRoot;
});

/**
 * Changing skills rewrites the folders agents run from, so it needs full access;
 * `McpToolAccess.writesEnvironment` checks that. Only a change to a project skill needs a project.
 */
const changeFolder = (
  context: Caller,
  projectId: ProjectId | undefined,
  skills: ReadonlyArray<SkillRef>,
) =>
  projectFolder(
    context,
    projectId,
    skills.some((skill) => skill.scope === "project"),
  );

/** The names of the project skills among `skills` git tracks, so a plan can say git can undo it. */
const trackedNames = (cwd: string | undefined, skills: ReadonlyArray<SkillRef>) =>
  Effect.gen(function* () {
    if (cwd === undefined || !skills.some((skill) => skill.scope === "project")) return [];
    const tracking = yield* SkillTracking.SkillTracking;
    return (yield* tracking.tracked({ cwd, skills })).tracked;
  });

/**
 * Where `t3_skill_move` puts the skills, the folder of the project they are listed for, and the
 * names of the projects the placement is about. "project" is the project the call is about.
 */
const moveTarget = Effect.fnUntraced(function* (
  context: Caller,
  projectId: ProjectId | undefined,
  skills: ReadonlyArray<SkillRef>,
  to: "project" | "global" | { readonly projects: ReadonlyArray<ProjectId> },
) {
  if (to === "project") {
    const project = yield* registeredProject(yield* resolveProjectId(context, projectId));
    const cwd = project.workspaceRoot;
    const placement: SkillPlacement = { kind: "project", cwd };
    return { cwd, placement, projectNames: [project.title] };
  }
  const cwd = yield* changeFolder(context, projectId, skills);
  if (to === "global") {
    const placement: SkillPlacement = { kind: "global" };
    return { cwd, placement, projectNames: [] };
  }
  const projects = yield* Effect.forEach(to.projects, registeredProject);
  const placement: SkillPlacement = {
    kind: "projects",
    cwds: projects.map((project) => project.workspaceRoot),
  };
  return { cwd, placement, projectNames: projects.map((project) => project.title) };
});

/** The skills as the list shows them now, which is what a plan is worded from. */
const listedSkills = (cwd: string | undefined) =>
  Effect.gen(function* () {
    const catalog = yield* SkillCatalog.SkillCatalog;
    return (yield* catalog.list({ cwd })).skills;
  });

export const layer = McpToolAccess.toLayer(SkillsToolkit, {
  t3_skill_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const cwd = yield* projectFolder(context, input.projectId, false);
      const catalog = yield* SkillCatalog.SkillCatalog;
      return yield* catalog.list({ cwd }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_get: McpToolAccess.reads(({ projectId, ...skill }) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const cwd = yield* projectFolder(context, projectId, skill.scope === "project");
      const catalog = yield* SkillCatalog.SkillCatalog;
      return yield* catalog.get({ cwd, ...skill }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_enable: McpToolAccess.writesEnvironment(({ projectId, ...input }, check) =>
    Effect.gen(function* () {
      const cwd = yield* changeFolder(yield* check, projectId, input.skills);
      const manager = yield* SkillManager.SkillManager;
      return yield* manager.enable({ cwd, ...input }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_disable: McpToolAccess.writesEnvironment(({ projectId, ...input }, check) =>
    Effect.gen(function* () {
      const cwd = yield* changeFolder(yield* check, projectId, input.skills);
      const manager = yield* SkillManager.SkillManager;
      return yield* manager.disable({ cwd, ...input }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_create: McpToolAccess.writesEnvironment(({ projectId, ...input }, check) =>
    Effect.gen(function* () {
      const cwd = yield* projectFolder(yield* check, projectId, input.scope === "project");
      const manager = yield* SkillManager.SkillManager;
      return yield* manager.create({ cwd, ...input }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  // Without `confirm: true` these only read: the list, and which project skills git tracks.
  t3_skill_move: McpToolAccess.writesEnvironment(({ projectId, skills, to, confirm }, check) =>
    Effect.gen(function* () {
      const { cwd, placement, projectNames } = yield* moveTarget(
        yield* check,
        projectId,
        skills,
        to,
      );
      if (confirm === true) {
        const manager = yield* SkillManager.SkillManager;
        return yield* manager
          .place({ cwd, skills, to: placement })
          .pipe(Effect.mapError(skillFailure));
      }
      return yield* Effect.gen(function* () {
        const listed = yield* listedSkills(cwd);
        const tracked = placement.kind === "project" ? [] : yield* trackedNames(cwd, skills);
        return { plan: planMove({ listed, skills, to: placement, projectNames, tracked }) };
      }).pipe(Effect.mapError(skillFailure));
    }),
  ),
  t3_skill_delete: McpToolAccess.writesEnvironment(({ projectId, skills, confirm }, check) =>
    Effect.gen(function* () {
      const cwd = yield* changeFolder(yield* check, projectId, skills);
      if (confirm === true) {
        const manager = yield* SkillManager.SkillManager;
        return yield* manager.delete({ cwd, skills }).pipe(Effect.mapError(skillFailure));
      }
      return yield* Effect.gen(function* () {
        const listed = yield* listedSkills(cwd);
        const tracked = yield* trackedNames(cwd, skills);
        return { plan: planDelete({ listed, skills, tracked }) };
      }).pipe(Effect.mapError(skillFailure));
    }),
  ),
});
