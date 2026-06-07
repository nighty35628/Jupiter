# Jupiter Tool Mapping

Superpowers skills were originally written with Claude Code-style tool names.
In Jupiter, use these equivalents:

| Skill references | Jupiter equivalent |
|-----------------|--------------------|
| `Skill` tool | `run_skill` with the bare skill name, or `/skill-name` from the UI/CLI |
| `Task` tool | `spawn_subagent` for isolated child work |
| Multiple `Task` calls | Multiple `spawn_subagent` calls in one turn when tasks are independent |
| `TodoWrite` | `todo_write` |
| `Read` | `read_file` |
| `Write` | `write_file` |
| `Edit` | `edit_file` or `multi_edit` |
| `Bash` | `run_command`; use `run_background` for dev servers/watchers/long jobs |

Jupiter-specific rules:

- Prefer direct tools over `spawn_subagent` for small investigations. Spawn only for parallel fan-out or work that would otherwise require many reads/searches whose trail does not need to remain in parent context.
- Use `submit_plan` for approval-gated implementation plans and `ask_choice` for user decision forks.
- `edit_file` and `multi_edit` require `read_file` on the target path first in the same session.
- Skill files live under project `.jupiter/skills/` or global `~/.jupiter/skills/`; Jupiter also reads `.agents/skills/` and `.claude/skills/` for compatibility.
