# Skills

Open **Settings → Skills** on web, desktop or the phone app to see which skills your agents can
use. The page reads the environment and project chosen at the top of Settings, so with a remote
environment you see that machine's skills. You can turn each skill on or off for every agent, or
for one agent at a time, and choose which projects use it. To change what a skill says, edit its
`SKILL.md` in your editor or ask an agent. In the desktop app, you can show a skill or instruction
file from this computer in your file manager.

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

## Creating a skill

**New skill** asks for a name, a one-line description, and whether the skill belongs to the project
picked at the top of Settings or is Global. Names use lowercase letters, digits and single hyphens,
up to 64 characters, as every agent requires. T3 Code writes the skill's `SKILL.md` in the
project's `.agents/skills` or in `~/.agents/skills`, turns it on for every agent, and opens it so
you can write its instructions. A name that is already taken in any of the agents' skill folders
there is refused.

## Turning skills on or off

A skill's switch turns it on or off for every agent. Open the skill to switch a single agent. The
switch on **This project**, **Global** or a group changes all of its skills at once, and asks
before turning many off.

Turning a skill on for an agent that reads a different folder makes a link in that agent's own
folder that points at the skill's real folder, so the files stay in one place. Turning it off
removes that link and nothing else.

- An agent that reads the skill's own folder directly has no link to remove. Claude, Codex and
  OpenCode (and Pi, for Global skills) have a setting for it, so turning the skill off writes that
  setting, and turning it on takes it away again. A project or organization setting can still
  decide, and T3 Code says so. Cursor, Grok and Antigravity have no such setting, so their switch is
  disabled and the skill stays on. To stop one using the skill, move the skill out of that folder
  yourself.
- Agents that read the same folder share one link, so turning a skill on or off for one can change
  it for the others. T3 Code says who else is affected.
- If something is already in the agent's folder under that name, such as a real folder, a file or
  a link to a different skill, T3 Code leaves it alone and says so. It never replaces anything.
- A project's links to skills inside the project are relative, so they keep working when the
  project moves. They show in `git status`; commit them to give everyone who clones the project
  the skill. On Windows, global links are junctions, and project links need Developer Mode or
  administrator rights.

Skills the installer recorded as coming from the same place, such as a GitHub repo, are grouped
together when there are two or more.

## Acting on several skills

Choose **Select** to act on several skills at once: turn them on or off for every agent, delete
them, or put them in projects with **Use in…**. Ticking a group ticks all of its skills.

## Using a skill in projects

**Use in…** chooses where a skill is used: **This project only**, **Globally**, or **Only these
projects**, which lists the projects of this environment. A skill used in only some projects is
still Global, with one copy, so an edit shows up in all of them. Each change asks first, and never
merges into or replaces a skill with the same name; T3 Code leaves both and says so. When git
tracks a project skill that leaves its project, the confirmation says you can undo it with git.

Such a skill is linked into each project that uses it, outside git, and into the worktrees T3 Code
makes for those projects. The agents that read `.agents/skills` have it in all of them. Turning on
an agent with a folder of its own, such as Claude, adds its link in each of those projects, never
in Global. If a moved skill's installer record can't go with it, T3 Code says the skill won't
update from its source any more.

**Delete** removes the skill's folder and the links to it, and can't be undone. Only a skill kept
in an agent's own skill folder can be deleted. One that is only linked there, such as a skill from
a synced folder, stays where it is.

Agents running in T3 Code can do the same: list and create skills, turn them on or off, choose
where they are used and delete them. To move or delete skills, an agent first gets the plan,
including what git can undo, and nothing changes until it confirms.

## Built in and plugins

Skills that come with an agent are listed apart, under **Built in and plugins**: Codex's system
skills and the skills of your installed Claude Code plugins. They belong to that agent, so T3 Code
never moves or deletes them, and no other agent can have them. Codex's can be turned on or off like
any other skill. A Claude plugin's skills come and go with the plugin, so turn the plugin on or off
in Claude Code with `/plugin`.

## Tidy up

With a project picked, the page offers **Tidy up** when the project's skills could be in better
shape. It fixes them in one pass, with a choice for each kind of problem:

- Skills from the same GitHub repo can move to Global, so you keep one copy for all your projects.
- A skill that is also in Global can go from the project, keeping the Global copy. **Compare**
  shows how the two differ first.
- Skills kept in Claude's own folder move to `.agents/skills`, with a link left for Claude, so
  every agent can use them.
- Skills an agent could use but doesn't are turned on for it.

Nothing changes until you confirm, and the confirmation says when git can undo it. Deleting a
project's copy can't be undone otherwise. Dismissing the offer, or tidying up, hides it until the
problems change.

## Updates

**Check for updates** compares the skills you installed with `npx skills` from GitHub with their
source, Global ones and the chosen project's. It asks GitHub once per repo, without signing in.
GitHub allows about 60 such requests an hour per network, and T3 Code says when to try again once
they're used up. Private repos can't be checked.

Open a skill with an update to see what would change before anything is written. A skill you
haven't edited gets the source's files. If you have edited it, T3 Code tells your changes apart
from the source's and keeps yours. When both changed the same lines, nothing is written until you
choose, for each such file, to keep yours or take theirs. **Keep mine** skips that update without
changing any file. **Update all** updates a group, or every skill with an update, and leaves any
skill whose edits clash for you to open.

An update replaces the skill's folder in one step, keeps its links, and records the new version in
the `skills` CLI's lock file, so `npx skills update` then sees it as current. A skill that holds
links, or whose source does, isn't updated here.

## Instructions

The **Instructions** section at the top of the page lists the files your agents read before they
start work, under **Project** and **Global**. Open a file to edit it. Edits save as you type, and
if the file changed on disk, T3 Code asks before overwriting it. A file that none of your enabled
agents read, such as `CLAUDE.md` with Claude off, isn't listed.

**Project** holds the project's `AGENTS.md`, shared through the repo, its `CLAUDE.md`, and your own
`CLAUDE.local.md`, which only Claude reads. T3 Code keeps a new `CLAUDE.local.md` out of git.
`AGENTS.md` and `CLAUDE.md` files in subfolders are under **In subfolders**. A `CLAUDE.md` that
only says `@AGENTS.md`, or is a link to `AGENTS.md`, already does its job, so it isn't listed.

**Global** is yours alone and used in every project. It is `~/.agents/AGENTS.md`, or the file your
agents already link to. Turn agents on or off for its `AGENTS.md`, or edit it. An agent with an
`AGENTS.md` of its own can use Global instead, which adds its text to the end of Global and links
the agent to it. T3 Code never replaces a file any other way. Global also lists Claude's
`CLAUDE.md` and the file your organization sets, which is read-only.

Claude skips a project's `AGENTS.md` when the project has a `CLAUDE.md`, a `.claude/CLAUDE.md` or a
`CLAUDE.local.md`. Set **Claude reads AGENTS.md** to **Alongside any CLAUDE.md** to read both. It
applies in every project and needs Claude Code 2.1.277 or later.

To make a project's `CLAUDE.md` the file every agent reads, **Move to AGENTS.md** renames it, or
**Merge into AGENTS.md**, when the project already has an `AGENTS.md`, adds its text to the end and
deletes `CLAUDE.md`. If Claude would still skip `AGENTS.md` afterwards, the confirmation says it
also turns **Claude reads AGENTS.md** on, for every project.

**Move to Global** adds a project file's text to the end of your Global `AGENTS.md` and deletes the
file from the project, so it also leaves the repo for everyone who clones it. **Copy to this
project** adds your Global text to the end of the project's `AGENTS.md` and keeps Global as it is.

Agents running in T3 Code can list and read these files, edit them, create a missing project
`AGENTS.md`, `CLAUDE.local.md` or Global `AGENTS.md`, and turn Global on or off for agents. An edit
is refused when the file changed since the agent read it. The Claude choice stays yours.

## Needs attention

**Needs attention** filters the list to skills and instructions that need a look. An instruction
file is on it when Claude skips a project's `AGENTS.md`, when an agent doesn't use Global or keeps
an `AGENTS.md` of its own, or when other agents can't read a project's `CLAUDE.md`. A skill is on
it when:

- an installed and enabled agent doesn't use it. An agent loads one skill per name, the first it
  finds in its folders (Codex and OpenCode list every copy), so a copy that another folder shadows
  is not used by that agent. Claude doesn't use a skill that its own `skillOverrides` setting
  switches off either.
- the same name exists more than once with different text, in **This project**, in **Global**, or
  across them.
- Claude can't read the skill's header, the YAML between the `---` lines at the top of
  `SKILL.md`, so it skips the skill. Quote a value that contains a colon or brackets, for example
  a description.

## On your phone

The phone app shows the same skills and instruction files. You can turn skills on or off, use them
in other projects, delete them, apply the fixes **Needs attention** offers, and change **Claude
reads AGENTS.md**. `SKILL.md` and instruction files are read-only there; edit them on web or
desktop. Creating skills, **Tidy up**, updates, built-in and plugin skills, moving instruction
files and acting on several skills at once are web and desktop only. When Settings covers several environments, the page shows
one at a time.

## Limits

- Only a project's top folders are read, such as `<project>/.agents/skills`, not the folders
  above it that some agents also read.
- An instruction file isn't shown or edited past 1 MB.
- A skill's file list stops at 500 files, and `SKILL.md` isn't shown past 1 MB.
- A `SKILL.md` that is a link to a file outside the skill's folder isn't read.
