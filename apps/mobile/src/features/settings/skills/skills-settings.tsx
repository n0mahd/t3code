import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  describeResult,
  ingestSkills,
  installedAgents,
  sendInBatches,
  skillsToCheckWithGit,
  withGitNote,
  type PlanConfirmation,
  type ProjectOption,
  type SkillPlan,
  type SkillsContext,
} from "@t3tools/client-runtime/skills";
import {
  CHANGE_FAILED,
  claudeChange,
  describeAgentsResult,
  describeChange,
  failureText,
  ingestInstructions,
  instructionErrorReason,
  instructionsToCheckWithGit,
  withInstructionGitNote,
  type ClaudeRow,
  type InstructionData,
  type InstructionPlan,
} from "@t3tools/client-runtime/skills/instructions";
import type {
  ClaudeInstructionValue,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Platform } from "react-native";

import { showConfirmDialog } from "../../../components/ConfirmDialogHost";
import { useProjects } from "../../../state/entities";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "../settings-environment-filter";
import { settingsTargetsForProject } from "../settings-environment-filter.logic";

const SKILLS_LOAD_ERROR = "Couldn't read this environment's skill folders.";
const INSTRUCTIONS_LOAD_ERROR = "Couldn't read this environment's instruction files.";
const SKILLS_CHANGE_ERROR = "Couldn't change the skills here.";
const NO_PROVIDERS: readonly ServerProvider[] = [];

type SkillsData = ReturnType<typeof ingestSkills>;

/** What the pages read, for one environment and project. A new scope starts empty. */
type Loaded = {
  readonly key: string;
  readonly skills: SkillsData | null;
  readonly skillsError: string | null;
  readonly instructions: InstructionData | null;
  readonly instructionsError: string | null;
};

const scopeKey = (environmentId: EnvironmentId | null, cwd: string | null) =>
  `${environmentId ?? ""}\0${cwd ?? ""}`;

/** Asks before a change, the way the platform's own alerts do. */
function confirmPlan(confirmation: PlanConfirmation, onConfirm: () => void) {
  const message = [confirmation.body, confirmation.notes.join("\n")]
    .filter((part) => part !== "")
    .join("\n\n");
  if (Platform.OS === "ios") {
    Alert.alert(confirmation.title, message || undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: confirmation.confirm,
        style: confirmation.destructive ? "destructive" : "default",
        onPress: onConfirm,
      },
    ]);
    return;
  }
  showConfirmDialog({
    title: confirmation.title,
    ...(message ? { message } : {}),
    confirmText: confirmation.confirm,
    destructive: confirmation.destructive,
    onConfirm,
  });
}

function useSkillsSettingsState() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const allProjects = useProjects();
  const group =
    selectedProjectKey === null
      ? null
      : projectGroups.find((entry) => entry.key === selectedProjectKey);
  // Skills live in one environment, so a project narrows the choice to the ones it is on.
  const environments = settingsTargetsForProject(selectedTargets, group);
  const [chosenId, setChosenId] = useState<EnvironmentId | null>(null);
  const environment: SettingsTarget | null =
    environments.find((entry) => entry.environmentId === chosenId) ?? environments[0] ?? null;
  const environmentId = environment?.environmentId ?? null;
  const member = group?.members.find(
    (entry) => entry.project.environmentId === environmentId,
  )?.project;
  const cwd = member?.workspaceRoot ?? null;
  const projectLabel = group?.label ?? null;
  const providers = environment?.serverConfig.providers ?? NO_PROVIDERS;
  const key = scopeKey(environmentId, cwd);

  const listSkills = useAtomCommand(serverEnvironment.listSkills, { reportFailure: false });
  const enableSkills = useAtomCommand(serverEnvironment.enableSkills, { reportFailure: false });
  const disableSkills = useAtomCommand(serverEnvironment.disableSkills, { reportFailure: false });
  const placeSkills = useAtomCommand(serverEnvironment.placeSkills, { reportFailure: false });
  const deleteSkills = useAtomCommand(serverEnvironment.deleteSkills, { reportFailure: false });
  const skillsTracked = useAtomCommand(serverEnvironment.skillsTracked, { reportFailure: false });
  const listInstructions = useAtomCommand(serverEnvironment.listInstructions, {
    reportFailure: false,
  });
  const enableInstruction = useAtomCommand(serverEnvironment.enableInstruction, {
    reportFailure: false,
  });
  const disableInstruction = useAtomCommand(serverEnvironment.disableInstruction, {
    reportFailure: false,
  });
  const setClaudeInstructionFiles = useAtomCommand(serverEnvironment.setClaudeInstructionFiles, {
    reportFailure: false,
  });
  const shareInstruction = useAtomCommand(serverEnvironment.shareInstruction, {
    reportFailure: false,
  });
  const adoptInstruction = useAtomCommand(serverEnvironment.adoptInstruction, {
    reportFailure: false,
  });
  const deleteInstruction = useAtomCommand(serverEnvironment.deleteInstruction, {
    reportFailure: false,
  });
  const instructionsTracked = useAtomCommand(serverEnvironment.instructionsTracked, {
    reportFailure: false,
  });

  // Reading needs no grant; each change needs its command's.
  const canChangeSkills = [
    useAtomValue(serverEnvironment.enableSkills.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.disableSkills.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.placeSkills.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.deleteSkills.permissionAtom(environmentId)),
  ].every(Boolean);
  const canChangeInstructions = [
    useAtomValue(serverEnvironment.enableInstruction.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.disableInstruction.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.setClaudeInstructionFiles.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.shareInstruction.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.adoptInstruction.permissionAtom(environmentId)),
    useAtomValue(serverEnvironment.deleteInstruction.permissionAtom(environmentId)),
  ].every(Boolean);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const current = loaded?.key === key ? loaded : null;
  /** A change is being made and the files read again; nothing else can start meanwhile. */
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Answers for a scope that is no longer shown are dropped.
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const patch = useCallback(
    (forKey: string, next: Partial<Omit<Loaded, "key">>) =>
      setLoaded((previous) => {
        if (keyRef.current !== forKey) return previous;
        const base: Loaded =
          previous?.key === forKey
            ? previous
            : {
                key: forKey,
                skills: null,
                skillsError: null,
                instructions: null,
                instructionsError: null,
              };
        return { ...base, ...next };
      }),
    [],
  );

  const scoped = useMemo(() => (cwd ? { cwd } : {}), [cwd]);

  // The server reads a fixed list of folders each time; no agent is asked to rescan.
  const reloadSkills = useCallback(async () => {
    if (environmentId === null) return;
    const forKey = key;
    try {
      const result = await listSkills({ environmentId, input: scoped });
      if (result._tag === "Success") {
        patch(forKey, { skills: ingestSkills(result.value), skillsError: null });
      } else {
        patch(forKey, { skillsError: SKILLS_LOAD_ERROR });
      }
    } catch {
      patch(forKey, { skillsError: SKILLS_LOAD_ERROR });
    }
  }, [environmentId, key, listSkills, patch, scoped]);

  const reloadInstructions = useCallback(async () => {
    if (environmentId === null) return;
    const forKey = key;
    try {
      const result = await listInstructions({ environmentId, input: scoped });
      if (result._tag === "Success") {
        patch(forKey, {
          instructions: ingestInstructions(result.value),
          instructionsError: null,
        });
      } else {
        patch(forKey, { instructionsError: INSTRUCTIONS_LOAD_ERROR });
      }
    } catch {
      patch(forKey, { instructionsError: INSTRUCTIONS_LOAD_ERROR });
    }
  }, [environmentId, key, listInstructions, patch, scoped]);

  const reload = useCallback(
    () => Promise.all([reloadSkills(), reloadInstructions()]).then(() => undefined),
    [reloadSkills, reloadInstructions],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void reload().finally(() => setRefreshing(false));
  }, [reload]);

  const skills = current?.skills ?? null;
  const instructions = current?.instructions ?? null;
  const skillsInstalled = useMemo(
    () => (skills ? installedAgents(providers, skills.known) : []),
    [skills, providers],
  );
  const skillsCtx = useMemo<SkillsContext>(
    () => ({ installed: skillsInstalled }),
    [skillsInstalled],
  );
  const instructionsInstalled = useMemo(
    () => (instructions ? installedAgents(providers, instructions.known) : []),
    [instructions, providers],
  );
  const instructionsCtx = useMemo<SkillsContext>(
    () => ({ installed: instructionsInstalled }),
    [instructionsInstalled],
  );

  // The projects "Use in…" can name: the ones registered in this environment.
  const places = useMemo(() => {
    const projects = allProjects
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry): ProjectOption => ({ cwd: entry.workspaceRoot, label: entry.title }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const picked =
      cwd === null
        ? null
        : (projects.find((entry) => entry.cwd === cwd) ?? { cwd, label: projectLabel ?? cwd });
    return { picked, projects };
  }, [allProjects, environmentId, cwd, projectLabel]);

  /**
   * Asks the server to make the change, then reads the folders again: the pages show what is on
   * disk, never what the change was expected to do.
   */
  const applySkills = async (plan: SkillPlan) => {
    if (environmentId === null) return false;
    setBusy(true);
    let done = false;
    const { change } = plan;
    const base = { environmentId } as const;
    try {
      // The server takes a few hundred skills at a time, so a big change goes in batches.
      const { outcomes, failed } = await sendInBatches(change.skills, async (skills) => {
        const result =
          change.kind === "enable"
            ? await enableSkills({ ...base, input: { ...scoped, skills, agents: change.agents } })
            : change.kind === "disable"
              ? await disableSkills({
                  ...base,
                  input: { ...scoped, skills, agents: change.agents },
                })
              : change.kind === "place"
                ? await placeSkills({ ...base, input: { ...scoped, skills, to: change.to } })
                : await deleteSkills({ ...base, input: { ...scoped, skills } });
        return result._tag === "Success" ? result.value.outcomes : null;
      });
      done = !failed;
      // What was done before a batch failed is still told.
      setNotice(
        !failed
          ? describeResult(change, outcomes, skillsCtx)
          : outcomes.length === 0
            ? SKILLS_CHANGE_ERROR
            : `${describeResult(change, outcomes, skillsCtx)} ${SKILLS_CHANGE_ERROR}`,
      );
    } catch {
      setNotice(SKILLS_CHANGE_ERROR);
    }
    await reloadSkills();
    setBusy(false);
    return done;
  };

  /**
   * A plan that needs confirming asks first; any other goes ahead. For a placement or delete in a
   * project, git is asked before the question, so it can say when git can undo the change. A
   * failed check leaves that line out. `onApplied` hears whether the change went through, so an
   * open skill can close once it is moved or deleted.
   */
  const runSkillPlan = (plan: SkillPlan, onApplied?: (done: boolean) => void) => {
    const go = () =>
      void applySkills(plan).then((done) => {
        onApplied?.(done);
      });
    const confirmation = plan.confirmation;
    if (!confirmation) {
      go();
      return;
    }
    const skills = cwd ? skillsToCheckWithGit(plan) : null;
    if (!cwd || !skills || environmentId === null) {
      confirmPlan(confirmation, go);
      return;
    }
    void (async () => {
      let asked = plan;
      try {
        const result = await skillsTracked({ environmentId, input: { cwd, skills } });
        if (result._tag === "Success") asked = withGitNote(plan, result.value.tracked);
      } catch {
        // No answer, no promise.
      }
      confirmPlan(asked.confirmation ?? confirmation, go);
    })();
  };

  /** Asks the server for an instruction change and says what came of it. */
  const runInstruction = async (plan: InstructionPlan): Promise<string> => {
    if (environmentId === null) return CHANGE_FAILED;
    const { change } = plan;
    const ctx = instructionsCtx;
    const base = { environmentId } as const;
    const failed = (result: Parameters<typeof squashAtomCommandFailure>[0]) =>
      failureText(instructionErrorReason(squashAtomCommandFailure(result)));
    const setClaude = async (
      instances: readonly ProviderInstanceId[],
      value: ClaudeInstructionValue | null,
    ) => {
      for (const instanceId of instances) {
        const result = await setClaudeInstructionFiles({ ...base, input: { instanceId, value } });
        if (result._tag !== "Success") return result;
      }
      return null;
    };
    switch (change.kind) {
      case "setClaude": {
        const result = await setClaude(change.instances, change.value);
        return result ? failed(result) : describeChange(change, ctx);
      }
      case "enable":
      case "disable": {
        const input = { ...scoped, id: change.id, agents: change.agents };
        const result =
          change.kind === "enable"
            ? await enableInstruction({ ...base, input })
            : await disableInstruction({ ...base, input });
        return result._tag === "Success"
          ? describeAgentsResult(change.kind, result.value.results, ctx)
          : failed(result);
      }
      case "adopt": {
        for (const id of change.ids) {
          const result = await adoptInstruction({ ...base, input: { id } });
          if (result._tag !== "Success") return failed(result);
        }
        return describeChange(change, ctx);
      }
      case "share": {
        // Sharing renames or merges a file in a project, so it needs the picked project.
        if (!cwd) return CHANGE_FAILED;
        const shared = await shareInstruction({
          ...base,
          input: { cwd, id: change.id, merge: change.merge },
        });
        if (shared._tag !== "Success") return failed(shared);
        // The file is changed; Claude's setting follows, and a failure there is said after it.
        const claude = await setClaude(change.claude, "claude-md-and-agents-md");
        if (claude) {
          const lead = describeChange({ ...change, claude: [] }, ctx);
          return `${lead} ${failed(claude)}`;
        }
        return describeChange(change, ctx);
      }
      case "delete": {
        const result = await deleteInstruction({ ...base, input: { ...scoped, id: change.id } });
        return result._tag === "Success" ? describeChange(change, ctx) : failed(result);
      }
    }
  };

  /** Makes the change, says what came of it and reads the files again. */
  const applyInstruction = async (plan: InstructionPlan) => {
    setBusy(true);
    try {
      setNotice(await runInstruction(plan));
    } catch {
      setNotice(CHANGE_FAILED);
    }
    await reloadInstructions();
    setBusy(false);
  };

  /** Like `runSkillPlan`, for instruction files. */
  const runInstructionPlan = (plan: InstructionPlan) => {
    const go = () => void applyInstruction(plan);
    const confirmation = plan.confirmation;
    if (!confirmation) {
      go();
      return;
    }
    const ids = cwd ? instructionsToCheckWithGit(plan) : null;
    if (!cwd || !ids || environmentId === null) {
      confirmPlan(confirmation, go);
      return;
    }
    void (async () => {
      let asked = plan;
      try {
        const result = await instructionsTracked({ environmentId, input: { cwd, ids } });
        if (result._tag === "Success") asked = withInstructionGitNote(plan, result.value.tracked);
      } catch {
        // No answer, no promise.
      }
      confirmPlan(asked.confirmation ?? confirmation, go);
    })();
  };

  /** Claude's choice is a setting, not a file, so it goes ahead without asking. */
  const chooseClaude = (row: ClaudeRow, value: ClaudeInstructionValue) => {
    const change = claudeChange(row.choice, value);
    if (change) void applyInstruction({ change });
  };

  // Rows are memoized, so they get functions that keep their identity and call the latest version.
  const latest = useRef({ runSkillPlan, runInstructionPlan, chooseClaude });
  useEffect(() => {
    latest.current = { runSkillPlan, runInstructionPlan, chooseClaude };
  });
  const actions = useMemo(
    () => ({
      runSkillPlan: (plan: SkillPlan, onApplied?: (done: boolean) => void) =>
        latest.current.runSkillPlan(plan, onApplied),
      runInstructionPlan: (plan: InstructionPlan) => latest.current.runInstructionPlan(plan),
      chooseClaude: (row: ClaudeRow, value: ClaudeInstructionValue) =>
        latest.current.chooseClaude(row, value),
    }),
    [],
  );

  return {
    ...actions,
    environments,
    environment,
    chooseEnvironment: setChosenId,
    /** A project is picked above the page, but it isn't on any of the picked environments. */
    missingProject: selectedProjectKey !== null && environments.length === 0,
    cwd,
    projectLabel,
    places,
    skills,
    skillsError: current?.skillsError ?? null,
    instructions,
    instructionsError: current?.instructionsError ?? null,
    skillsCtx,
    instructionsCtx,
    canChangeSkills,
    canChangeInstructions,
    busy,
    refreshing,
    notice,
    dismissNotice,
    reload,
    refresh,
  };
}

type SkillsSettings = ReturnType<typeof useSkillsSettingsState>;

const SkillsSettingsContext = createContext<SkillsSettings | null>(null);

/**
 * The Skills page and the skill, file and Use in… pages it opens read one list and make one
 * change at a time, so they share this state while Settings is open.
 */
export function SkillsSettingsProvider(props: { readonly children: ReactNode }) {
  const value = useSkillsSettingsState();
  return <SkillsSettingsContext value={value}>{props.children}</SkillsSettingsContext>;
}

export function useSkillsSettings() {
  const value = use(SkillsSettingsContext);
  if (value === null) throw new Error("Skills settings provider is missing.");
  return value;
}

/**
 * Reads the lists when the page opens and again whenever its environment or project changes. What
 * the last change said is cleared once the page closes.
 */
export function useLoadSkillsSettings() {
  // `reload` changes only with the environment and project it reads.
  const { reload, dismissNotice } = useSkillsSettings();
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => dismissNotice, [dismissNotice]);
}
