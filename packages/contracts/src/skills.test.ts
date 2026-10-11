import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SkillCreateInput, SkillName, skillNameProblem } from "./skills.ts";

const isSkillName = Schema.is(SkillName);

describe("skill names", () => {
  it.each([
    ["review-code", undefined],
    ["a", undefined],
    ["v2", undefined],
    ["2fa-setup", undefined],
    ["x".repeat(64), undefined],
    ["", "empty"],
    ["x".repeat(65), "tooLong"],
    ["Review", "characters"],
    ["review_code", "characters"],
    ["review code", "characters"],
    ["review.code", "characters"],
    ["café", "characters"],
    ["-review", "hyphens"],
    ["review-", "hyphens"],
    ["review--code", "hyphens"],
    ["-", "hyphens"],
  ] as const)("%j: %s", (name, problem) => {
    expect(skillNameProblem(name)).toBe(problem);
    // The server takes exactly the names the form lets through.
    expect(isSkillName(name)).toBe(problem === undefined);
  });
});

describe("SkillCreateInput", () => {
  const decode = Schema.decodeUnknownExit(SkillCreateInput);
  const input = { scope: "global", name: "review-code", description: "Review a diff." };

  it("takes a one-line description, trimmed", () => {
    expect(decode({ ...input, description: "  Review a diff.  " })).toMatchObject({
      _tag: "Success",
      value: { description: "Review a diff." },
    });
  });

  it.each(["", "   ", "two\nlines", "two\r\nlines", "x".repeat(1025)])(
    "refuses the description %j",
    (description) => {
      expect(decode({ ...input, description })._tag).toBe("Failure");
    },
  );
});
