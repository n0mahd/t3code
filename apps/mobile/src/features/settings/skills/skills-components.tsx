import { shouldShowInstanceBadge } from "@t3tools/client-runtime/state/provider-instance-display";
import type { SkillAgent } from "@t3tools/client-runtime/skills";
import { Pressable, Text as NativeText, View } from "react-native";
import { Markdown, type CustomRenderers } from "react-native-nitro-markdown";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ProviderInstanceIcon } from "../../../components/ProviderIcon";
import { ThemedSwitch } from "../../../components/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { useUniwindTheme } from "../../../lib/useUniwindTheme";
import { useMarkdownPreviewStyles } from "../../files/FileMarkdownPreview";

/** An agent's icon. Instances that share a driver carry a badge, so they can be told apart. */
export function SkillAgentIcon(props: {
  readonly agent: SkillAgent;
  /** Every agent on the page, to know whether this one shares its driver with another. */
  readonly agents: readonly SkillAgent[];
  readonly size?: number;
}) {
  const surface = String(useUniwindTheme()["--color-grouped-card"]);
  return (
    <ProviderInstanceIcon
      provider={props.agent.driverKind}
      size={props.size ?? 16}
      displayName={props.agent.displayName}
      accentColor={props.agent.accentColor}
      showBadge={shouldShowInstanceBadge(props.agent, props.agents)}
      surfaceColor={surface}
    />
  );
}

/**
 * Who has a skill or file on: one mark when every installed agent does, otherwise just the agents
 * that do, and nothing when none does.
 */
export function SkillAgents(props: {
  readonly value: { readonly everyone: boolean; readonly agents: readonly SkillAgent[] };
  readonly agents: readonly SkillAgent[];
  /** What a screen reader says, such as "Available to all your agents". */
  readonly label: string;
}) {
  if (!props.value.everyone && props.value.agents.length === 0) return null;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={props.label}
      className="shrink-0 flex-row items-center gap-1"
    >
      {props.value.everyone ? (
        <SymbolView
          name="sparkles"
          size={16}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ) : (
        props.value.agents.map((agent) => (
          <SkillAgentIcon key={agent.instanceId} agent={agent} agents={props.agents} />
        ))
      )}
    </View>
  );
}

/** A small rounded button for a fix or a filter beside a row. */
export function SkillsPillButton(props: {
  readonly label: string;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected: props.selected }}
      disabled={props.disabled}
      className={cn(
        "shrink-0 rounded-full px-3 py-2 active:opacity-70 disabled:opacity-40",
        props.selected ? "bg-primary" : "bg-subtle",
      )}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** One agent and its own switch. A switch that can't be flipped says why under the name. */
export function SkillAgentSwitchRow(props: {
  readonly agent: SkillAgent;
  readonly agents: readonly SkillAgent[];
  readonly on: boolean;
  /** Why the switch can't be flipped, or null when it can. */
  readonly blocker: string | null;
  /** Nothing can be switched now, such as while a change is being made. */
  readonly disabled: boolean;
  readonly separated: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <View
      className={cn(
        "flex-row items-center gap-3 px-4 py-3",
        props.separated && "border-t border-border-subtle",
      )}
    >
      <SkillAgentIcon agent={props.agent} agents={props.agents} size={20} />
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground" numberOfLines={1}>
          {props.agent.displayName}
        </Text>
        {props.blocker ? (
          <Text className="text-sm text-foreground-muted">{props.blocker}</Text>
        ) : null}
      </View>
      <ThemedSwitch
        accessibilityLabel={props.agent.displayName}
        disabled={props.disabled || props.blocker !== null}
        value={props.on}
        onValueChange={props.onToggle}
      />
    </View>
  );
}

/** The line a change leaves behind, until it is dismissed or the next change replaces it. */
export function SkillsNotice(props: { readonly text: string; readonly onDismiss: () => void }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      className="flex-row items-start gap-3 rounded-2xl bg-grouped-card px-4 py-3"
    >
      <Text className="min-w-0 flex-1 text-sm text-foreground">{props.text}</Text>
      <Pressable
        accessibilityLabel="Dismiss"
        accessibilityRole="button"
        hitSlop={8}
        onPress={props.onDismiss}
      >
        <SymbolView name="xmark" size={14} tintColorClassName="accent-icon" type="monochrome" />
      </Pressable>
    </View>
  );
}

/** A warning line, such as a folder that couldn't be read. */
export function SkillsWarning(props: {
  readonly text: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View className="flex-row flex-wrap items-center gap-2 px-2">
      <Text className="min-w-0 shrink text-sm text-warning-foreground">{props.text}</Text>
      {props.actionLabel && props.onAction ? (
        <SkillsPillButton label={props.actionLabel} onPress={props.onAction} />
      ) : null}
    </View>
  );
}

const PLAIN_RENDERERS: CustomRenderers = {
  link: ({ children }) => (
    <NativeText style={{ textDecorationLine: "underline" }}>{children}</NativeText>
  ),
  image: ({ node }) => <NativeText>{node.alt ?? ""}</NativeText>,
};

/**
 * A SKILL.md or an instruction file, read-only. Links and images stay plain text, so reading one
 * never opens a page or fetches anything.
 */
export function SkillsMarkdown(props: { readonly text: string }) {
  const styles = useMarkdownPreviewStyles();
  return (
    <Markdown
      options={{ gfm: true }}
      renderers={PLAIN_RENDERERS}
      styles={styles.styles}
      theme={styles.theme}
    >
      {props.text}
    </Markdown>
  );
}
