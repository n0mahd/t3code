import { InfoIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import { SkillAgents } from "./skillAgentIcon";
import { attention, type Skill, type SkillsContext } from "./SkillsSettings.logic";

/** A checkbox that shows on hover or focus, always on touch, and stays once something is ticked. */
function SelectBox({
  label,
  checked,
  indeterminate = false,
  visible,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  /** Something is selected somewhere, so every box shows. */
  visible: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-checked:opacity-100 has-data-indeterminate:opacity-100 pointer-coarse:opacity-100",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <Checkbox
        aria-label={label}
        checked={checked}
        indeterminate={indeterminate}
        onCheckedChange={(value) => onChange(value)}
      />
    </span>
  );
}

/** A one-click change for a row, such as turning the skill on for the agent that lacks it. */
export type RowFix = { readonly label: string; readonly run: () => void };

function SkillRow({
  skill,
  ctx,
  selected,
  anySelected,
  fix,
  busy,
  onToggle,
  onOpen,
}: {
  skill: Skill;
  ctx: SkillsContext;
  selected: boolean;
  anySelected: boolean;
  fix: RowFix | null;
  busy: boolean;
  onToggle: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const warning = attention(skill, ctx);
  return (
    <li
      className={cn(
        "group/row flex min-w-0 items-center gap-2 py-2 pr-3 pl-3 hover:bg-muted/40 sm:pr-4 sm:pl-4",
        selected && "bg-muted/60",
      )}
    >
      <SelectBox
        label={`Select ${skill.name}`}
        checked={selected}
        visible={anySelected}
        onChange={onToggle}
      />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{skill.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {skill.description || "No description yet."}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {warning?.kind === "conflict" && (
            <Badge variant="warning" size="sm" title={warning.detail}>
              Conflict
            </Badge>
          )}
          <SkillAgents skill={skill} ctx={ctx} />
        </span>
      </button>
      {fix && (
        <Button size="xs" variant="outline" disabled={busy} onClick={fix.run}>
          {fix.label}
        </Button>
      )}
    </li>
  );
}

/** Small info button beside the page heading: where project and global skills live. */
export function StandardInfo() {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="Where skills live" />}
      >
        <InfoIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <p className="text-xs leading-relaxed">
          Project skills live in the repo, so anyone who clones it gets them. Global skills are
          yours and work in all your projects.
        </p>
      </PopoverPopup>
    </Popover>
  );
}

export function SkillSection({
  title,
  hint,
  detail,
  folder,
  all,
  visible,
  ctx,
  emptyText,
  selected,
  busy,
  rowFix,
  onSelectedChange,
  onOpen,
}: {
  title: string;
  /** A short muted phrase beside the name, in plain words. */
  hint: string;
  /** What the tooltip on the name adds, before the folder. */
  detail?: string;
  /** The section's folder, shown in a tooltip on its name. */
  folder: string;
  /** Every skill in the section, before search narrows it. */
  all: readonly Skill[];
  /** The skills that match the search and filters. */
  visible: readonly Skill[];
  ctx: SkillsContext;
  emptyText: string;
  /** The ids of the ticked rows, across both sections. */
  selected: ReadonlySet<string>;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  /** The one-click change a row offers, if any. */
  rowFix: (skill: Skill) => RowFix | null;
  onSelectedChange: (ids: readonly string[], checked: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const anySelected = selected.size > 0;
  const selectedCount = visible.filter((skill) => selected.has(skill.id)).length;
  return (
    <section className="space-y-2.5">
      <div className="group/row flex min-h-7 items-center gap-2 px-3 sm:px-4">
        <SelectBox
          label={`Select all in ${title}`}
          checked={visible.length > 0 && selectedCount === visible.length}
          indeterminate={selectedCount > 0 && selectedCount < visible.length}
          visible={anySelected}
          onChange={(checked) =>
            onSelectedChange(
              visible.map((skill) => skill.id),
              checked,
            )
          }
        />
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-normal text-foreground/70">
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} className="shrink-0 cursor-default" />}>
              {title} · {all.length}
            </TooltipTrigger>
            <TooltipPopup>
              {detail && <span className="block">{detail}</span>}
              <span className="block font-mono">{folder}</span>
            </TooltipPopup>
          </Tooltip>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span>
        </h2>
      </div>
      <SettingsGroup>
        {visible.length === 0 ? (
          <p className="px-3 py-5 text-sm text-muted-foreground sm:px-4">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {visible.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                ctx={ctx}
                selected={selected.has(skill.id)}
                anySelected={anySelected}
                fix={rowFix(skill)}
                busy={busy}
                onToggle={(checked) => onSelectedChange([skill.id], checked)}
                onOpen={() => onOpen(skill.id)}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>
    </section>
  );
}
