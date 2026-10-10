/**
 * What `t3_skill_move` and `t3_skill_delete` would do, in plain words, for a call without
 * `confirm: true`. It words the same plan the Settings page confirms (`SkillsSettings.logic.ts`),
 * from the list as it is now and the project skills git tracks.
 *
 * @module plans
 */
import type { SkillPlacement, SkillRef, SkillSummary } from "@t3tools/contracts";

/** The most skill names one sentence lists before it says how many more. */
const SHOWN = 10;

const joinNames = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const namesOf = (skills: ReadonlyArray<{ readonly name: string }>) => {
  const quoted = skills.map((skill) => `“${skill.name}”`);
  return quoted.length <= SHOWN
    ? joinNames(quoted)
    : `${quoted.slice(0, SHOWN).join(", ")} and ${quoted.length - SHOWN} more`;
};

const one = (skills: readonly unknown[]) => skills.length === 1;
const it = (skills: readonly unknown[]) => (one(skills) ? "it" : "them");
const is = (skills: readonly unknown[]) => (one(skills) ? "is" : "are");

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const nextStep = (tool: string) =>
  `Nothing has changed yet. To do it, call ${tool} again with the same arguments and confirm: true.`;

/** The skills asked for as the list shows them now, and those it no longer shows there. */
function lookUp(listed: readonly SkillSummary[], refs: readonly SkillRef[]) {
  const found: SkillSummary[] = [];
  const missing: SkillRef[] = [];
  for (const ref of refs) {
    const skill = listed.find(
      (item) => item.scope === ref.scope && item.name === ref.name && item.home === ref.home,
    );
    if (skill === undefined) missing.push(ref);
    else found.push(skill);
  }
  const lines = missing.map(
    (ref) =>
      `“${ref.name}” isn't at ${ref.home} any more, so it is left out. List the skills again.`,
  );
  return { found, lines };
}

/** Whether the skill is placed that way already, so there is nothing to do for it. */
function placedAlready(skill: SkillSummary, to: SkillPlacement) {
  switch (to.kind) {
    case "project":
      return skill.scope === "project";
    case "global":
      return skill.scope === "global" && !skill.projects?.length;
    case "projects": {
      const used = new Set(skill.projects ?? []);
      return (
        skill.scope === "global" &&
        used.size === new Set(to.cwds).size &&
        to.cwds.every((cwd) => used.has(cwd))
      );
    }
  }
}

/**
 * A sentence saying which of the project skills a change removes git can bring back, and whether
 * that is all of them.
 */
function gitNote(
  removed: readonly SkillSummary[],
  tracked: ReadonlySet<string>,
  undo: (them: string) => string,
) {
  const inGit = removed.filter((skill) => skill.scope === "project" && tracked.has(skill.name));
  if (inGit.length === 0) return undefined;
  const whole = inGit.length === removed.length;
  return {
    whole,
    text: whole
      ? `git tracks ${it(removed)}, so you can undo this with git.`
      : `git tracks ${namesOf(inGit)}, so you can undo ${undo(it(inGit))} with git.`,
  };
}

export function planMove(input: {
  readonly listed: readonly SkillSummary[];
  readonly skills: readonly SkillRef[];
  readonly to: SkillPlacement;
  /** The names of the projects `to` names, in its order. */
  readonly projectNames: readonly string[];
  /** The project skills git tracks. */
  readonly tracked: readonly string[];
}): string[] {
  const { found, lines } = lookUp(input.listed, input.skills);
  const already = found.filter((skill) => placedAlready(skill, input.to));
  const coming = found.filter((skill) => !placedAlready(skill, input.to));
  if (already.length > 0) {
    lines.push(`${namesOf(already)} ${is(already)} used there already.`);
  }
  if (coming.length === 0) {
    lines.push("There is nothing to move.");
    return lines;
  }
  const what = namesOf(coming);
  const where = joinNames(input.projectNames);
  const becomeGlobal = coming.every((skill) => skill.scope === "global")
    ? ""
    : ` ${one(coming) ? "becomes" : "become"} Global and`;
  switch (input.to.kind) {
    case "project":
      lines.push(
        `${what} ${one(coming) ? "moves" : "move"} into ${where}, so anyone who clones it gets ${it(coming)}.`,
      );
      break;
    case "global":
      lines.push(`${what}${becomeGlobal} will be on in every project.`);
      break;
    case "projects":
      lines.push(
        input.projectNames.length === 1
          ? `${what}${becomeGlobal} will be on in ${where} only.`
          : `${what}${becomeGlobal} will be on in ${where}. There's one copy, so an edit shows up in ${input.projectNames.length === 2 ? "both" : "all of them"}.`,
      );
      break;
  }
  lines.push(`Agents that use ${it(coming)} now keep using ${it(coming)}.`);
  // A move into a project makes new files there, so git has nothing to undo.
  const git =
    input.to.kind === "project"
      ? undefined
      : gitNote(coming, new Set(input.tracked), (them) => `taking ${them} out of the project`);
  if (git !== undefined) lines.push(git.text);
  lines.push(nextStep("t3_skill_move"));
  return lines;
}

export function planDelete(input: {
  readonly listed: readonly SkillSummary[];
  readonly skills: readonly SkillRef[];
  /** The project skills git tracks. */
  readonly tracked: readonly string[];
}): string[] {
  const { found, lines } = lookUp(input.listed, input.skills);
  const targets = found.filter((skill) => skill.realFolder === true);
  const kept = found.filter((skill) => skill.realFolder !== true);
  if (kept.length > 0) {
    lines.push(
      `${namesOf(kept)} ${is(kept)} reached through a link, not kept in an agent's skill folder, so ${one(kept) ? "it stays" : "they stay"}.`,
    );
  }
  if (targets.length === 0) {
    lines.push("There is nothing to delete.");
    return lines;
  }
  lines.push(
    one(targets)
      ? `This deletes ${targets[0]!.home} and any links to it.`
      : `This deletes ${plural(targets.length, "folder")} and any links to them: ${targets.map((skill) => skill.home).join(", ")}.`,
  );
  const losing = [
    ...new Set(
      targets.flatMap((skill) =>
        skill.access
          .filter((access) => access.state === "direct" || access.state === "link")
          .map((access) => access.instanceId),
      ),
    ),
  ];
  if (losing.length > 0) lines.push(`${joinNames(losing)} will stop using ${it(targets)}.`);
  const git = gitNote(targets, new Set(input.tracked), (them) => `deleting ${them}`);
  if (git === undefined) lines.push("It can't be undone.");
  else lines.push(git.whole ? git.text : `${git.text} The rest can't be undone.`);
  lines.push(nextStep("t3_skill_delete"));
  return lines;
}
