import type { StaticScreenProps } from "@react-navigation/native";
import {
  findInstructionRow,
  instructionChips,
  type InstructionData,
  type InstructionRow,
} from "@t3tools/client-runtime/skills/instructions";
import type { EnvironmentId, InstructionReadResult } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../../components/ScreenScrollView";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsActionRow } from "../components/SettingsActionRow";
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

/** An instruction file, read-only, with the agents that read it. */
export function SettingsInstructionRouteScreen({ route }: Props) {
  const insets = useSafeAreaInsets();
  const settings = useSkillsSettings();
  const { instructions, instructionsCtx } = settings;
  const row = useMemo(
    () =>
      instructions ? findInstructionRow(instructions, instructionsCtx, route.params.id) : null,
    [instructions, instructionsCtx, route.params.id],
  );
  const environmentId = settings.environment?.environmentId ?? null;
  return (
    <SettingsScreen title={row?.heading ?? "Instructions"}>
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
        {row && instructions && environmentId !== null ? (
          <InstructionDetail
            key={row.id}
            row={row}
            data={instructions}
            environmentId={environmentId}
            cwd={settings.cwd}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            This file isn't there any more.
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: InstructionReadResult }
  | { readonly status: "error" };

function InstructionDetail(props: {
  readonly row: InstructionRow;
  readonly data: InstructionData;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
}) {
  const { row, data, environmentId, cwd } = props;
  const { entry } = row;
  const settings = useSkillsSettings();
  const ctx = settings.instructionsCtx;
  const locked = settings.busy || !settings.canChangeInstructions;
  const readInstruction = useAtomCommand(serverEnvironment.readInstruction, {
    reportFailure: false,
  });
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const id = entry.id;
  const chips = useMemo(() => instructionChips(entry, ctx, data), [entry, ctx, data]);

  const read = useCallback(
    (): Promise<LoadState> =>
      readInstruction({ environmentId, input: { id, ...(cwd ? { cwd } : {}) } }).then(
        (result) =>
          result._tag === "Success"
            ? { status: "ready", result: result.value }
            : { status: "error" },
        () => ({ status: "error" }),
      ),
    [readInstruction, environmentId, id, cwd],
  );
  useEffect(() => {
    let cancelled = false;
    void read().then((next) => {
      if (!cancelled) setLoad(next);
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  return (
    <>
      {row.headingNote !== "" ? (
        <Text className="px-2 text-sm text-foreground-muted">{row.headingNote}</Text>
      ) : null}

      {entry.exists && chips.length > 0 ? (
        <SettingsSection title="Used by">
          {chips.map((chip, index) => (
            <SkillAgentSwitchRow
              key={chip.agent.instanceId}
              agent={chip.agent}
              agents={ctx.installed}
              on={chip.on}
              blocker={chip.locked ? chip.lines.join(" ") : null}
              disabled={locked || chip.plan === null}
              separated={index > 0}
              onToggle={() => {
                if (chip.plan) settings.runInstructionPlan(chip.plan);
              }}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection>
        <View className="p-4">
          {load.status === "loading" ? (
            <ActivityIndicator accessibilityLabel="Loading the file" />
          ) : load.status === "error" ? (
            <View className="items-start gap-3">
              <Text className="text-base text-warning-foreground">The file couldn't be read.</Text>
              <SkillsPillButton
                label="Try again"
                onPress={() => {
                  setLoad({ status: "loading" });
                  void read().then(setLoad);
                }}
              />
            </View>
          ) : load.result.tooLarge ? (
            <Text className="text-base text-warning-foreground">
              This file is too large to show here.
            </Text>
          ) : (load.result.contents ?? "") === "" ? (
            <Text className="text-base text-foreground-muted">This file is empty.</Text>
          ) : (
            <SkillsMarkdown text={load.result.contents ?? ""} />
          )}
        </View>
      </SettingsSection>

      <SettingsSection>
        <SettingsActionRow
          icon="doc.on.doc"
          label="Copy path"
          onPress={() => copyTextWithHaptic(entry.path, { target: "instruction path" })}
        />
      </SettingsSection>
    </>
  );
}
