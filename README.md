# testwise-mcp

Hand a release from your coding agent to QA and the PM in [TestWise](https://testwise.ai), then read back their
results, bugs and answers. Works with any MCP client or coding agent.

## How the handoff works

1. After a batch of work, the agent publishes a **release**: notes, builds, **checks** for QA and **decisions** for the PM.
2. QA opens the release on a phone, picks the platform, device and build they are testing on, and marks each check
   Passed, Failed, Blocked or Skipped. A failure files a bug, prefilled from the check.
3. The PM answers each decision: keep it as built, or change it.
4. At the start of its next session the agent calls `get_updates`, fixes what QA found, and asks for a retest on the
   build that contains the fix.

## Connect

There are two ways in. Both sign in through the browser, where you choose the TestWise project; there is no token to
copy.

### The remote server

Point your MCP client at:

- **URL:** `https://app.testwise.ai/mcp` (Streamable HTTP)
- **Sign-in:** OAuth. The client opens the browser the first time it connects.

```json
{
  "mcpServers": {
    "testwise": {
      "type": "http",
      "url": "https://app.testwise.ai/mcp"
    }
  }
}
```

Clients spell the HTTP transport type differently (`"http"`, `"streamable-http"`, or no type next to a `url`); use
your client's spelling.

### The local server (this package)

Runs on your machine over stdio, proxies the remote server, and adds `attach_file`, which uploads screenshots, logs
and recordings from your disk. Node.js 20 or later.

```
npx -y testwise-mcp
```

```json
{
  "mcpServers": {
    "testwise": {
      "command": "npx",
      "args": ["-y", "testwise-mcp"]
    }
  }
}
```

The first time, the agent sees two tools, `connect` and `attach_file`. Calling `connect` opens the browser; once you
have signed in and chosen the project, the TestWise tools appear. You can also sign in from a terminal beforehand:

```
npx -y testwise-mcp login     # sign in and choose a project
npx -y testwise-mcp status    # which server and project this machine is signed in to
npx -y testwise-mcp logout    # revoke the sign-in and delete it from this machine
```

To switch to another project, run `logout`, then `login` (or call `connect`) and choose it.

| Setting | Meaning |
|---|---|
| `TESTWISE_URL` | TestWise address. Default `https://app.testwise.ai`. Must be `https://` (plain `http://` only for localhost). |
| `~/.testwise/credentials.json` | Where the sign-in is kept, per TestWise address. Readable by you only (0600); renewed automatically. |
| `BROWSER` | Optional: the program that opens the sign-in page. Without it, the system's default browser is used. The page's link is always printed too. |

### What signing in grants

A sign-in reaches one project, and acts as you with contributor rights at most: the agent can publish releases, file
and update items, comment, record results and attach files, but it cannot delete things, change settings or answer
the PM's decisions. Its activity is labelled with the connection's name, and you can disconnect it at any time under
Coding agents on the Releases page in TestWise (the Agents button on a phone), or with `testwise-mcp logout`.

## Tools

The local server lists whatever tools the remote server offers, so new ones appear without updating this package.

| Tool | What it does |
|---|---|
| `get_updates` | New bugs, comments, results and answered decisions since the agent last looked. Call it at the start of every session. |
| `publish_release` | Creates or updates a release with its notes, builds, checks and decisions, in one call. |
| `list_releases`, `get_release` | Releases with their progress; one release with every check's latest result per platform. |
| `search_items`, `get_item`, `create_item`, `update_item`, `add_comment` | Bugs and tasks. |
| `record_result` | Records a result the agent produced itself on a real device or emulator. |
| `request_retest` | Moves a fixed bug to review and asks QA to re-test it on the build that contains the fix. |
| `create_attachment_upload`, `complete_attachment_upload` | The two halves of an upload; `attach_file` uses them for you. |
| `list_members` | The project's members with their name, email and role: the emails to use as assignees. |
| `whoami` | The project, user and connection the agent acts for. |
| `connect` (local) | Signs in through the browser. Listed only while the local server is signed out. |
| `attach_file` (local) | Uploads a local file, up to 25 MB, to an item: `{ "key": "LAR-41", "path": "/abs/path/to/screenshot.png" }`. |

## Writing a good handoff

- **One check per user-visible behaviour**, grouped by area, in the order a tester should go through them.
- **Try** is what the tester does or says, concretely, with exact words in quotes for anything typed or spoken.
- **Expect** is the observable outcome: what the tester can see or hear, with numbers where they help.
- **Where** (`where`) becomes the columns QA records results in, so each value must be something a tester picks
  as "I'm testing on: X": a device or surface such as `iOS`, `Android`, `Web`, `Voice` or `Watch`. Never a generic
  "App": expand it to the real platforms (`"App"` → `["iOS", "Android"]`). Set `release.platforms` to the ordered union
  of the platforms the checks use.
- **Seen** is engineering's own evidence: `"YES"` only when someone saw it work on a real device; `"PARTIAL"` with a
  `seenNote` such as `"Android: Yes. iOS: No"`; otherwise `"NO"`. Tests and simulators are not Seen.
- **key**: give every check a stable key such as `lists.offline-edits`, so publishing again updates the row instead of
  adding a new one.
- **Never rules**: behaviour that must never happen goes in as checks with `kind: "NEVER"`, in their own area.
- **Decisions**: one question each, with what was built (`built`) and the options. Only people answer them.
- **Release notes** say what a tester needs before starting: builds, test accounts, cleanup, what never to do, and
  what to capture when something fails.

A short example, for a fictional shopping-list app:

```json
{
  "release": {
    "name": "Larder 2.4",
    "notes": "## Before you start\n- iOS build 212, Android 2.4.0 (340).\n- Use the test households; sharing really emails invites.\n- When something fails, note the device, build and time, the exact words used, and take a screenshot.",
    "builds": [
      { "platform": "iOS", "build": "212" },
      { "platform": "Android", "build": "2.4.0 (340)" }
    ],
    "platforms": ["iOS", "Android", "Voice"]
  },
  "checks": [
    {
      "key": "lists.offline-edits",
      "area": "Lists and sync",
      "try": "Turn on airplane mode, tick off three items, then turn airplane mode off.",
      "expect": "The ticks stay, and the other members of the household see them within 10 seconds.",
      "where": ["iOS", "Android"],
      "seen": "PARTIAL",
      "seenNote": "Android: Yes. iOS: No"
    },
    {
      "key": "lists.voice-add",
      "area": "Lists and sync",
      "try": "Say \"Add oat milk and two lemons to the shopping list.\"",
      "expect": "Two items appear on the list, and the speaker repeats both back.",
      "where": ["Voice"],
      "seen": "NO"
    },
    {
      "key": "never.lost-items",
      "kind": "NEVER",
      "area": "Should never happen",
      "try": "An item disappears from a shared list without anyone removing it.",
      "expect": "",
      "where": ["iOS", "Android", "Voice"]
    }
  ],
  "decisions": [
    {
      "key": "sync.offline-conflicts",
      "question": "When two people change the same item while offline, which change should win?",
      "built": "The last phone to reconnect wins; the other change is dropped without a notice.",
      "options": ["Last to reconnect wins (as built)", "Keep both and ask the user"],
      "assignee": "pm@larder.example"
    }
  ]
}
```

The `publish_release` tool's own schema is the reference for field names.

## Instructions for your agent

Add this to your project's `AGENTS.md` (or whichever instructions file your agent reads):

```markdown
## TestWise release handoff

This project hands its releases to QA and the PM through TestWise (the `testwise` MCP server).

- If the TestWise tools are missing and only `connect` is listed, call `connect` and ask the user to finish signing in and choosing the project in the browser.
- At the start of every session, call `get_updates` and act on what it returns: new bugs, comments, test results and answered decisions.
- After you ship a batch of user-visible work, call `publish_release` once, with the release notes and builds, one check per user-visible behaviour, and a decision for each choice the PM should confirm.
  - Try: what the tester does or says. Expect: what they should see or hear. Where (`where`): the devices or surfaces to test on (iOS, Android, Web, Voice, …), never a generic "App". Set `release.platforms` to the ordered union of the platforms the checks use.
  - Seen: "YES" only if you saw it work on a real device; "PARTIAL" with a `seenNote` such as "Android: Yes. iOS: No"; otherwise "NO". Tests and simulators are not Seen.
  - Give every check a stable `key` (for example `lists.offline-edits`) so a republish updates it. Add things that must never happen as `kind: "NEVER"` checks in their own area.
  - For each decision, say what you built and the options. Never answer a decision yourself.
- When you fix a bug, call `request_retest` with the build that contains the fix.
- Attach screenshots, logs and recordings with `attach_file` (local server only).
```

The same block is in [`snippets/agents-md.md`](snippets/agents-md.md).

## Agent skill

[`skills/testwise-handoff/SKILL.md`](skills/testwise-handoff/SKILL.md) is an agent skill in the open SKILL.md format:
when and how to publish, how to write good checks, how to act on updates, and a complete example. Copy the
`testwise-handoff` folder into the folder your agent loads skills from.

## Security

- Sign-in is OAuth 2.1 with PKCE (S256) and a loopback redirect on `127.0.0.1`, as the public client `testwise-mcp`.
  The tokens are bound to `<TESTWISE_URL>/mcp` and are only ever sent there.
- Tokens are never logged, and are redacted from error messages. `logout` revokes them at TestWise before deleting them.
- `attach_file` reads only the path it is given. It refuses directories, empty files, files over 25 MB and URLs of any
  kind, never sends your TestWise credentials to the storage service, and never logs the upload link.

## Development

```
npm ci
npm test
```

The tests run the real binary over stdio against a local fake of TestWise (its sign-in, MCP endpoint and storage).

## License

[MIT](LICENSE)
