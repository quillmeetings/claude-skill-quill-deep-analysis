---
name: map-reduce-research
description: Produce a thorough, well-cited written report by researching across many past meetings/conversations over a long time span and consolidating them into one coherent, defensible answer, saved as a drill-down folder tree. Use when someone asks to research, write up, generate/produce a report, synthesize, or give an overview of something that spans weeks or months and many meetings, or that needs multiple facets/perspectives pulled together — e.g. "pull together a tight, defensible explanation of each of our pillars from our past conversations", "give me an overview of the last year of Jerry's work and growth/weaknesses for a balanced performance review", "summarize everything we've decided about pricing over the last quarter". Do NOT use for a single-meeting recap or a single-fact lookup ("what did we decide yesterday?", "when is the Acme call?") — query meetings directly for those. The only required input is the question; the skill plans the decomposition itself.
---

# Map/reduce research (Quill corpus)

A pattern for deep research over your own meetings. Distinct from the built-in web `deep-research` skill: the **source is the Quill transcript corpus**, the **map dimension is time**, and the **output is a folder tree** you can drill into.

## When to use this (the decision — encoded, not by keyword)

Reach for this when the answer must be **assembled from many conversations across a long span**, or must weigh **multiple facets/perspectives** into one defensible write-up. Don't key off mechanism words like "map/reduce" — key off what the person actually wants: a *researched report* vs. a *quick lookup*.

USE IT when the ask sounds like:
- "research / write up / generate a report on / synthesize / give me an overview of …"
- "… the last [quarter/year] of X", "how our thinking on X evolved", "a balanced picture of X"

The only input is the **question**; the skill decides the decomposition (what the dimensions are, how to shard time). Same skill, different asks:
- "A tight, defensible explanation of each of our three pillars from our historical conversations." → dimensions = the pillars.
- "An overview of the last year of Jerry's work, growth, and weaknesses for a performance review." → dimensions = e.g. delivery / collaboration / growth areas / gaps; time range = a year; here a participant hard-filter on the person is appropriate.

DON'T use it for a **single meeting** or a **single fact** — "what did we decide in yesterday's standup?", "when is the Acme call?". That's a direct `search_meetings` / `get_transcript` lookup, not a report.

## The shape

```
MAP (by time window)  →  REDUCE (by dimension)  →  SYNTHESIZE (top level)  →  RECURSE (on generated questions)
```

- **Map** — split the time range into windows (default **2 weeks**; use 1 week for dense periods, 1 month for sparse). One agent per window. Each reads that window's transcripts and extracts evidence for **every** dimension at once (so each transcript is read once, not once-per-dimension). Agents run in parallel and each stays focused on a small slice.
- **Reduce** — one agent per dimension. Reads all windows' evidence files for its dimension and consolidates. Because windows are time-ordered, the reduce agent can narrate **how the thinking evolved**.
- **Synthesize** — one agent reads the dimension reports, writes the top-level `00-SUMMARY.md`, and **generates the next round of questions**.
- **Recurse** — the top-K generated questions become targeted research agents; their answers fold back into the summary. Loop if the questions are still opening up.

## Output tree (the artifact mirrors the computation)

```
<outDir>/                         e.g. research/pillars/2026-06-02/
  00-SUMMARY.md                   top-level answer + links down the tree (read first)
  _next-questions.md              generated questions w/ open|answered status
  <dimension>/report.md           one per dimension (the reduce output)
  _raw/window-NN-<range>.md       per-window evidence (the map leaves; cited, linked)
  questions/<slug>.md             round-2 deep dives
```

Drill path: `00-SUMMARY` → `<dimension>/report` → `_raw/window-NN`. Every claim traces to a meeting link.

## Quill mechanics (the part that's easy to get wrong)

Agents load tools first: `ToolSearch("select:mcp__quill__search_meetings,mcp__quill__get_transcript,mcp__quill__get_meeting,mcp__quill__search_minutes")`.

- **Shard by time.** Each map agent gets a hard window via `search_meetings({ filter: { after, before }, ... })`. This is what makes them parallel + focused. **Pre-compute the windows and pass them in** — workflow scripts can't do `Date` math.
- **Transcripts over minutes.** Minutes are lossy summaries; the research lives in what was actually *said*. Use `ranking.scope: 'deep-content'` to weight transcripts, then `get_transcript` on the most relevant meetings (paginate with `start_minutes`/`duration_minutes` for very long ones). Only fall back to `get_minutes`/`search_minutes` to locate candidates.
- **Freshness off inside a window.** Set `ranking.freshness: 'off'` — you've already constrained time with the filter; you don't want recency decay reordering within the slice.
- **Participants are a soft signal, usually.** `filter.participants_any` is a HARD cutoff (drops everything without those people). If a person was in *most but not all* relevant meetings, do NOT hard-filter on them — search by topic within the window and note who spoke. Only hard-filter when you truly want only their meetings.
- **`limit` ≤ 30 per call.** Page with `offset` if a window is dense.
- **Always preserve the FULL UUID.** Quill meeting ids and note ids are UUIDs (e.g. `1737e957-8a05-410f-9b77-23c46338ba7a`); a `quill://meeting/<uuid>` (or note) deep link only resolves if the entire id is intact. Never truncate, abbreviate, or shorten an id when capturing it or carrying it forward — propagate the complete UUID through map → reduce → synthesize. A partial id is worthless.
- **If `query` search returns empty, fall back to listing.** Observed in practice: hybrid `query` search can come back empty for a window even when relevant meetings exist. Don't conclude "nothing happened" — re-run `search_meetings` with **only** `filter:{after,before}` (no `query`) to list the window's meetings, then open the promising ones by title/participants and read transcripts directly. Map agents must do this fallback before reporting a window as empty.

## Model strategy (cost)

The map and recurse agents read full transcripts — high token volume, but the task is *extraction*, which a cheaper model does well. The reduce and synthesize agents do the cross-cutting *judgment* (weighing evidence, narrating how the view evolved, writing the report), which is worth the more expensive model. Defaults:

| Agent | Task | Model |
|---|---|---|
| Map | read transcripts, extract per-dimension evidence | `sonnet` |
| Recurse | targeted follow-up research (also reads transcripts) | `sonnet` |
| Reduce | consolidate one dimension across all windows | `opus` |
| Synthesize | top-level report + generate questions | `opus` |
| Finalize | mechanical stitching of links/dashboard | `sonnet` |

Override per run with `args.models`, e.g. `models: { map: 'haiku' }` for a cheap dry run, or `{ reduce: 'sonnet' }` to economize further. The transcript-reading agents dominate token spend, so keeping them off the most expensive model is the main lever.

## Prompt discipline (baked into the engine prompts)

The engine's agent prompts already encode this; it's restated here for anyone extending them. Give each agent the **question**, not your conclusion; name the tools; demand **direct quotes with meeting IDs + URLs + speaker**; ask for ONE thing that would surprise you; frame adversarially (look for evidence the claim is *weak*); grant **permission to report "few/no relevant meetings in this window."** Map agents capture decisions, disagreements (who disagreed with whom), and open questions — not just supporting quotes.

## How to run it

The engine ships with this plugin at `workflows/map-reduce-research.mjs`. **Always run the map/reduce through this engine via the Workflow tool — never perform the map/reduce yourself in the main thread.** Running the engine is what applies the model tiering (Opus on the reduce + synthesize steps — the biggest quality lever); doing it inline silently runs everything on the session model.

Steps:
1. **Locate the engine.** Use `${CLAUDE_PLUGIN_ROOT}/workflows/map-reduce-research.mjs`. If that variable isn't resolved in your context, find the installed copy (e.g. `ls ~/.claude/plugins/**/workflows/map-reduce-research.mjs`) or copy that file into the project's `.claude/workflows/`. Pass the resolved absolute path below.
2. Pre-compute windows + paths, `mkdir -p` the output tree, and copy this skill's `assets/report-viewer.html` into `outDir`.
3. Run the engine:

```
Workflow({ scriptPath: "<absolute path to map-reduce-research.mjs>", args: {
  question, dimensions, windows, participantsHint, outDir,
  recursion: { rounds, topK },
  models: { map: "sonnet", reduce: "opus", synthesize: "opus", recurse: "sonnet", finalize: "sonnet" }
}})
```

Synthesis and reduce run on **Opus** — that is deliberate and the main quality lever. Pass the `models` block as shown and do not downgrade them. If you cannot run the engine, stop and say so rather than doing the map/reduce on the session model.

`args` shape:
- `question` — the top-level question (string).
- `dimensions` — `[{ key, name, definition, probes:[...] }]`. Put any scoring rubric in a dimension's `definition` (e.g. "rate 1–5 as a buying pillar") — the engine is rubric-agnostic and won't invent a scale otherwise.
- `windows` — `[{ start, end, label }]` ISO date-times, pre-sharded.
- `participantsHint` — names usually present (e.g. `["Jordan"]`); given as context, not a hard filter.
- `outDir` — the run folder. **Default: use `./research/<topic>-<date>/`, creating `./research/` in the project if it doesn't exist yet** — unless the user has specified another location, in which case use that.
- `recursion` — `{ rounds: 1, topK: 4 }` to do one follow-up round on the top 4 generated questions; `{ rounds: 0 }` to stop after synthesis.
- `models` *(optional)* — per-agent model overrides; defaults to `{ map: 'sonnet', reduce: 'opus', synthesize: 'opus', recurse: 'sonnet', finalize: 'sonnet' }`. See **Model strategy** above.

After it returns:

1. **Open the report for the user automatically — do not wait to be asked.** Serve the run folder and open the top-level report in their browser:
   ```
   ( python3 -m http.server <port> --directory <outDir> >/tmp/qda-report.log 2>&1 & )
   open "http://localhost:<port>/report-viewer.html?doc=00-SUMMARY.md"   # macOS; use xdg-open on Linux
   ```
   Pick an unused port, and always also print the URL in case the browser didn't pop.
2. Read `00-SUMMARY.md` yourself and give the user the headline. The generated follow-up questions live in `_next-questions.md`.

## Reading the report (HTML viewer)

Agents only ever write **markdown** — that stays diffable, Obsidian-native, and cheap. The *presentation* layer is one self-contained file, `assets/report-viewer.html`, copied into each run folder. It renders any `.md` with reader-view typography, a light/dark/auto toggle, inline SVG, and — crucially — it rewrites relative `.md` links so you can click from `00-SUMMARY` down through the pillar reports and `_raw/` windows inside the styled reader.

Open it by serving the run folder (relative links + `fetch` need http):
```
cd <outDir> && python3 -m http.server 8000
# then open http://localhost:8000/report-viewer.html?doc=00-SUMMARY.md
```
No server handy? Open `report-viewer.html` directly and drag a `.md` onto it (single-file mode; cross-doc links won't resolve). To share externally, serve the run folder over any static host.

**Marp (slides) — deferred, not built.** Turning a report into a slide deck is a separate pipeline (`marp-cli` over a slides-formatted markdown). If wanted later, add a `--slides` variant of the synthesize prompt that emits Marp-fenced markdown and render with marp-cli; keep it out of the default article path.

## Setup: permissions (install / packaging)

The agents WRITE files — each map / reduce / synthesis agent saves its report into the run folder. Run interactively via the Workflow tool, those writes are prompted normally. But **background or headless subagents can't answer a permission prompt**, so a restrictive profile blocks their writes (they fall back to returning text). For a clean install — headless/automated runs, or sharing with teammates — grant Write/Edit in project settings, scoped to the working tree:

```json
// .claude/settings.json
{ "permissions": { "allow": ["Write(<project-root>/**)", "Edit(<project-root>/**)"] } }
```

Skill frontmatter **can't grant** settings permissions (it only restricts what a skill may call), so ship this snippet with the package or include it in the install steps. Without it the engine still works — agents return their full report text and the caller persists it — just with an extra step.

## Extending
- More dimensions = more reduce agents (one each); map agents just extract more buckets.
- Other corpora (Notion, Drive, web) = swap the tools named in the map prompt; the map/reduce/synthesize/recurse shape is unchanged.
- Deeper recursion = raise `recursion.rounds`; each round re-runs targeted research on the still-open questions.
