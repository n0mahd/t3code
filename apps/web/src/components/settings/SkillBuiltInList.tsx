import { ChevronRightIcon } from "lucide-react";
import { memo, useMemo, useState, type MouseEvent } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { SettingsGroup } from "./SettingsGroup";
import { IconRow, SkillAgentIcon } from "./skillAgentIcon";
import {
  canSwitch,
  hasAccess,
  planRowSwitch,
  providedNote,
  rowSwitchOn,
  skillContext,
  type Skill,
  type SkillPlan,
  type SkillsContext,
} from "./SkillsSettings.logic";

/** Keeps a click on the switch inside a clickable row from also opening the skill. */
const stopRowClick = (event: MouseEvent) => event.stopPropagation();

/**
 * A skill that came with an agent: who it came with, and a switch only where that agent has a
 * setting T3 Code can write. A click opens it.
 */
const BuiltInRow = memo(function BuiltInRow({
  skill,
  ctx,
  busy,
  onPlan,
  onOpen,
}: {
  skill: Skill;
  ctx: SkillsContext;
  busy: boolean;
  onPlan: (plan: SkillPlan) => void;
  onOpen: (id: string) => void;
}) {
  const own = useMemo(() => skillContext(skill, ctx), [skill, ctx]);
  return (
    <li className="min-w-0">
      <div
        onClick={() => onOpen(skill.id)}
        className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 py-2 pr-3 pl-3 hover:bg-muted/40 sm:pr-4 sm:pl-4"
      >
        <button
          type="button"
          className="min-w-40 flex-1 cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="block truncate text-sm font-medium">{skill.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {skill.description || "No description yet."}
          </span>
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {own.installed.length > 0 && (
            <IconRow label={providedNote(skill, ctx)}>
              {own.installed.map((agent) => (
                <SkillAgentIcon
                  key={agent.instanceId}
                  agent={agent}
                  agents={ctx.installed}
                  active={hasAccess(skill, agent)}
                />
              ))}
            </IconRow>
          )}
          {canSwitch(skill, own) && (
            <span className="flex items-center" onClick={stopRowClick}>
              <Switch
                aria-label={skill.name}
                checked={rowSwitchOn(skill, own)}
                disabled={busy}
                onCheckedChange={() => {
                  const plan = planRowSwitch(skill, own);
                  if (plan) onPlan(plan);
                }}
              />
            </span>
          )}
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </span>
      </div>
    </li>
  );
});

/**
 * Skills that come with an agent or one of its plugins. They are the agent's, so they are folded
 * away by default; a search opens them.
 */
export function BuiltInSection({
  visible,
  ctx,
  searching,
  busy,
  onPlan,
  onOpen,
}: {
  /** The skills that match the search and filters. */
  visible: readonly Skill[];
  ctx: SkillsContext;
  /** A search is narrowing the page, so whatever matches is shown. */
  searching: boolean;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  onPlan: (plan: SkillPlan) => void;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (visible.length === 0) return null;
  const shown = open || searching;
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-center px-3 sm:px-4">
        <h2 className="min-w-0 text-sm font-normal text-foreground/70">
          <button
            type="button"
            aria-expanded={shown}
            disabled={searching}
            onClick={() => setOpen((value) => !value)}
            className="flex cursor-pointer items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                shown && "rotate-90",
              )}
            />
            <span className="truncate">Built in and plugins</span>
            <Badge variant="secondary" size="sm">
              {visible.length}
            </Badge>
          </button>
        </h2>
      </div>
      {shown && (
        <SettingsGroup>
          <ul className="divide-y divide-border/50">
            {visible.map((skill) => (
              <BuiltInRow
                key={skill.id}
                skill={skill}
                ctx={ctx}
                busy={busy}
                onPlan={onPlan}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </SettingsGroup>
      )}
    </section>
  );
}
