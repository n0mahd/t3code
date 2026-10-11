import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SkillBatchResult, SkillRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AlertTriangleIcon, ArrowLeftIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ConfirmPlan } from "./SkillBulkBar";
import { useEscapeToList } from "./SkillDetailChrome";
import { SettingsGroup } from "./SettingsGroup";
import {
  defaultTidyChoices,
  describeTidy,
  duplicatesTitle,
  ownFolderTitle,
  packTitle,
  tidyConfirmation,
  tidyGitRefs,
  tidyStepCount,
  tidySteps,
  turnOnTitle,
  type TidyChoices,
  type TidyDuplicate,
  type TidyFindings,
  type TidyStepResult,
} from "./SkillTidy.logic";
import { sendInBatches, type PlanConfirmation, type Skill } from "./SkillsSettings.logic";

// The diff view brings the highlighter with it, so it loads when Compare is pressed.
const SkillCompare = lazy(() => import("./SkillCompare"));

/** The note above a project's skills that offers to tidy them. */
export function TidyBanner({
  text,
  busy,
  onTidy,
  onDismiss,
}: {
  text: string;
  busy: boolean;
  onTidy: () => void;
  onDismiss: () => void;
}) {
  return (
    <Alert variant="warning" role="status">
      <AlertTriangleIcon />
      <AlertDescription>{text}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="warning-outline" disabled={busy} onClick={onTidy}>
          Tidy up
        </Button>
        <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <SettingsGroup>
      <div className="space-y-3 px-3 py-3 sm:px-4">{children}</div>
    </SettingsGroup>
  );
}

/** A card that is one tick: done or not. */
function CheckCard({
  title,
  detail,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  detail?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Card>
      <label className="flex items-start gap-2 text-sm">
        <span className="flex h-5 items-center">
          <Checkbox checked={checked} disabled={disabled} onCheckedChange={onChange} />
        </span>
        <span className="min-w-0">
          <span className="block font-medium">{title}</span>
          {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
        </span>
      </label>
    </Card>
  );
}

function Choice({ value, title, detail }: { value: string; title: string; detail?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <span className="flex h-5 items-center">
        <Radio value={value} />
      </span>
      <span className="min-w-0">
        <span className="block">{title}</span>
        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </span>
    </label>
  );
}

const refOf = (skill: Skill): SkillRef => ({
  scope: skill.scope,
  name: skill.name,
  home: skill.home,
});

/**
 * Fixes a project's skills in one pass: one card per kind of problem, each with its own choice,
 * and one button that does what is picked after a confirmation. It opens in place of the list.
 */
export function TidyUp({
  environmentId,
  cwd,
  projectName,
  findings,
  locked,
  onBack,
  onBusyChange,
  onDone,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  findings: TidyFindings;
  /** A change is being made or the grant is missing, so nothing can start. */
  locked: boolean;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
  /** Called with the one-line result once everything picked has been asked for. */
  onDone: (notice: string) => void;
}) {
  useEscapeToList(onBack);
  const deleteSkills = useAtomCommand(serverEnvironment.deleteSkills, { reportFailure: false });
  const placeSkills = useAtomCommand(serverEnvironment.placeSkills, { reportFailure: false });
  const shareSkills = useAtomCommand(serverEnvironment.shareSkills, { reportFailure: false });
  const enableSkills = useAtomCommand(serverEnvironment.enableSkills, { reportFailure: false });
  const skillsTracked = useAtomCommand(serverEnvironment.skillsTracked, { reportFailure: false });
  const canShare = useAtomValue(serverEnvironment.shareSkills.permissionAtom(environmentId));
  const [choices, setChoices] = useState<TidyChoices>(() => defaultTidyChoices(findings));
  const [confirming, setConfirming] = useState<{ confirmation: PlanConfirmation } | null>(null);
  const [comparing, setComparing] = useState<TidyDuplicate | null>(null);
  const steps = useMemo(() => tidySteps(findings, choices), [findings, choices]);
  // What each tick card would do if ticked, so a card keeps its count while unticked.
  const shareShown = useMemo(
    () => tidySteps(findings, { ...choices, share: true }).share,
    [findings, choices],
  );
  const turnOnShown = useMemo(
    () =>
      tidySteps(findings, {
        ...choices,
        turnOn: new Set(findings.missing.map((entry) => entry.agent.instanceId)),
      }).turnOn,
    [findings, choices],
  );
  const disabled = locked || !canShare;
  const nothing = tidyStepCount(steps) === 0;
  const update = (change: Partial<TidyChoices>) =>
    setChoices((current) => ({ ...current, ...change }));

  /** Opens the confirmation at once; the git line joins it when git has answered. */
  const ask = () => {
    const shown = { confirmation: tidyConfirmation(projectName, steps, null) };
    setConfirming(shown);
    const skills = tidyGitRefs(steps);
    if (skills.length === 0) return;
    void skillsTracked({ environmentId, input: { cwd, skills } })
      .then((result) => {
        if (result._tag !== "Success") return;
        const confirmation = tidyConfirmation(projectName, steps, result.value.tracked);
        setConfirming((current) => (current === shown ? { confirmation } : current));
      })
      .catch(() => {
        // No answer, no promise: the dialog stays as it was.
      });
  };

  /**
   * Asks for each step in turn. Copies go first and moves next, so the skills the later steps
   * name are still where the list said; a step that fails doesn't stop the rest.
   */
  const run = async () => {
    setConfirming(null);
    onBusyChange(true);
    const results: TidyStepResult[] = [];
    const step = async (
      kind: TidyStepResult["kind"],
      skills: readonly Skill[],
      send: (batch: readonly SkillRef[]) => Promise<AtomCommandResult<SkillBatchResult, unknown>>,
      agent?: TidyStepResult["agent"],
    ) => {
      if (skills.length === 0) return;
      const { outcomes } = await sendInBatches(skills.map(refOf), async (batch) => {
        const result = await send(batch).catch(() => null);
        return result?._tag === "Success" ? result.value.outcomes : null;
      });
      results.push({ kind, outcomes, asked: skills.length, ...(agent ? { agent } : {}) });
    };
    const base = { environmentId } as const;
    await step("remove", steps.remove, (batch) =>
      deleteSkills({ ...base, input: { cwd, skills: batch } }),
    );
    await step("toGlobal", steps.toGlobal, (batch) =>
      placeSkills({ ...base, input: { cwd, skills: batch, to: { kind: "global" } } }),
    );
    await step("share", steps.share, (batch) =>
      shareSkills({ ...base, input: { cwd, skills: batch } }),
    );
    for (const entry of steps.turnOn) {
      await step(
        "turnOn",
        entry.skills,
        (batch) =>
          enableSkills({
            ...base,
            input: { cwd, skills: batch, agents: [entry.agent.instanceId] },
          }),
        entry.agent,
      );
    }
    onBusyChange(false);
    onDone(describeTidy(results));
  };

  const { packs, duplicates } = findings;
  const keepGlobal = duplicates.length > 0 && choices.keepGlobal.size > 0;
  return (
    <div className="min-w-0 space-y-4">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 text-xs text-muted-foreground"
      >
        <Button size="xs" variant="ghost-muted" onClick={onBack}>
          <ArrowLeftIcon className="sm:hidden" />
          <span className="sm:hidden">Back</span>
          <span className="hidden sm:inline">Skills</span>
        </Button>
        <span className="min-w-0 truncate">/ {projectName} / Tidy up</span>
      </nav>

      {shareShown.length + turnOnShown.length + packs.length + duplicates.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing to tidy.</p>
      )}

      {packs.map((pack) => (
        <Card key={pack.source}>
          <p className="text-sm font-medium">{packTitle(pack)}</p>
          <RadioGroup
            aria-label={`Where the skills from ${pack.source} live`}
            value={choices.packsToGlobal.has(pack.source) ? "global" : "keep"}
            disabled={disabled}
            onValueChange={(value) => {
              const next = new Set(choices.packsToGlobal);
              if (value === "global") next.add(pack.source);
              else next.delete(pack.source);
              update({ packsToGlobal: next });
            }}
          >
            <Choice value="global" title="Move to Global" detail="One copy for all your projects" />
            <Choice
              value="keep"
              title="Keep in this project"
              detail={`Shared with everyone who clones ${projectName}`}
            />
          </RadioGroup>
        </Card>
      ))}

      {duplicates.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-sm font-medium">{duplicatesTitle(duplicates)}</p>
            {duplicates.length === 1 && (
              <Button size="xs" variant="outline" onClick={() => setComparing(duplicates[0]!)}>
                Compare
              </Button>
            )}
          </div>
          {duplicates.length > 1 && (
            <ul className="space-y-1">
              {duplicates.map((entry) => (
                <li key={entry.skill.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{entry.skill.name}</span>
                  <Button size="xs" variant="outline" onClick={() => setComparing(entry)}>
                    Compare
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <RadioGroup
            aria-label="Which copies to keep"
            value={keepGlobal ? "global" : "both"}
            disabled={disabled}
            onValueChange={(value) =>
              update({
                keepGlobal: new Set(
                  value === "global" ? duplicates.map((entry) => entry.skill.name) : [],
                ),
              })
            }
          >
            <Choice value="global" title="Keep the Global version" />
            <Choice value="both" title="Keep both" />
          </RadioGroup>
        </Card>
      )}

      {shareShown.length > 0 && (
        <CheckCard
          title={ownFolderTitle(shareShown)}
          detail={
            shareShown.length === 1
              ? "Moves it to the shared folder, so every agent can use it."
              : "Moves them to the shared folder, so every agent can use them."
          }
          checked={choices.share}
          disabled={disabled}
          onChange={(share) => update({ share })}
        />
      )}

      {turnOnShown.map((entry) => (
        <CheckCard
          key={entry.agent.instanceId}
          title={turnOnTitle(entry)}
          checked={choices.turnOn.has(entry.agent.instanceId)}
          disabled={disabled}
          onChange={(on) => {
            const next = new Set(choices.turnOn);
            if (on) next.add(entry.agent.instanceId);
            else next.delete(entry.agent.instanceId);
            update({ turnOn: next });
          }}
        />
      ))}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button size="sm" disabled={disabled || nothing} onClick={ask}>
          Tidy up
        </Button>
      </div>

      <ConfirmPlan
        plan={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void run()}
      />
      {comparing && (
        <Suspense fallback={null}>
          <SkillCompare
            duplicate={comparing}
            environmentId={environmentId}
            cwd={cwd}
            onClose={() => setComparing(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
