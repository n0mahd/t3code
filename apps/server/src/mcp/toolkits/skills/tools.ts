import {
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  SkillBatchResult,
  SkillGetResult,
  SkillListResult,
  SkillRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SkillCatalog from "../../../skills/SkillCatalog.ts";
import * as SkillManager from "../../../skills/SkillManager.ts";
import * as SkillTracking from "../../../skills/SkillTracking.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
  ],
};

const projectId = Schema.optional(ProjectId).annotate({
  description:
    "The project whose skills to use. Defaults to the calling thread's project; a client outside a T3 thread passes it for project skills.",
});
const skills = Schema.Array(SkillRef)
  .check(Schema.isMinLength(1), Schema.isMaxLength(200))
  .annotate({
    description:
      "The skills to change, each exactly as t3_skill_list returned it: scope, name and home.",
  });
const agentNames = Schema.Array(ProviderInstanceId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);
const agentsDescription =
  "agents are named by provider instance id or driver kind, as in the access entries t3_skill_list returns.";
const accessNote = "Requires a live full-access/default calling thread or a full-access client.";
const confirm = Schema.optional(Schema.Boolean).annotate({
  description:
    "true to do it. Without it nothing changes, and the result is the plan: what would happen, in plain words.",
});
const twoSteps = (tool: string) =>
  `Call it first without confirm and tell the user the plan; call ${tool} again with the same arguments and confirm: true only once they agree.`;
/** A call without `confirm: true` changes nothing and returns this instead of the outcomes. */
const SkillPlanResult = Schema.Struct({ plan: Schema.Array(Schema.String) });
const placeNotes =
  'Skipped outcomes give a reason: "notFound" or "changed" means the skill is no longer where the list said (list again), "linked" means its folder is reached through a link and stays where it is, "destinationTaken" means something with that name is already there and is never replaced, "inUse" means another program is using the folder, "failed" means a folder couldn\'t be written. blocked lists agents that used a skill but couldn\'t be given it at its new place. sourceDropped means the installer\'s record of where the skill came from couldn\'t go along, so it won\'t update from there.';
const resultNotes =
  'Each outcome says changed, unchanged or skipped. blocked lists agents the change did not reach: "alwaysOn" means the agent reads the skill\'s own folder and T3 Code knows no setting that switches one skill off for it (the access entry says fixed); "setElsewhere" means a project or organization setting decides it; "failed" means the agent\'s settings could not be written safely; "shadowed" means it loads another skill with that name first; "entryTaken" means something else is where the link would go. affected lists agents that gained or lost the skill without being asked, because they read the same folder.';

const SkillListTool = Tool.make("t3_skill_list", {
  ...shared,
  description:
    "List the agent skills T3 Code can see, in a project and in the user's home folder, and which agents can use each (access: direct = reads the skill's folder, link = reached through a link, off = it can see the skill but its own settings switch it off, none = cannot use it; fixed = T3 Code cannot switch that agent for that skill). A skill is named by scope, name and home. Use t3_skill_enable and t3_skill_disable to change who uses it, t3_skill_move to change which projects use it, and t3_skill_delete to delete it.",
  parameters: Schema.Struct({ projectId }),
  success: SkillListResult,
  dependencies: [...shared.dependencies, SkillCatalog.SkillCatalog],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SkillGetTool = Tool.make("t3_skill_get", {
  ...shared,
  description:
    "Read one skill's whole description, its SKILL.md text and its file list. Name the skill by scope, name and home as t3_skill_list returned them.",
  parameters: Schema.Struct({ projectId, ...SkillRef.fields }),
  success: SkillGetResult,
  dependencies: [...shared.dependencies, SkillCatalog.SkillCatalog],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SkillEnableTool = Tool.make("t3_skill_enable", {
  ...shared,
  description: `Let agents use skills by linking each skill into the agent's own skill folder, or by taking away the setting that switches it off in the agent's own settings. Nothing is copied or deleted. agents is "all" for every enabled agent, or a list; ${agentsDescription} ${resultNotes} ${accessNote}`,
  parameters: Schema.Struct({
    projectId,
    skills,
    agents: Schema.Union([Schema.Literal("all"), agentNames]),
  }),
  success: SkillBatchResult,
  dependencies: [...shared.dependencies, SkillManager.SkillManager],
}).annotate(Tool.Destructive, false);

const SkillDisableTool = Tool.make("t3_skill_disable", {
  ...shared,
  description: `Stop agents using skills by removing the agent's link to each skill, or, for an agent that reads the skill's folder itself, by switching the skill off in that agent's own settings (Claude Code, Codex, OpenCode and Pi have one). The skill's own folder is never deleted, and an agent T3 Code can't switch stays on (blocked: alwaysOn). Turn a skill back on with t3_skill_enable. ${agentsDescription} ${resultNotes} ${accessNote}`,
  parameters: Schema.Struct({ projectId, skills, agents: agentNames }),
  success: SkillBatchResult,
  dependencies: [...shared.dependencies, SkillManager.SkillManager],
}).annotate(Tool.Destructive, false);

const SkillMoveTool = Tool.make("t3_skill_move", {
  ...shared,
  description: `Choose where skills are used, as Use in… does in T3 Code's settings. to is "project" for this project only (the skill's folder moves into the project's .agents/skills, so anyone who clones the project gets it), "global" for every project (the folder moves into the user's home folder), or { projects } for only those projects (one Global copy, linked into each, so an edit shows up in all of them). Agents that used a skill keep using it, and nothing with the same name is ever replaced. ${twoSteps("t3_skill_move")} ${placeNotes} ${accessNote}`,
  parameters: Schema.Struct({
    projectId,
    skills,
    to: Schema.Union([
      Schema.Literals(["project", "global"]),
      Schema.Struct({
        projects: Schema.Array(ProjectId)
          .check(Schema.isMinLength(1), Schema.isMaxLength(64))
          .annotate({
            description: "The projects to use the skills in, as t3_project_list names them.",
          }),
      }),
    ]),
    confirm,
  }),
  success: Schema.Union([SkillBatchResult, SkillPlanResult]),
  dependencies: [
    ...shared.dependencies,
    SkillCatalog.SkillCatalog,
    SkillManager.SkillManager,
    SkillTracking.SkillTracking,
  ],
}).annotate(Tool.Destructive, true);

const SkillDeleteTool = Tool.make("t3_skill_delete", {
  ...shared,
  description: `Delete skills: each skill's own folder and the links agents reach it through. Only a skill whose folder is in an agent's skill folder (realFolder in t3_skill_list) can be deleted; one only linked there stays (skipped: "linked"). It can't be undone, except with git for a project skill git tracks; the plan says which. A deleted skill's outcome lists in affected the agents that lost it. ${twoSteps("t3_skill_delete")} ${accessNote}`,
  parameters: Schema.Struct({ projectId, skills, confirm }),
  success: Schema.Union([SkillBatchResult, SkillPlanResult]),
  dependencies: [
    ...shared.dependencies,
    SkillCatalog.SkillCatalog,
    SkillManager.SkillManager,
    SkillTracking.SkillTracking,
  ],
}).annotate(Tool.Destructive, true);

export const SkillsToolkit = Toolkit.make(
  SkillListTool,
  SkillGetTool,
  SkillEnableTool,
  SkillDisableTool,
  SkillMoveTool,
  SkillDeleteTool,
);
