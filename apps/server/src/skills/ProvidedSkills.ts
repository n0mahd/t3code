/**
 * ProvidedSkills - the folders of skills that come with an agent or one of its plugins, instead of
 * the user's own skill folders. The Skills page lists them apart, and never moves, deletes or links
 * them.
 *
 * - Codex installs its system skills itself in `$CODEX_HOME/skills/.system` and reports them with
 *   scope `system`. Its `[[skills.config]]` setting switches them like any other skill.
 * - Claude Code records each installed plugin in `plugins/installed_plugins.json` under its config
 *   folder: version 2 keeps a list of installs per `name@marketplace` id, each with a `scope`
 *   (`user`, `managed`, or `project` and `local` with a `projectPath`), and version 1 one install
 *   per id. A plugin's skills are in its install's `skills` folder, and Claude names each one
 *   `<plugin>:<folder>`. `skillOverrides` doesn't reach a plugin skill (checked against Claude Code
 *   2.1.289, whose visibility check answers "on" for any skill whose source is a plugin), so T3 Code
 *   can't switch one. The whole plugin is switched by `enabledPlugins` in the settings files, where
 *   the last file that names it decides and `false` turns it off.
 *
 * Not listed: skill folders a plugin's manifest moves elsewhere, plugins synced from an account,
 * and Claude Code's bundled skills, which are not files.
 *
 * @module ProvidedSkills
 */
import type { ProviderDriverKind, SkillScope } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { skillOverrideSettingsPaths } from "../provider/Drivers/ClaudeSkills.ts";

/** A folder of skills that came with an agent. */
export interface ProvidedRoot {
  readonly kind: "agent" | "plugin";
  readonly scope: SkillScope;
  readonly directory: string;
  /** The plugin's name, which Claude puts before each of its skills' names. */
  readonly plugin?: string;
  /** The agent's settings turn the whole plugin off. */
  readonly off: boolean;
}

const PluginInstall = Schema.Struct({
  installPath: Schema.String,
  scope: Schema.optional(Schema.String),
  projectPath: Schema.optional(Schema.String),
});
const decodeInstalledPlugins = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Struct({
      plugins: Schema.Record(
        Schema.String,
        Schema.Union([PluginInstall, Schema.Array(PluginInstall)]),
      ),
    }),
  ),
);
const decodeEnabledPlugins = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Struct({
      enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

/** `name` from a `name@marketplace` plugin id. */
const pluginName = (id: string) => {
  const at = id.lastIndexOf("@");
  return at > 0 ? id.slice(0, at) : id;
};

/** Which plugins the settings files turn off: the last file that names a plugin decides. */
const pluginsTurnedOff = Effect.fnUntraced(function* (input: {
  readonly configHome: string;
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const decided = new Map<string, boolean>();
  for (const file of skillOverrideSettingsPaths(
    path,
    input.configHome,
    input.cwd,
    platform,
    input.environment,
  )) {
    const text = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    if (text === "") continue;
    const settings = decodeEnabledPlugins(text);
    if (settings._tag === "None") continue;
    for (const [id, value] of Object.entries(settings.value.enabledPlugins ?? {})) {
      decided.set(id, value === false);
    }
  }
  return new Set([...decided].flatMap(([id, off]) => (off ? [id] : [])));
});

/** Each installed Claude plugin's skills folder that applies here. */
const claudePluginRoots = Effect.fnUntraced(function* (input: {
  readonly configHome: string;
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(input.configHome, "plugins", "installed_plugins.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  const installed = text === "" ? undefined : decodeInstalledPlugins(text);
  if (installed === undefined || installed._tag === "None") return [];
  const off = yield* pluginsTurnedOff(input);
  const roots = new Map<string, ProvidedRoot>();
  for (const [id, entry] of Object.entries(installed.value.plugins)) {
    for (const install of Array.isArray(entry) ? entry : [entry]) {
      if (!path.isAbsolute(install.installPath)) continue;
      // A project or local install is for one project; any other is for every project.
      const forProject = install.scope === "project" || install.scope === "local";
      if (
        forProject &&
        (input.cwd === undefined ||
          install.projectPath === undefined ||
          path.resolve(install.projectPath) !== path.resolve(input.cwd))
      ) {
        continue;
      }
      const directory = path.join(install.installPath, "skills");
      if (roots.has(directory)) continue;
      roots.set(directory, {
        kind: "plugin",
        scope: forProject ? "project" : "global",
        directory,
        plugin: pluginName(id),
        off: off.has(id),
      });
    }
  }
  return [...roots.values()];
});

/** The folders of skills that come with this agent or its plugins. */
export const providedSkillRoots = (input: {
  readonly driver: ProviderDriverKind;
  /** The instance's config folder: Claude's config folder or Codex's home. */
  readonly configHome: string;
  readonly cwd: string | undefined;
  /** The instance's environment over the server's. */
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<ReadonlyArray<ProvidedRoot>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    switch (input.driver) {
      case "codex":
        return [
          {
            kind: "agent",
            scope: "global",
            directory: path.join(input.configHome, "skills", ".system"),
            off: false,
          },
        ];
      case "claudeAgent":
        return yield* claudePluginRoots(input);
      default:
        return [];
    }
  });
