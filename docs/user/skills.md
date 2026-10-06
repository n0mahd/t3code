# Skills

Open **Settings → Skills** on web and desktop to see which skills your agents can use. The page
reads the environment and project chosen at the top of Settings, so with a remote environment you
see that machine's skills. You can turn each skill on or off for each agent here. To change what a
skill says, edit it in your editor or ask an agent.

The agents are your enabled provider instances. Two Claude instances show as two agents, each
with its own config folder.

## Where skills live

Keep a repo's skills in `.agents/skills` and your own in `~/.agents/skills`. Codex, Cursor,
OpenCode and Pi read both folders, and Grok reads the global one. Other agents read their own
folders instead, such as Claude's `.claude/skills` and `~/.claude/skills`. Antigravity reads the
project's `.agents/skills`, but not the global `~/.agents/skills`; its global folder is
`~/.gemini/config/skills`. A skill reaches an agent that doesn't read the shared folder through a
link or a copy in the folder it does read. The page follows links to the real folder and shows
where each agent reads a skill from.

Each instance's config folder follows its settings: a Claude instance's config directory (or
`CLAUDE_CONFIG_DIR`), `CODEX_HOME` and `GROK_HOME`. A skill in a folder that none of your enabled
agents reads isn't listed. If a folder exists but can't be read, the page says so above the list
instead of showing it as empty.

## Turning a skill on or off for an agent

Open a skill and click an agent under **Used by**. Turning a skill on makes a link in that agent's
own folder that points at the skill's real folder, so the files stay in one place. Turning it off
removes that link and nothing else.

- An agent that reads the skill's own folder directly shows a lock: it is always on. To stop it
  using the skill, move the skill out of that folder yourself.
- Agents that read the same folder share one link, so turning a skill on or off for one can change
  it for the others. T3 Code says who else is affected.
- If something is already in the agent's folder under that name, such as a real folder, a file or
  a link to a different skill, T3 Code leaves it alone and says so. It never replaces anything.
- A project's links to skills inside the project are relative, so they keep working when the
  project moves. They show in `git status`; commit them to give everyone who clones the project
  the skill. On Windows, global links are junctions, and project links need Developer Mode or
  administrator rights.

Tick the boxes beside skills to act on several at once: turn them on for all agents, turn them off
for one agent, or remove them. **Remove from agents** takes away every link to the skills so agents
stop using them. It never deletes the original folders.

## Moving and deleting

**Move to Global** and **Move to this project** move a skill's folder between the project's
`.agents/skills` and `~/.agents/skills`, and the agents that used it keep using it. A skill is never
merged into or replaced by one with the same name on the other side; T3 Code leaves both and says
so. **Delete** removes the skill's folder and the links to it, and can't be undone. When git tracks
a project skill, both show up in `git status` and the confirmation says you can undo them with git.
Only a skill kept in an agent's own skill folder can be moved or deleted. One that is only linked
there, such as a skill from a synced folder, stays where it is.

## Needs attention

**Needs attention** filters the list to skills that need a look. A skill is on it when:

- an installed and enabled agent doesn't use it. Hover the icons to see which agent, or use the
  button on the row to turn the skill on for it. An agent
  loads one skill per name, the first it finds in its folders (Codex and OpenCode list every
  copy), so a copy that another folder shadows is not used by that agent. Claude doesn't use a
  skill that its own `skillOverrides` setting switches off either.
- the same name exists more than once with different text, in **This project**, in **Global**, or
  across them. These rows have a **Conflict** badge.
- Claude can't read the skill's header, the YAML between the `---` lines at the top of
  `SKILL.md`, so it skips the skill. Quote a value that contains a colon or brackets, for example
  a description.

## Limits

- Only a project's top folders are read, such as `<project>/.agents/skills`, not the folders
  above it that some agents also read.
- A skill's file list stops at 500 files, and `SKILL.md` isn't shown past 1 MB.
- A `SKILL.md` that is a link to a file outside the skill's folder isn't read.
