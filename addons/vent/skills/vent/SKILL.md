---
name: vent
description: Record major friction or postmortem feedback in the configured workspace vent log.
distribution: public
---

Use the `vent` tool only when something materially slowed down or degraded the work:

- repeated tool failures
- broken or misleading documentation
- confusing instructions
- flaky commands
- avoidable friction worth remembering

Guidelines:
- use it sparingly
- prefer one batched vent near the end of the turn
- be specific about what happened and what would improve it next time
- do not use it as a substitute for finishing the user's task

The tool writes to the output file configured in **Settings → Vent**.
