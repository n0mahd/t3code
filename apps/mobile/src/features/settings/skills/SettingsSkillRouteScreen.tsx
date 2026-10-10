import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  attention,
  hasAccess,
  planDelete,
  planToggle,
  planTurnOnAll,
  scriptFiles,
  skillBody,
  switchBlocker,
  type Skill,
} from "@t3tools/client-runtime/skills";
import type { EnvironmentId, SkillGetResult } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../../components/ScreenScrollView";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsActionRow } from "../components/SettingsActionRow";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import {
  SkillAgentSwitchRow,
  SkillsMarkdown,
  SkillsNotice,
  SkillsPillButton,
} from "./skills-components";
import { useSkillsSettings } from "./skills-settings";

type Props = StaticScreenProps<{ readonly id: string }>;

export function SettingsSkillRouteScreen({ route }: Props) {
  const insets = useSafeAreaInsets();
  const settings = useSkillsSettings();
  const skill = settings.skills?.skills.find((entry) => entry.id === route.params.id);
  const environmentId = settings.environment?.environmentId ?? null;
  return (
    <SettingsScreen title={skill?.name ?? "Skill"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {settings.notice ? (
          <SkillsNotice text={settings.notice} onDismiss={settings.dismissNotice} />
        ) : null}
        {skill && environmentId !== null ? (
          <SkillDetail
            key={skill.id}
            skill={skill}
            environmentId={environmentId}
            cwd={settings.cwd}
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

type DetailState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: SkillGetResult }
  | { readonly status: "error" };

function SkillDetail(props: {
  readonly skill: Skill;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
}) {
  const { skill, environmentId, cwd } = props;
  const navigation = useNavigation();
  const settings = useSkillsSettings();
  const ctx = settings.skillsCtx;
  const locked = settings.busy || !settings.canChangeSkills;
  const readSkill = useAtomCommand(serverEnvironment.getSkill, { reportFailure: false });
  const [detail, setDetail] = useState<DetailState>({ status: "loading" });
  const { scope, name, home } = skill;

  const read = useCallback(
    (): Promise<DetailState> =>
      readSkill({ environmentId, input: { scope, name, home, ...(cwd ? { cwd } : {}) } }).then(
        (result) =>
          result._tag === "Success" && result.value.home
            ? { status: "ready", result: result.value }
            : { status: "error" },
        () => ({ status: "error" }),
      ),
    [readSkill, environmentId, scope, name, home, cwd],
  );
  useEffect(() => {
    let cancelled = false;
    void read().then((next) => {
      if (!cancelled) setDetail(next);
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  // The list only holds a short preview; the open skill shows the whole description.
  const description =
    (detail.status === "ready" ? detail.result.description : "") || skill.description;
  const folder = detail.status === "ready" ? detail.result.home : null;
  const scripts = detail.status === "ready" ? scriptFiles(detail.result.files) : [];
  const warning = attention(skill, ctx);
  const turnOnAll = planTurnOnAll([skill], ctx);
  const del = planDelete([skill], ctx);
  // A deleted skill is gone, so its screen closes once the delete went through.
  const backToList = (done: boolean) => {
    if (done) navigation.dispatch(StackActions.popTo("SettingsSkills"));
  };

  return (
    <>
      <View className="gap-2 px-2">
        <Text className="text-base text-foreground">{description || "No description yet."}</Text>
        <Text className="text-sm text-foreground-muted">
          {skill.scope === "global" ? "Global" : "This project"}
        </Text>
        {warning && warning.kind !== "missing" ? (
          <Text className="text-sm text-warning-foreground">{warning.detail}</Text>
        ) : null}
        {scripts.length > 0 ? (
          <Text className="text-sm text-warning-foreground">Includes scripts</Text>
        ) : null}
      </View>

      <SettingsSection title="Used by">
        {ctx.installed.length === 0 ? (
          <Text className="p-4 text-base text-foreground-muted">No agents are installed.</Text>
        ) : (
          ctx.installed.map((agent, index) => (
            <SkillAgentSwitchRow
              key={agent.instanceId}
              agent={agent}
              agents={ctx.installed}
              on={hasAccess(skill, agent)}
              blocker={switchBlocker(skill, agent)}
              disabled={locked}
              separated={index > 0}
              onToggle={() => {
                const plan = planToggle(skill, agent, ctx);
                if (plan) settings.runSkillPlan(plan);
              }}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection>
        <SettingsRow
          icon="folder"
          label="Use in…"
          disabled={locked}
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsSkillUseIn", params: { id: skill.id } },
            })
          }
        />
        {turnOnAll ? (
          <SettingsActionRow
            icon="sparkles"
            label="Turn on for all agents"
            disabled={locked}
            onPress={() => settings.runSkillPlan(turnOnAll)}
          />
        ) : null}
        {folder ? (
          <SettingsActionRow
            icon="doc.on.doc"
            label="Copy path"
            onPress={() => copyTextWithHaptic(folder, { target: "skill path" })}
          />
        ) : null}
        {del ? (
          <SettingsActionRow
            icon="trash"
            label="Delete"
            tone="danger"
            disabled={locked}
            onPress={() => settings.runSkillPlan(del, backToList)}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="SKILL.md">
        <View className="p-4">
          {detail.status === "loading" ? (
            <ActivityIndicator accessibilityLabel="Loading the skill" />
          ) : detail.status === "error" ? (
            <View className="items-start gap-3">
              <Text className="text-base text-warning-foreground">
                The skill's files couldn't be read.
              </Text>
              <SkillsPillButton
                label="Try again"
                onPress={() => {
                  setDetail({ status: "loading" });
                  void read().then(setDetail);
                }}
              />
            </View>
          ) : detail.result.contents === null ? (
            <Text className="text-base text-warning-foreground">
              SKILL.md is missing or too large to show here.
            </Text>
          ) : (
            <SkillsMarkdown text={skillBody(detail.result.contents)} />
          )}
        </View>
      </SettingsSection>
    </>
  );
}
