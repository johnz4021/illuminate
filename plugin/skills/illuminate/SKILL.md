---
name: illuminate
description: Draw a checked, interactive map that answers how something in this codebase works ("what happens when a user signs up?", "where does this email get sent?", "how does billing connect to accounts?"). Use when the user wants to understand a flow, asks how parts connect, or asks for a map, diagram or walkthrough of the code. Every box and arrow on the map is verified against the code.
---

# illuminate

illuminate turns a question about this repo into a map the person can explore in their browser: areas of the app, the
steps in order, labeled arrows, and red dashed arrows where something that should be connected isn't. A plain program
checks every claim against the code before it's shown. In the map they can take a walkthrough, select any box or arrow
and ask about it, and approve fixes that illuminate applies and re-checks.

## When to use it

- The user asks how something works across several files: "what happens when…", "how does X reach Y", "where does Z
  get triggered".
- The user is about to change code they don't understand yet and wants to see it first.
- The user asks how a change would look before it's made ("how would we add…", "plan this"): the map shows the code as
  it is, with the proposal drawn on top. Once the change is built, reopening the map shows which parts are done.
- The user asks what a change did ("what did you just change?", "what did the last commit do?"): the map shows the
  code as it is now, with what is new, different or gone since a commit marked on it.
- The user asks what someone sees or goes through in the app (a user journey): the map follows the screens, each tied
  to the code behind it.
- The user asks for a map, diagram, graph or walkthrough of part of the code.

Don't use it for a question about a single line or function; answer that directly.

## How to run it

**In Claude Code with the illuminate MCP server** (you have an `illuminate_map` tool): call `illuminate_map` with the
user's question in their own words. It opens the map in their browser and hands you work as requests: explore the code,
then `illuminate_submit` your output. Keep going while results hold another request. Once the map is ready, call
`illuminate_listen` and leave it running: it moves to the background, and returns with a request when the user asks
something on the map. Do it, submit it, and call `illuminate_listen` again. If it returns saying nothing was asked yet,
call it again without mentioning it; if it says illuminate stopped listening, don't. If the user says "listen to
illuminate", call `illuminate_listen`. Don't edit files while working on a request, and keep what you say in the terminal to a
sentence or two: the map does the explaining. `illuminate_open` opens saved maps.

**In Codex with the illuminate MCP server** (you have `illuminate_map` and `illuminate_ask` tools, and no
`illuminate_listen`): call `illuminate_map` with the user's question and `repo`, the absolute path of the project. Do
the requests it hands you and `illuminate_submit` them, as above. A long request comes in parts: read them all with
`illuminate_more` first. If a result says illuminate is still working, call `illuminate_next`. Give the user the map's
link, and if you have a built-in browser (the ChatGPT desktop app does), open the link there so the map sits beside the
chat. Then, whenever the user asks about the map in the chat (a box, an arrow, what they selected, a walkthrough step),
call `illuminate_ask` with their question and the page's current URL if your browser context shows it. illuminate adds
what they selected on the page; do the request it returns and submit it. The answer appears on the map, so say a
sentence or two in the chat. If they say "carry on with illuminate", call `illuminate_next`. Never wait for questions
from the page: Codex can't be woken that way.

**In Claude Code, when the plugin is installed but you have no `illuminate_map` tool**: illuminate's server didn't
start. It runs on Node (20.19 or later, started with `npx`), so check that before anything else:

1. Run `node --version` and `npx --version`.
2. If Node is missing or older than 20.19, say so in a sentence and offer to install or update it. Do it only if the
   person agrees. Use what their machine already has: the version manager they use (`nvm`, `fnm`, `volta`, `asdf`);
   otherwise Homebrew on a Mac (`brew install node`) or `winget install OpenJS.NodeJS.LTS` on Windows; otherwise install
   `fnm` or `nvm` into their home folder. Avoid anything that asks for an administrator password: you can't type one.
   Don't remove or replace a Node version their other tools depend on; add a newer one beside it and make it the default.
3. Check `node --version` again in a new shell. Then tell them to quit and reopen Claude Code (it only sees the new Node
   after a restart) and ask their question again.
4. If Node was already new enough, check Claude Code itself: run `claude --version`. illuminate needs 2.1.275 or later.
   If it is older, tell them to run `claude update` in a terminal, then quit and reopen Claude Code and ask again. Don't
   run the update yourself: it replaces the program this session is running in.
5. If both are new enough, the cause is something else. Don't install anything: tell them to run `/mcp`, which shows
   the illuminate server's error and can reconnect it.

**Outside Claude Code**, run the CLI from the repo root (or pass `--repo`). It needs `ANTHROPIC_API_KEY`:

```bash
illume "What happens when a patient converts?" --repo "$(git rev-parse --show-toplevel)"
```

It starts a small local server and opens the map in the user's browser by itself, where they watch Claude explore
(about a minute for a small repo). Don't pass `--no-open`. It also prints the link
(`http://127.0.0.1:4317/m/<id>?t=<token>`): tell the user the map is opening, and give them the link in case the tab
didn't appear. Run the command in the background and don't wait for it to exit. Don't stop it yourself either: it stops
on its own a little after the user closes the last illuminate tab (never while Claude is still working), or when they
press Stop illuminate on the page. If an illuminate server is already running, the new one picks another free port.

Other commands:

- `illume list` prints the maps already made in this repo (saved under `.illuminate/maps/`), one `<map-id>  <question>`
  per line. Use it to find a map's id, or to check whether a map for the question already exists.
- `illume open [<map-id>]` opens those maps in the user's browser (one map, or the list of all of them).
- `illume check <map-id>` re-checks a saved map against the current code and prints anything that no longer holds.
  It exits with 1 if a claim fails, so it can run in CI.

## Notes

- illuminate reads the code and never changes it, except for a fix the user approves in the map.
- It never reads secret files (`.env`, keys) and only listens on 127.0.0.1.
- In Claude Code and Codex it uses the session it runs in, so no key. The CLI needs `ANTHROPIC_API_KEY`.
- If `illume` isn't on the PATH, it hasn't been installed. Tell the user to install it from the illuminate repo
  (see its README) instead of guessing another command.
