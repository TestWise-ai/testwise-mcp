## TestWise release handoff

This project hands its releases to QA and the PM through TestWise (the `testwise` MCP server).

- If the TestWise tools are missing and only `connect` is listed, call `connect` and ask the user to finish signing in and choosing the project in the browser.
- At the start of every session, call `get_updates` and act on what it returns: new bugs, comments, test results and answered decisions.
- After you ship a batch of user-visible work, call `publish_release` once, with the release notes and builds, one check per user-visible behaviour, and a decision for each choice the PM should confirm.
  - Try: what the tester does or says. Expect: what they should see or hear. Where: the devices or surfaces to test on (iOS, Android, Web, Voice, …), never a generic "App". Set `release.platforms` to the ordered union of the platforms the checks use.
  - Seen: "yes" only if you saw it work on a real device; "partial" with a `seenNote` such as "Android: Yes. iOS: No"; otherwise "no". Tests and simulators are not Seen.
  - Give every check a stable `key` (for example `lists.offline-edits`) so a republish updates it. Add things that must never happen as `kind: "never"` checks in their own area.
  - For each decision, say what you built and the options. Never answer a decision yourself.
- When you fix a bug, call `request_retest` with the build that contains the fix.
- Attach screenshots, logs and recordings with `attach_file` (local server only).
