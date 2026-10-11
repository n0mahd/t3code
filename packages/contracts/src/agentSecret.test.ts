import { describe, expect, it } from "vite-plus/test";

import { isValidAgentSecretName, normalizeAgentSecretName } from "./agentSecret.ts";

describe("normalizeAgentSecretName", () => {
  it.each([
    ["cloudflare api token", "CLOUDFLARE_API_TOKEN"],
    ["github-token", "GITHUB_TOKEN"],
    ["Already_OK_2", "ALREADY_OK_2"],
    ["tab\there", "TAB_HERE"],
    ["a--b  c", "A__B__C"],
    ["", ""],
    // Left for validation to refuse rather than silently dropped.
    ["../x", "../X"],
    ["1st key", "1ST_KEY"],
    ["key.name", "KEY.NAME"],
  ])("%j becomes %j", (input, expected) => {
    expect(normalizeAgentSecretName(input)).toBe(expected);
  });
});

describe("isValidAgentSecretName", () => {
  it.each([
    ["A", true],
    ["CLOUDFLARE_API_TOKEN", true],
    ["KEY_2", true],
    ["A".repeat(64), true],
    ["A".repeat(65), false],
    ["", false],
    ["a", false],
    ["_KEY", false],
    ["1KEY", false],
    ["../X", false],
    ["KEY.NAME", false],
    ["KEY-NAME", false],
    ["KEY NAME", false],
  ])("%j is %s", (name, valid) => {
    expect(isValidAgentSecretName(name)).toBe(valid);
  });
});
