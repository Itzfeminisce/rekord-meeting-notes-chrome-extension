# CLAUDE.md

The project brief is in `docs/BRIEF.md`. Read only the section you need.

## Working rules (always take priority)
- Match each subagent and its effort to the complexity of the task it is given.
- Never resume an agent or subagent after its first piece of work. Every new task, implementation or review runs in a fresh subagent.
- No agent or subagent reads a large document from top to bottom.
- Agents read only the specific lines they need, and respond in 30 lines or fewer.
- Never print, log or commit an API key or token.
