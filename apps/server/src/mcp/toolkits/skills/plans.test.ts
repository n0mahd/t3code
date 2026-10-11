import type { SkillSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planDelete, planMove } from "./plans.ts";

const skill = (name: string, extra: Partial<SkillSummary> = {}): SkillSummary => ({
  name,
  scope: "global",
  home: `~/.codex/skills/.system/${name}`,
  description: `The ${name} skill.`,
  realFolder: true,
  copies: [],
  access: [],
  ...extra,
});
const ref = ({ scope, name, home }: SkillSummary) => ({ scope, name, home });

describe("plans for skills that come with an agent", () => {
  const imagegen = skill("imagegen", { provided: "agent" });

  it("leaves them out of a deletion", () => {
    expect(planDelete({ listed: [imagegen], skills: [ref(imagegen)], tracked: [] })).toEqual([
      "“imagegen” comes with an agent, so it stays as it is.",
      "There is nothing to delete.",
    ]);
  });

  it("leaves them out of a move", () => {
    expect(
      planMove({
        listed: [imagegen],
        skills: [ref(imagegen)],
        to: { kind: "project", cwd: "/home/user/acme-web" },
        projectNames: ["acme-web"],
        tracked: [],
      }),
    ).toEqual([
      "“imagegen” comes with an agent, so it stays as it is.",
      "There is nothing to move.",
    ]);
  });
});
