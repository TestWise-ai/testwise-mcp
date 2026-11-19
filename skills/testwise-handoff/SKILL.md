---
name: testwise-handoff
description: Hand a release to QA and the PM through TestWise, then pick up their results, bugs and answers. Use at the start of a session on a project connected to TestWise, after shipping a batch of user-visible work, after fixing a bug QA filed, and when you have a screenshot, log or recording to attach.
---

# TestWise release handoff

TestWise is where QA and the PM test what you built. You publish a **release**: notes, builds, **checks** for QA and
**decisions** for the PM. QA opens it on a phone, picks the platform, device and build they are testing on, and marks
each check Passed, Failed, Blocked or Skipped. A failure files a bug linked to the check. The PM answers each decision:
keep it as built, or change it. You read all of that back with `get_updates`, fix, and ask for a retest.

The tools come from the `testwise` MCP server. Each tool's own schema is the reference for field names; this skill
explains how to use them well.

If the only TestWise tools listed are `connect` and `attach_file`, the server is not signed in yet. Call `connect`: it
opens the browser, where the user signs in and chooses the project. If it returns a link instead (no browser opened,
or the user has not finished), show the link to the user and call `connect` again once they are done. The other tools
then appear, and `connect` returns the server's own instructions; follow them.

## 1. At the start of every session: `get_updates`

Call `get_updates` before other work. It returns what happened since you last looked, and moves your cursor forward
(pass `peek: true` to look without moving it). Act on each event:

| Event | What to do |
|---|---|
| `item.created` (a bug) | Read it with `get_item` (comments, attachments, the check result it came from). Reproduce, fix, then `request_retest`. |
| `comment.created` | If it asks you something, answer with `add_comment` on that item. |
| `result.recorded` | A FAILED result normally comes with a bug; work on the bug. BLOCKED usually means the tester lacked something (a build, an account): say how to unblock in a comment. |
| `decision.answered` | KEEP: nothing to do. CHANGE: build what the PM asked for, then republish the affected checks. |

If `more` is true, call `get_updates` again.

## 2. After shipping a batch: `publish_release`

Call it once per batch, with everything QA and the PM need. Publishing the same release again updates it: checks and
decisions are matched by `key`, so keep keys stable.

### Release notes: "Before you start"

Put what a tester needs before the first check in `release.notes` (Markdown):

- which build to install on each platform, and why an older one must not be used;
- which test accounts to use, and anything that has real effects (emails really sent, events really created);
- how to clean up after a run;
- what never to do (for example: never enter card details);
- what to capture when something fails: device, build, time, the exact words used, and a screenshot;
- that rows not yet seen by engineering are the ones most worth testing first.

Put each platform's build in `release.builds` too.

### Checks

One check per user-visible behaviour, grouped by `area` (a heading such as "Lists and sync"), in the order a tester
should go through them.

- **Try**: what the tester does or says, concretely. Quote exact words for anything typed or spoken: *Say "Add oat milk
  and two lemons to the shopping list."* Include the setup if it matters ("After 6 pm…", "On a second phone…").
- **Expect**: the observable outcome, what the tester can see or hear, with numbers where they help ("within 10
  seconds"). Not internals: never "the sync job runs".
- **Where** (`platforms`): these become the columns QA records results in, so each value must be something a tester
  picks as "I'm testing on: X": devices or surfaces such as `iOS`, `Android`, `Web`, `Voice`, `Watch`. Never use a
  generic "App"; expand it to the real platforms (`"App"` → `["iOS", "Android"]`). Set `release.platforms` to the
  ordered union of the platforms your checks use.
- **Seen**: engineering's own evidence. `"yes"` only if you saw it work on a real device or surface. `"partial"` with a
  `seenNote` when only part was seen ("Android: Yes. iOS: No", "Found: Yes. Sent: No"). Otherwise `"no"`, with a
  `seenNote` if there is something to say ("Simulator only", "Unit tests only"). Passing tests, simulators and reading
  the code are not Seen. Never mark a check Seen without evidence; QA tests the "no" rows first.
- **key**: a stable slug, `area.behaviour`, such as `reminders.arrive-at-store`. Reuse it whenever you republish.
- **Never rules**: behaviour that must never happen goes in as checks with `kind: "never"`, in their own area (for
  example "Should never happen"). The rule goes in Try; Expect may be empty. QA reports a violation from that row.

### Decisions for the PM

Whenever you built something one way and the PM might want it another way, add a decision instead of asking in chat:

- `question`: one question, answerable without reading code.
- `built`: what you built, so "keep as built" has a clear meaning.
- `options`: the realistic alternatives, as-built first.
- `assignee`: the PM's email, if you know it.

Never answer a decision yourself. Answers come from people in TestWise and reach you through `get_updates`.

## 3. After a fix: `request_retest`

When a bug is fixed in a build QA can install, call `request_retest` with the item key and **the build that contains
the fix** (for example `"iOS 213"`), plus a short note on what changed. That moves the item to review and asks QA to
check it again. Don't request a retest for a fix that isn't in an installable build yet.

## 4. Evidence: `attach_file`

With the local server (`npx -y testwise-mcp`), `attach_file` uploads a file from this machine to an item: a screenshot
or screen recording from a real device, a log, a crash report. Pass an absolute path; files up to 25 MB. Attach
evidence to the bug it explains (for example the log that shows the fix working). Never attach credentials, `.env`
files or keys.

## Other tools

- `get_release` (`"latest"` or a name) shows every check with its latest result per platform and whether a retest is
  due; `list_releases` gives the summary of each.
- `search_items`, `get_item`, `create_item`, `update_item` and `add_comment` work on bugs and tasks.
- `record_result` records a result you produced yourself on a real device or emulator, with its device and build. QA's
  results are the ones that count; never record a result you did not see.

## Example (a fictional app)

Larder is a shared shopping-list app with iOS and Android apps, a web app and a voice skill. After a batch of work, its
coding agent publishes:

```json
{
  "release": {
    "name": "Larder 2.4",
    "notes": "## Before you start\n- iOS: build 212 from the beta channel (211 is missing the microphone permission text). Android: 2.4.0 (340) from the internal track. Web: staging.\n- Use the test households. Sharing really emails invites, so invite test addresses only.\n- After each run, delete the lists you made and leave the test household.\n- Never enter card details: Larder must stop before any checkout.\n- When something fails, note the device, build and time, the exact words you typed or said, and take a screenshot.\n- Rows engineering has not seen on a real device are marked Seen: No. Start with those.",
    "builds": [
      { "platform": "iOS", "build": "212", "note": "beta channel" },
      { "platform": "Android", "build": "2.4.0 (340)", "note": "internal track" },
      { "platform": "Web", "build": "staging" }
    ],
    "platforms": ["iOS", "Android", "Web", "Voice"]
  },
  "checks": [
    {
      "key": "households.join-by-link",
      "area": "Households",
      "try": "Open an invite link on a phone that doesn't have Larder installed.",
      "expect": "The store page opens. After installing and signing in, you land in the household that invited you, without opening the link again.",
      "platforms": ["iOS", "Android"],
      "seen": "partial",
      "seenNote": "Android: Yes. iOS: No"
    },
    {
      "key": "lists.offline-edits",
      "area": "Lists and sync",
      "try": "Turn on airplane mode, tick off three items, then turn airplane mode off.",
      "expect": "The ticks stay, and the other members of the household see them within 10 seconds.",
      "platforms": ["iOS", "Android"],
      "seen": "no",
      "seenNote": "Simulator only"
    },
    {
      "key": "lists.voice-add",
      "area": "Lists and sync",
      "try": "Say \"Add oat milk and two lemons to the shopping list.\"",
      "expect": "Two items appear on the list, \"Oat milk\" and \"Lemons (2)\", and the speaker repeats both back.",
      "platforms": ["Voice"],
      "seen": "yes"
    },
    {
      "key": "lists.share-web",
      "area": "Lists and sync",
      "try": "On the web, share a list with a test address.",
      "expect": "The invite arrives by email within a minute, and the list shows the person as invited.",
      "platforms": ["Web"],
      "seen": "yes"
    },
    {
      "key": "reminders.arrive-at-store",
      "area": "Reminders",
      "try": "Add the reminder \"when I get to the grocery store\" to a list, then walk into a grocery store.",
      "expect": "Within a minute of arriving, a notification names the list and the store. Tapping it opens the list.",
      "platforms": ["iOS", "Android"],
      "seen": "no"
    },
    {
      "key": "never.lost-items",
      "kind": "never",
      "area": "Should never happen",
      "try": "An item disappears from a shared list without anyone removing it.",
      "expect": "",
      "platforms": ["iOS", "Android", "Web", "Voice"]
    },
    {
      "key": "never.checkout",
      "kind": "never",
      "area": "Should never happen",
      "try": "Larder places an order or shows a payment form without the user tapping Order.",
      "expect": "",
      "platforms": ["iOS", "Android", "Web", "Voice"]
    }
  ],
  "decisions": [
    {
      "key": "sharing.link-permissions",
      "question": "Who should be able to edit a list through an invite link?",
      "built": "Anyone with the link can edit. Links expire after 7 days.",
      "options": ["Anyone with the link (as built)", "Only people invited by email", "The link gives view-only access"],
      "assignee": "pm@larder.example"
    },
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

What makes it work:

- Where lists real surfaces. The web-only and voice-only behaviours have their own checks, so no row says "App".
- `release.platforms` is the ordered union of every check's platforms: iOS, Android, Web, Voice.
- Seen is honest: "partial" with a note where only Android was seen, "no" with "Simulator only" where nothing was
  seen on a device.
- The never rules have their own area and cover every platform.
- Each decision states what was built, so the PM can keep it or change it in one step.

Next session, `get_updates` shows QA failed `lists.offline-edits` on Android build 340 and filed LAR-41, and the PM
chose "Only people invited by email". The agent fixes LAR-41, attaches the log from its own device run with
`attach_file`, calls `request_retest` with `{"key": "LAR-41", "build": "Android 2.4.1 (341)"}`, builds the sharing
change, and republishes Larder 2.4 with the same keys and an updated `lists.share-web` check.
