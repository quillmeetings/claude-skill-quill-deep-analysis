# Quill Deep Analysis

A Claude Code skill that does **deep map/reduce research over your Quill meeting corpus** and writes a fact-first analytical report you can drill into.

Ask one long-span question — *"how did our enterprise pillars hold up over the last six weeks?"*, *"give me a balanced overview of Jerry's last year for a performance review"* — and it shards the timeline across parallel sub-agents, consolidates the evidence per dimension, and produces a report with a dated timeline, finding-stating sections, and linked sub-reports down to the underlying meeting quotes.

It is **not** for single-meeting recaps or single-fact lookups — query your meetings directly for those.

## How it works

```
MAP (by time window) → REDUCE (per dimension) → SYNTHESIZE (top-level report) → RECURSE (on generated questions)
```

- **Map** — one sub-agent per time window reads that window's transcripts and extracts cited evidence for every dimension at once.
- **Reduce** — one sub-agent per dimension consolidates across all windows and narrates how things evolved.
- **Synthesize** — one sub-agent writes the top-level report (`00-SUMMARY.md`) and generates follow-up questions.
- **Recurse** — the sharpest questions get a targeted second research pass.

The artifact mirrors the computation, so you can drill `00-SUMMARY → <dimension>/report → _raw/window-NN` and trace every claim to a meeting link. A bundled `report-viewer.html` renders the tree with reader-view typography, light/dark, and click-through navigation.

## Requirements

- **Claude Code** with the **Workflow** tool available.
- The **Quill MCP** connected (the skill uses `mcp__quill__search_meetings`, `get_transcript`, `get_meeting`, `search_minutes`). This skill is built for the Quill meeting corpus specifically.

## Install

```
/plugin marketplace add quillmeetings/quill-deep-analysis
/plugin install quill-deep-analysis@quill
```

(One repo, both roles: it ships its own `marketplace.json`.) Or install manually by copying `skills/map-reduce-research/` into `~/.claude/skills/` and `workflows/map-reduce-research.mjs` into your project's `.claude/workflows/`.

Validate locally before publishing:
```
claude plugin validate .
claude --plugin-dir .
```

## Permissions

The sub-agents write report files. Interactive runs are prompted normally, but background/headless sub-agents can't answer a prompt — so for a clean experience, allow Write/Edit scoped to your working tree:

```json
// .claude/settings.json
{ "permissions": { "allow": ["Write(<project-root>/**)", "Edit(<project-root>/**)"] } }
```

Plugins can't grant permissions, so add this yourself. Without it the skill still works — agents return their report text and the caller persists it — just with an extra step.

## Usage

Just ask a long-span, multi-meeting research question and the skill plans the decomposition. The only required input is the question.

Under the hood it runs `workflows/map-reduce-research.mjs` via the Workflow tool with:

| arg | meaning |
|---|---|
| `question` | the top-level question (string) |
| `dimensions` | `[{ key, name, definition, probes }]` — put a scoring rubric in a `definition` if you want one; the engine won't invent a scale |
| `windows` | `[{ start, end, label }]` — pre-sharded ISO date-times |
| `participantsHint` | names usually present (context, not a hard filter) |
| `outDir` | run folder, e.g. `research/<topic>-<date>` |
| `recursion` | `{ rounds: 1, topK: 4 }`, or `{ rounds: 0 }` to stop after synthesis |
| `models` *(optional)* | per-agent overrides; default `{ map: 'sonnet', reduce: 'opus', synthesize: 'opus', recurse: 'sonnet', finalize: 'sonnet' }` |

See `skills/map-reduce-research/SKILL.md` for the full methodology, Quill query mechanics, and the report-register rules.

## License

Apache-2.0. See `LICENSE`.
