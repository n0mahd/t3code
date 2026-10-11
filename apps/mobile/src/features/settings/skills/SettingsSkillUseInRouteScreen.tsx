import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  placeTarget,
  planPlace,
  startingPlacement,
  type PlaceChoice,
  type ProjectOption,
  type Skill,
} from "@t3tools/client-runtime/skills";
import { useMemo, useState } from "react";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../../components/ScreenScrollView";
import { cn } from "../../../lib/cn";
import { SettingsActionRow } from "../components/SettingsActionRow";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { useSkillsSettings } from "./skills-settings";

type Props = StaticScreenProps<{ readonly id: string }>;

/**
 * Where a skill is used: in the picked project only, in every project, or in a few projects.
 * Applying asks before it changes anything.
 */
export function SettingsSkillUseInRouteScreen({ route }: Props) {
  const insets = useSafeAreaInsets();
  const settings = useSkillsSettings();
  const skill = settings.skills?.skills.find((entry) => entry.id === route.params.id);
  return (
    <SettingsScreen title="Use in…">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {skill ? (
          <UseInForm
            key={skill.id}
            skill={skill}
            picked={settings.places.picked}
            projects={settings.places.projects}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            This skill isn't there any more.
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function UseInForm(props: {
  readonly skill: Skill;
  readonly picked: ProjectOption | null;
  readonly projects: readonly ProjectOption[];
}) {
  const navigation = useNavigation();
  const settings = useSkillsSettings();
  const skills = useMemo(() => [props.skill], [props.skill]);
  const start = useMemo(() => startingPlacement(skills, props.picked), [skills, props.picked]);
  const [choice, setChoice] = useState<PlaceChoice | null>(start.choice);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(start.ticked));
  const target = placeTarget(choice, props.picked, props.projects, ticked);
  // Nothing to apply while the skill is placed that way already.
  const plan = target ? planPlace(skills, target) : null;
  const locked = settings.busy || !settings.canChangeSkills;
  const choices: ReadonlyArray<{ readonly value: PlaceChoice; readonly label: string }> = [
    ...(props.picked ? [{ value: "project" as const, label: "This project only" }] : []),
    { value: "global", label: "Globally" },
    { value: "projects", label: "Only these projects" },
  ];

  return (
    <>
      <SettingsSection title={props.skill.name}>
        {choices.map((entry, index) => (
          <CheckRow
            key={entry.value}
            role="radio"
            label={entry.label}
            checked={choice === entry.value}
            separated={index > 0}
            onPress={() => setChoice(entry.value)}
          />
        ))}
      </SettingsSection>

      {choice === "projects" ? (
        <SettingsSection title="Projects">
          {props.projects.length === 0 ? (
            <Text className="p-4 text-base text-foreground-muted">No projects here yet.</Text>
          ) : (
            props.projects.map((project, index) => (
              <CheckRow
                key={project.cwd}
                role="checkbox"
                label={project.label}
                checked={ticked.has(project.cwd)}
                separated={index > 0}
                onPress={() =>
                  setTicked((current) => {
                    const next = new Set(current);
                    if (next.has(project.cwd)) next.delete(project.cwd);
                    else next.add(project.cwd);
                    return next;
                  })
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}

      <SettingsSection>
        <SettingsActionRow
          icon="checkmark"
          label="Apply"
          disabled={plan === null || locked}
          onPress={() => {
            if (!plan) return;
            // The skill has a new home once it moved, so the list is where to look for it.
            settings.runSkillPlan(plan, (done) => {
              if (done) navigation.dispatch(StackActions.popTo("SettingsSkills"));
            });
          }}
        />
      </SettingsSection>
    </>
  );
}

function CheckRow(props: {
  readonly role: "radio" | "checkbox";
  readonly label: string;
  readonly checked: boolean;
  readonly separated: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.role}
      accessibilityState={{ checked: props.checked }}
      className={cn(
        "flex-row items-center gap-4 p-4 active:opacity-70",
        props.separated && "border-t border-border-subtle",
      )}
      onPress={props.onPress}
    >
      <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      {props.checked ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}
