# CLAUDE.md

Plans, specs, handoffs and design frames for Rekord live in the specs repo: https://github.com/Itzfeminisce/productivity-apps-engineering-specs/tree/main/apps/rekord
Read its [RULES.md](https://github.com/Itzfeminisce/productivity-apps-engineering-specs/blob/main/RULES.md) first. It binds every implementer and takes priority over everything else.
Then read only the section you need of `apps/rekord/BRIEF.md` and your version's `HANDOFF.md` there.

## Working rules (always take priority)
- Match each subagent and its effort to the complexity of the task it is given.
- Never resume an agent or subagent after its first piece of work. Every new task, implementation or review runs in a fresh subagent.
- No agent or subagent reads a large document from top to bottom.
- Agents read only the specific lines they need, and respond in 30 lines or fewer.
- Never print, log or commit an API key or token.
