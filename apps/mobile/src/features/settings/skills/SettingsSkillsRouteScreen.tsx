import { useNavigation } from "@react-navigation/native";
import {
  GROUP_PREVIEW,
  attention,
  availability,
  availabilityNote,
  groupAvailability,
  groupBySource,
  listSwitchOn,
  matchesQuery,
  planFix,
  planListSwitch,
  planRowSwitch,
  projectsBadge,
  rowSwitchOn,
  unreadableNote,
  type Skill,
  type SkillGroup,
  type SkillPlan,
  type SkillsContext,
} from "@t3tools/client-runtime/skills";
import {
  CLAUDE_OPTIONS,
  instructionAttentionCount,
  instructionItems,
  instructionUnreadableNote,
  usage,
  usageNote,
  type ClaudeRow,
  type InstructionItem,
  type InstructionPlan,
  type InstructionRow,
  type NestedFile,
} from "@t3tools/client-runtime/skills/instructions";
import type { ClaudeInstructionValue } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { ControlPillMenu } from "../../../components/ControlPill";
import { ScreenScrollView as ScrollView } from "../../../components/ScreenScrollView";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { cn } from "../../../lib/cn";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "../components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { SkillAgents, SkillsNotice, SkillsPillButton, SkillsWarning } from "./skills-components";
import { useLoadSkillsSettings, useSkillsSettings } from "./skills-settings";
import { withoutMissingFiles } from "./skills-list.logic";

/** Opens a skill or an instruction file in its own screen. */
function useOpen() {
  const navigation = useNavigation();
  return useMemo(
    () => ({
      skill: (id: string) =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsSkill", params: { id } },
        }),
      instruction: (id: string) =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsInstruction", params: { id } },
        }),
    }),
    [navigation],
  );
}

export function SettingsSkillsRouteScreen() {
  useLoadSkillsSettings();
  const insets = useSafeAreaInsets();
  const settings = useSkillsSettings();
  const { environment, environments } = settings;

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Skills" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
          refreshControl={
            environment ? (
              <RefreshControl refreshing={settings.refreshing} onRefresh={settings.refresh} />
            ) : undefined
          }
        >
          {environments.length > 1 ? (
            <View className="flex-row flex-wrap gap-2">
              {environments.map((entry) => (
                <SkillsPillButton
                  key={entry.environmentId}
                  label={entry.label}
                  selected={entry.environmentId === environment?.environmentId}
                  onPress={() => settings.chooseEnvironment(entry.environmentId)}
                />
              ))}
            </View>
          ) : null}
          {environment ? (
            <SkillsList key={`${environment.environmentId}\0${settings.cwd ?? ""}`} />
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {settings.missingProject
                ? "This project isn't on a connected environment."
                : "Connect an environment to see its skills."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function SkillsList() {
  const settings = useSkillsSettings();
  const open = useOpen();
  const [query, setQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const { skills: data, instructions, skillsCtx: ctx, instructionsCtx } = settings;
  // Skills that come with an agent are listed apart on web and desktop, and only there.
  const skills = useMemo(
    () => data?.skills.filter((skill) => skill.provided === undefined) ?? null,
    [data],
  );
  const needle = query.trim().toLowerCase();
  const locked = settings.busy || !settings.canChangeSkills;
  const instructionsLocked = settings.busy || !settings.canChangeInstructions;

  const attentionIds = useMemo(
    () =>
      new Set(
        (skills ?? []).filter((skill) => attention(skill, ctx) !== null).map((skill) => skill.id),
      ),
    [skills, ctx],
  );
  const attentionTotal =
    attentionIds.size +
    (instructions ? instructionAttentionCount(instructions, instructionsCtx) : 0);
  const narrow = useCallback(
    (scope: Skill["scope"]) =>
      (skills ?? []).filter(
        (skill) =>
          skill.scope === scope &&
          (!onlyAttention || attentionIds.has(skill.id)) &&
          matchesQuery(skill, needle),
      ),
    [skills, onlyAttention, attentionIds, needle],
  );
  const visibleProject = useMemo(() => narrow("project"), [narrow]);
  const visibleGlobal = useMemo(() => narrow("global"), [narrow]);
  const instructionItemsShown = useMemo(
    () =>
      instructions
        ? withoutMissingFiles(
            instructionItems(instructions, instructionsCtx, { needle, onlyAttention }),
          )
        : [],
    [instructions, instructionsCtx, needle, onlyAttention],
  );
  const countIn = (scope: Skill["scope"]) =>
    (skills ?? []).filter((skill) => skill.scope === scope).length;
  const emptyText = (total: number, none: string) =>
    total === 0
      ? none
      : onlyAttention && !needle
        ? "Nothing needs attention here."
        : "No matching skills.";
  const loading = skills === null && settings.skillsError === null;

  return (
    <>
      {settings.notice ? (
        <SkillsNotice text={settings.notice} onDismiss={settings.dismissNotice} />
      ) : null}
      {settings.skillsError ? (
        <SkillsWarning
          text={settings.skillsError}
          actionLabel="Try again"
          onAction={settings.refresh}
        />
      ) : null}

      <View className="gap-3">
        <TextInput
          accessibilityLabel="Search skills and instructions"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          placeholder="Search skills and instructions"
          returnKeyType="search"
          value={query}
          onChangeText={setQuery}
        />
        {/* The count depends on the list, so it waits for it instead of showing a false zero. */}
        {skills !== null ? (
          <View className="flex-row">
            <SkillsPillButton
              label={`Needs attention (${attentionTotal})`}
              selected={onlyAttention}
              onPress={() => setOnlyAttention((value) => !value)}
            />
          </View>
        ) : null}
      </View>

      {loading ? <ActivityIndicator accessibilityLabel="Loading skills" /> : null}

      {settings.instructionsError ? (
        <SkillsWarning
          text={settings.instructionsError}
          actionLabel="Try again"
          onAction={settings.refresh}
        />
      ) : null}
      {instructions && instructions.unreadable.length > 0 ? (
        <SkillsWarning text={instructionUnreadableNote(instructions.unreadable)} />
      ) : null}
      {instructions && instructionItemsShown.length > 0 ? (
        <SettingsSection title="Instructions">
          {instructionItemsShown.map((item, index) => (
            <InstructionItemView
              key={itemKey(item)}
              item={item}
              separated={index > 0}
              ctx={instructionsCtx}
              locked={instructionsLocked}
              onOpen={open.instruction}
              onPlan={settings.runInstructionPlan}
              onClaudeChange={settings.chooseClaude}
            />
          ))}
        </SettingsSection>
      ) : null}

      {data && data.unreadable.length > 0 ? (
        <SkillsWarning text={unreadableNote(data.unreadable)} />
      ) : null}
      {skills !== null && settings.cwd !== null ? (
        <SkillSection
          title="This project"
          visible={visibleProject}
          ctx={ctx}
          emptyText={emptyText(countIn("project"), "No skills in this project.")}
          flat={needle !== ""}
          showFix={onlyAttention}
          locked={locked}
          onPlan={settings.runSkillPlan}
          onOpen={open.skill}
        />
      ) : null}
      {skills !== null ? (
        <SkillSection
          title="Global"
          visible={visibleGlobal}
          ctx={ctx}
          emptyText={emptyText(countIn("global"), "No Global skills yet.")}
          flat={needle !== ""}
          showFix={onlyAttention}
          locked={locked}
          onPlan={settings.runSkillPlan}
          onOpen={open.skill}
        />
      ) : null}
    </>
  );
}

const itemKey = (item: InstructionItem) => {
  switch (item.kind) {
    case "group":
      return `group:${item.group}`;
    case "file":
      return item.row.id;
    case "subfolders":
      return "subfolders";
    case "claude":
      return `claude:${item.row.instanceId}`;
  }
};

// -- Skills -------------------------------------------------------------------------------------

function SkillSection(props: {
  readonly title: string;
  /** The skills that match the search and filter. */
  readonly visible: readonly Skill[];
  readonly ctx: SkillsContext;
  readonly emptyText: string;
  /** List the skills without groups, as a search does. */
  readonly flat: boolean;
  readonly showFix: boolean;
  /** A change is being made, or the session can't make one. */
  readonly locked: boolean;
  readonly onPlan: (plan: SkillPlan) => void;
  readonly onOpen: (id: string) => void;
}) {
  const { visible, ctx, flat } = props;
  const on = useMemo(() => listSwitchOn(visible, ctx), [visible, ctx]);
  const { groups, loose } = useMemo(
    () => (flat ? { groups: [], loose: visible } : groupBySource(visible)),
    [visible, flat],
  );
  return (
    <SettingsSection
      title={props.title}
      trailing={
        <View className="pr-4">
          <ThemedSwitch
            accessibilityLabel={`All skills in ${props.title}`}
            disabled={props.locked || visible.length === 0 || ctx.installed.length === 0}
            value={on}
            onValueChange={() => {
              const plan = planListSwitch(visible, ctx);
              if (plan) props.onPlan(plan);
            }}
          />
        </View>
      }
    >
      {visible.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">{props.emptyText}</Text>
      ) : (
        <>
          {groups.map((group, index) => (
            <SkillGroupRows
              key={group.source}
              group={group}
              separated={index > 0}
              ctx={ctx}
              showFix={props.showFix}
              locked={props.locked}
              onPlan={props.onPlan}
              onOpen={props.onOpen}
            />
          ))}
          {loose.map((skill, index) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              separated={groups.length + index > 0}
              ctx={ctx}
              showFix={props.showFix}
              locked={props.locked}
              onPlan={props.onPlan}
              onOpen={props.onOpen}
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

const SkillRow = memo(function SkillRow(props: {
  readonly skill: Skill;
  readonly ctx: SkillsContext;
  /** The row sits under a group's row, so it is indented. */
  readonly nested?: boolean;
  readonly separated: boolean;
  /** Offer the one-tap fix for a skill some agent lacks; only the Needs attention list does. */
  readonly showFix: boolean;
  readonly locked: boolean;
  readonly onPlan: (plan: SkillPlan) => void;
  readonly onOpen: (id: string) => void;
}) {
  const { skill, ctx } = props;
  const derived = useMemo(() => {
    const warning = attention(skill, ctx);
    return {
      conflict: warning?.kind === "conflict",
      fix: props.showFix && warning?.kind === "missing" ? planFix(skill, ctx) : null,
      availability: availability(skill, ctx),
      on: rowSwitchOn(skill, ctx),
      projects: projectsBadge(skill),
    };
  }, [skill, ctx, props.showFix]);
  const { fix } = derived;
  return (
    <View className={cn(props.separated && "border-t border-border-subtle")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={skill.name}
        accessibilityHint="Opens the skill"
        className={cn(
          "flex-row items-center gap-3 py-3 pr-4 active:bg-subtle",
          props.nested ? "pl-10" : "pl-4",
        )}
        onPress={() => props.onOpen(skill.id)}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {skill.name}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {skill.description || "No description yet."}
          </Text>
          {derived.conflict || derived.projects ? (
            <View className="flex-row flex-wrap gap-x-3">
              {derived.conflict ? (
                <Text className="text-sm text-warning-foreground">Conflict</Text>
              ) : null}
              {derived.projects ? (
                <Text className="text-sm text-foreground-muted">{derived.projects}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
        <SkillAgents
          value={derived.availability}
          agents={ctx.installed}
          label={availabilityNote(derived.availability)}
        />
        <ThemedSwitch
          accessibilityLabel={skill.name}
          disabled={props.locked || ctx.installed.length === 0}
          value={derived.on}
          onValueChange={() => {
            const plan = planRowSwitch(skill, ctx);
            if (plan) props.onPlan(plan);
          }}
        />
      </Pressable>
      {fix ? (
        <View className={cn("flex-row pr-4 pb-3", props.nested ? "pl-10" : "pl-4")}>
          <SkillsPillButton
            label={fix.label}
            disabled={props.locked}
            onPress={() => props.onPlan(fix.plan)}
          />
        </View>
      ) : null}
    </View>
  );
});

/** A group's row and its skills: the first few, and a row that reveals the rest. */
const SkillGroupRows = memo(function SkillGroupRows(props: {
  readonly group: SkillGroup;
  readonly separated: boolean;
  readonly ctx: SkillsContext;
  readonly showFix: boolean;
  readonly locked: boolean;
  readonly onPlan: (plan: SkillPlan) => void;
  readonly onOpen: (id: string) => void;
}) {
  const { group, ctx } = props;
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const derived = useMemo(
    () => ({
      on: listSwitchOn(group.skills, ctx),
      availability: groupAvailability(group.skills, ctx),
    }),
    [group.skills, ctx],
  );
  const shown = showAll ? group.skills : group.skills.slice(0, GROUP_PREVIEW);
  const hidden = group.skills.length - shown.length;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`From ${group.source}, ${group.skills.length} skills`}
        className={cn(
          "flex-row items-center gap-3 px-4 py-3 active:bg-subtle",
          props.separated && "border-t border-border-subtle",
        )}
        onPress={() => setOpen((value) => !value)}
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
        <Text className="min-w-0 shrink text-base font-t3-medium text-foreground" numberOfLines={1}>
          From {group.source}
        </Text>
        <Text className="text-sm text-foreground-muted">{group.skills.length}</Text>
        <View className="flex-1" />
        <SkillAgents
          value={derived.availability}
          agents={ctx.installed}
          label={availabilityNote(derived.availability)}
        />
        <ThemedSwitch
          accessibilityLabel={`All skills from ${group.source}`}
          disabled={props.locked || ctx.installed.length === 0}
          value={derived.on}
          onValueChange={() => {
            const plan = planListSwitch(group.skills, ctx);
            if (plan) props.onPlan(plan);
          }}
        />
      </Pressable>
      {open
        ? shown.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              nested
              separated
              ctx={ctx}
              showFix={props.showFix}
              locked={props.locked}
              onPlan={props.onPlan}
              onOpen={props.onOpen}
            />
          ))
        : null}
      {open && group.skills.length > GROUP_PREVIEW ? (
        <Pressable
          accessibilityRole="button"
          className="border-t border-border-subtle py-3 pr-4 pl-10 active:bg-subtle"
          onPress={() => setShowAll((value) => !value)}
        >
          <Text className="text-sm font-t3-medium text-foreground-muted">
            {hidden > 0 ? `${hidden} more` : "Show fewer"}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
});

// -- Instructions -------------------------------------------------------------------------------

function InstructionItemView(props: {
  readonly item: InstructionItem;
  readonly separated: boolean;
  readonly ctx: SkillsContext;
  readonly locked: boolean;
  readonly onOpen: (id: string) => void;
  readonly onPlan: (plan: InstructionPlan) => void;
  readonly onClaudeChange: (row: ClaudeRow, value: ClaudeInstructionValue) => void;
}) {
  const { item } = props;
  switch (item.kind) {
    case "group":
      return (
        <View className={cn("px-4 pt-3 pb-1", props.separated && "border-t border-border-subtle")}>
          <Text className="text-sm font-t3-medium text-foreground-muted">{item.label}</Text>
        </View>
      );
    case "file":
      return (
        <InstructionFileRow
          row={item.row}
          ctx={props.ctx}
          locked={props.locked}
          onOpen={props.onOpen}
          onPlan={props.onPlan}
        />
      );
    case "subfolders":
      return <SubfoldersRow files={item.files} onOpen={props.onOpen} />;
    case "claude":
      return (
        <ClaudeChoiceRow
          row={item.row}
          locked={props.locked}
          onChange={(value) => props.onClaudeChange(item.row, value)}
        />
      );
  }
}

/** One file, which opens on a tap. Its second line is only a problem, with its fix under it. */
const InstructionFileRow = memo(function InstructionFileRow(props: {
  readonly row: InstructionRow;
  readonly ctx: SkillsContext;
  readonly locked: boolean;
  readonly onOpen: (id: string) => void;
  readonly onPlan: (plan: InstructionPlan) => void;
}) {
  const { row, ctx } = props;
  const used = useMemo(() => usage(row.entry, ctx), [row.entry, ctx]);
  const fix = row.attention?.fix ?? null;
  return (
    <View className="border-t border-border-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.title}
        accessibilityHint="Opens the file"
        className="flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
        onPress={() => props.onOpen(row.id)}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {row.title}
          </Text>
          {row.attention ? (
            <Text className="text-sm text-warning-foreground">{row.attention.detail}</Text>
          ) : null}
        </View>
        <SkillAgents value={used} agents={ctx.installed} label={usageNote(used)} />
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
      {fix ? (
        <View className="flex-row px-4 pb-3">
          <SkillsPillButton
            label={fix.label}
            disabled={props.locked}
            onPress={() => props.onPlan(fix.plan)}
          />
        </View>
      ) : null}
    </View>
  );
});

/** The AGENTS.md and CLAUDE.md files below the project's top folder, folded into one row. */
function SubfoldersRow(props: {
  readonly files: readonly NestedFile[];
  readonly onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="border-t border-border-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
        onPress={() => setOpen((value) => !value)}
      >
        <Text className="min-w-0 shrink text-base font-t3-medium text-foreground">
          In subfolders
        </Text>
        <Text className="text-sm text-foreground-muted">{props.files.length}</Text>
        <View className="flex-1" />
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
      {open
        ? props.files.map((file) => (
            <Pressable
              key={file.id}
              accessibilityRole="button"
              className="flex-row items-center gap-3 py-2.5 pr-4 pl-8 active:bg-subtle"
              onPress={() => props.onOpen(file.id)}
            >
              <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                {file.folder || "Top folder"}
              </Text>
              <Text className="text-sm text-foreground-muted">{file.file}</Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

/** Claude's "Project instructions" choice, which applies in every project. */
function ClaudeChoiceRow(props: {
  readonly row: ClaudeRow;
  readonly locked: boolean;
  readonly onChange: (value: ClaudeInstructionValue) => void;
}) {
  const { row } = props;
  const { control } = row;
  return (
    <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground">{row.title}</Text>
        {row.note !== null ? (
          <Text className="text-sm text-foreground-muted">{row.note}</Text>
        ) : null}
      </View>
      {control.kind === "text" ? (
        <Text className="text-sm text-foreground-muted">{control.text}</Text>
      ) : props.locked || control.disabled ? (
        <ClaudeChoicePill label={control.label} title={row.title} disabled />
      ) : (
        <ControlPillMenu
          title="Applies in every project"
          isAnchoredToRight
          actions={CLAUDE_OPTIONS.map((option) => ({
            id: option.value,
            title: option.label,
            ...(option.hint ? { subtitle: option.hint } : {}),
            state: option.value === control.value ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const picked = CLAUDE_OPTIONS.find((option) => option.value === nativeEvent.event);
            if (picked) props.onChange(picked.value);
          }}
        >
          <ClaudeChoicePill label={control.label} title={row.title} disabled={false} />
        </ControlPillMenu>
      )}
    </View>
  );
}

function ClaudeChoicePill(props: {
  readonly label: string;
  readonly title: string;
  readonly disabled: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.title}: ${props.label}`}
      disabled={props.disabled}
      className="max-w-[55%] flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-2 active:opacity-70 disabled:opacity-40"
    >
      <Text className="shrink text-sm font-t3-medium text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      <SymbolView
        name="chevron.down"
        size={12}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}
