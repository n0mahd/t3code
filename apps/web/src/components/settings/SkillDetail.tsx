import type { EnvironmentId, SkillGetResult, SkillUpdateEntry } from "@t3tools/contracts";
import { AlertTriangleIcon, ArrowLeftIcon, MoreHorizontalIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { useAfterDelay } from "../../hooks/useAfterDelay";
import { useRevealInFileManager } from "../../hooks/useRevealInFileManager";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { copyPath, useEscapeToList } from "./SkillDetailChrome";
import { AgentSwitchChip } from "./SkillAgentSwitch";
import { SkillUpdatePanel } from "./SkillUpdatePanel";
import { hasUpdate } from "./SkillUpdates.logic";
import { UseInPopover, type PlaceOptions } from "./SkillUseIn";
import {
  attention,
  planDelete,
  planToggle,
  planTurnOnAll,
  providedNote,
  scriptFiles,
  skillContext,
  type Skill,
  type SkillPlan,
  type SkillsContext,
} from "./SkillsSettings.logic";

// The tree and viewer pull in the file-tree and highlighter code, so they load when a skill opens.
const SkillFiles = lazy(() => import("./SkillFiles"));

/** How long the file area waits before showing placeholders for a quick read. */
const SKELETON_DELAY_MS = 150;

type DetailState =
  | { status: "loading" }
  | { status: "ready"; result: SkillGetResult }
  | { status: "error" };

function BackBar({ scope, onBack }: { scope: string; onBack: () => void }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground">
      <Button size="xs" variant="ghost-muted" onClick={onBack}>
        <ArrowLeftIcon className="sm:hidden" />
        <span className="sm:hidden">Back</span>
        <span className="hidden sm:inline">Skills</span>
      </Button>
      <span>/ {scope}</span>
    </nav>
  );
}

export function SkillDetail({
  skill,
  ctx,
  environmentId,
  projectRoot,
  places,
  busy,
  update,
  canUpdate,
  onUpdateEntry,
  onBack,
  onPlan,
  onReload,
}: {
  skill: Skill;
  ctx: SkillsContext;
  environmentId: EnvironmentId;
  projectRoot: string | null;
  places: PlaceOptions;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  /** How the skill compares with its source, once updates were checked. */
  update: SkillUpdateEntry | undefined;
  /** The connection may write the skill's files. */
  canUpdate: boolean;
  /** Reading the skill's changes found a more exact comparison than the check's. */
  onUpdateEntry: (entry: SkillUpdateEntry) => void;
  onBack: () => void;
  /** Turns an agent on or off, places or deletes the skill; a plan with a confirmation asks first. */
  onPlan: (plan: SkillPlan) => void;
  /** Opens this skill again, which reads its files again. */
  onReload: () => void;
}) {
  useEscapeToList(onBack);
  const readSkill = useAtomCommand(serverEnvironment.getSkill, { reportFailure: false });
  const [detail, setDetail] = useState<DetailState>({ status: "loading" });
  const { scope, name, home } = skill;
  useEffect(() => {
    let cancelled = false;
    void readSkill({
      environmentId,
      input: { scope, name, home, ...(projectRoot ? { cwd: projectRoot } : {}) },
    }).then((result) => {
      if (cancelled) return;
      setDetail(
        result._tag === "Success" && result.value.home
          ? { status: "ready", result: result.value }
          : { status: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [scope, name, home, projectRoot, environmentId, readSkill]);

  const showSkeleton = useAfterDelay(detail.status === "loading", SKELETON_DELAY_MS);
  const files = useMemo(() => (detail.status === "ready" ? detail.result.files : []), [detail]);
  const scripts = useMemo(() => scriptFiles(files), [files]);
  const skillText = detail.status === "ready" ? detail.result.contents : null;
  // The list only holds a short preview; the header shows the whole description.
  const description =
    (detail.status === "ready" ? detail.result.description : "") || skill.description;
  // The server's resolved folder, not an agent's link.
  const skillFolder = detail.status === "ready" ? detail.result.home : null;
  const reveal = useRevealInFileManager(environmentId);
  const provided = skill.provided !== undefined;
  const scopeLabel = provided
    ? "Built in and plugins"
    : skill.scope === "global"
      ? "Global"
      : "This project";
  // A skill that came with an agent is only about the agents that have it.
  const agents = useMemo(() => skillContext(skill, ctx), [skill, ctx]);
  const warning = provided ? null : attention(skill, ctx);
  const sameCopies = skill.copies.filter((copy) => copy.same);
  const turnOnAll = provided ? null : planTurnOnAll([skill], ctx);
  const del = planDelete([skill], ctx);
  const own = useMemo(() => [skill], [skill]);

  return (
    <section aria-label={`${skill.name} details`} className="min-w-0 space-y-4">
      <BackBar scope={scopeLabel} onBack={onBack} />
      <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-x-2 text-lg font-semibold break-words">
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="cursor-default" />}>
                {skill.name}
              </TooltipTrigger>
              <TooltipPopup>
                <span className="block font-mono break-all">{skill.home}</span>
                {sameCopies.map((copy) => (
                  <span key={`${copy.scope}\0${copy.home}`} className="block">
                    Also in {copy.scope === "global" ? "Global" : "This project"}: {copy.home}
                  </span>
                ))}
              </TooltipPopup>
            </Tooltip>
            {hasUpdate(update) && (
              <Badge variant="info" size="sm">
                Update
              </Badge>
            )}
          </h2>
          {skill.source && <p className="text-xs text-muted-foreground">From {skill.source}</p>}
          <p className="mt-1 text-sm break-words text-muted-foreground">
            {description || "No description yet."}
          </p>
          {provided && (
            <p className="mt-1 text-xs text-muted-foreground">{providedNote(skill, ctx)}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Used by</span>
          {agents.installed.length === 0 && (
            <span className="text-xs text-muted-foreground">No agents are installed.</span>
          )}
          {agents.installed.map((agent) => (
            <AgentSwitchChip
              key={agent.instanceId}
              skill={skill}
              agent={agent}
              ctx={agents}
              busy={busy}
              onToggle={() => {
                const plan = planToggle(skill, agent, agents);
                if (plan) onPlan(plan);
              }}
            />
          ))}
          <span className="flex-1" />
          {!provided && <UseInPopover skills={own} places={places} busy={busy} onPlan={onPlan} />}
          {(skillFolder || turnOnAll || del) && (
            <Menu>
              <MenuTrigger
                render={<Button size="icon-xs" variant="outline" aria-label="More actions" />}
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {skillFolder && (
                  <MenuItem onClick={() => copyPath(skillFolder, "skill path")}>Copy path</MenuItem>
                )}
                {skillFolder && reveal.label && (
                  <MenuItem onClick={() => void reveal.reveal(skillFolder)}>
                    {reveal.label}
                  </MenuItem>
                )}
                {turnOnAll && (
                  <MenuItem disabled={busy} onClick={() => onPlan(turnOnAll)}>
                    Turn on for all agents
                  </MenuItem>
                )}
                {del && <MenuSeparator />}
                {del && (
                  <MenuItem variant="destructive" disabled={busy} onClick={() => onPlan(del)}>
                    Delete…
                  </MenuItem>
                )}
              </MenuPopup>
            </Menu>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {warning && warning.kind !== "missing" && (
            <span className="text-warning-foreground">{warning.detail}</span>
          )}
          {scripts.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    className="flex cursor-default items-center gap-1 text-warning-foreground"
                  />
                }
              >
                <AlertTriangleIcon className="size-3.5 shrink-0" />
                Includes scripts
              </TooltipTrigger>
              <TooltipPopup>
                {scripts.slice(0, 8).join(", ")}
                {scripts.length > 8 && ` and ${scripts.length - 8} more`}
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
      </div>

      {(update?.state === "update" || update?.state === "differs") && (
        <SkillUpdatePanel
          skill={skill}
          environmentId={environmentId}
          projectRoot={projectRoot}
          busy={busy}
          locked={!canUpdate}
          onEntry={onUpdateEntry}
          onPlan={onPlan}
        />
      )}

      <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card/40">
        {detail.status === "loading" && (
          <div role="status" aria-label="Loading the skill's files" className="space-y-2 p-4">
            {showSkeleton ? (
              <>
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </>
            ) : (
              <span className="block h-12" />
            )}
          </div>
        )}
        {detail.status === "error" && (
          <div className="space-y-2 p-4 text-sm">
            <p className="text-warning-foreground">The skill's files couldn't be read.</p>
            <Button size="xs" variant="outline" onClick={onReload}>
              Try again
            </Button>
          </div>
        )}
        {detail.status === "ready" && (
          <Suspense
            fallback={
              <div role="status" aria-label="Loading the file viewer" className="space-y-2 p-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            }
          >
            <SkillFiles
              key={detail.result.home ?? skill.id}
              environmentId={environmentId}
              home={detail.result.home ?? ""}
              files={detail.result.files}
              skillText={skillText}
            />
          </Suspense>
        )}
        {detail.status === "ready" && detail.result.filesTruncated && (
          <p className="border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
            Only some of this skill's files are shown.
          </p>
        )}
      </div>
    </section>
  );
}
