export const meta = {
  name: 'map-reduce-research',
  description: 'Map/reduce research over the Quill corpus: shard by time window, extract per-dimension evidence from transcripts, reduce per dimension, synthesize a top-level answer, recurse on generated questions. Writes a drill-down folder tree.',
  phases: [
    { title: 'Map', detail: 'one agent per time window extracts per-dimension evidence from transcripts', model: 'sonnet' },
    { title: 'Reduce', detail: 'one agent per dimension consolidates across all windows', model: 'opus' },
    { title: 'Synthesize', detail: 'top-level summary + generate next-round questions', model: 'opus' },
    { title: 'Recurse', detail: 'targeted research on the top generated questions', model: 'sonnet' },
    { title: 'Finalize', detail: 'fold round-2 answers into the summary + write question dashboard', model: 'sonnet' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { question, dimensions, windows, participantsHint = [], outDir, recursion = { rounds: 1, topK: 4 } } = A

// Model strategy: token-heavy transcript reading on the cheaper model; cross-cutting
// judgment (consolidation/synthesis) on the more expensive one. Override any via args.models.
const M = Object.assign(
  { map: 'sonnet', reduce: 'opus', synthesize: 'opus', recurse: 'sonnet', finalize: 'sonnet' },
  A.models || {},
)

const QUILL_TOOLS = 'ToolSearch("select:mcp__quill__search_meetings,mcp__quill__get_transcript,mcp__quill__get_meeting,mcp__quill__search_minutes,mcp__quill__get_minutes")'
const peopleNote = participantsHint.length
  ? `These discussions usually involve ${participantsHint.join(', ')}. Treat that as context for who is speaking — do NOT hard-filter on participants (you would drop relevant meetings); search by topic within the window and note who said what.`
  : `Note who is speaking on each captured quote.`

const dimList = dimensions.map(d => `- **${d.name}** (key: \`${d.key}\`): ${d.definition}\n  Probe for: ${(d.probes || []).join(' · ')}`).join('\n')
const rawPath = (i, w) => `${outDir}/_raw/window-${String(i + 1).padStart(2, '0')}-${w.label}.md`
const dimReportPath = d => `${outDir}/${d.key}/report.md`
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

// ---------- schemas ----------
const MAP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['window', 'meetingsReviewed', 'evidenceByDimension', 'reportPath'],
  properties: {
    window: { type: 'string' },
    meetingsReviewed: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title'], properties: { id: { type: 'string' }, title: { type: 'string' }, date: { type: 'string' }, url: { type: 'string' } } } },
    evidenceByDimension: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['dimension', 'count', 'highlights'], properties: { dimension: { type: 'string' }, count: { type: 'integer' }, highlights: { type: 'array', items: { type: 'string' } } } } },
    notableDecisionsOrDisagreements: { type: 'array', items: { type: 'string' } },
    reportPath: { type: 'string' },
  },
}
const REDUCE_SCHEMA = {
  // Digest ONLY. The full analysis must live in the report file, not in this return value —
  // that is what forces the agent to actually write the file (the bug was a fat schema).
  type: 'object', additionalProperties: false,
  required: ['dimension', 'oneLineSummary', 'confidence', 'reportPath'],
  properties: {
    dimension: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    oneLineSummary: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    reportPath: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['executiveSummary', 'crossCutting', 'nextQuestions', 'summaryPath'],
  properties: {
    executiveSummary: { type: 'string' },
    crossCutting: { type: 'array', items: { type: 'string' } },
    nextQuestions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'why', 'dimension'], properties: { q: { type: 'string' }, why: { type: 'string' }, dimension: { type: 'string' } } } },
    summaryPath: { type: 'string' },
  },
}
const QR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['question', 'answer', 'confidence', 'path'],
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    confidence: { type: 'string', enum: ['inconclusive', 'low', 'medium', 'high'] },
    evidence: { type: 'array', items: { type: 'string' } },
    path: { type: 'string' },
  },
}

// ---------- prompts ----------
function mapPrompt(w, i) {
  return `You are one MAP agent in a map/reduce research run. Top-level question:
"${question}"

YOUR SLICE: meetings between ${w.start} and ${w.end} (window "${w.label}"). Stay strictly in this window — other agents cover other windows.

These are INTERNAL strategy discussions, not (necessarily) customer calls. ${peopleNote}

LOAD TOOLS FIRST: ${QUILL_TOOLS}

DIMENSIONS to extract evidence for (extract ALL of them in one pass over the window — do not read a transcript more than once):
${dimList}

METHOD:
1. For each dimension, run search_meetings with that dimension's terms AND filter:{after:"${w.start}", before:"${w.end}"} AND ranking:{scope:"deep-content", freshness:"off"}, limit 30. Also do one broad topical search for the overall question in the window so you don't miss cross-cutting meetings. Dedupe meetings.
   IMPORTANT FALLBACK: if a query search returns EMPTY, do NOT conclude the window is empty — re-run search_meetings with ONLY filter:{after:"${w.start}", before:"${w.end}"} and no query to LIST every meeting in the window, then open the ones whose title/participants look relevant and read their transcripts directly. Only report a window as sparse after this listing fallback.
2. BIAS TO TRANSCRIPTS: for the most relevant meetings, call get_transcript and read what was actually SAID. Minutes are lossy — only use search_minutes/get_minutes to locate candidates, not as the evidence itself. Paginate long transcripts with start_minutes/duration_minutes.
3. Capture DIRECT QUOTES with speaker, meeting title, the FULL meeting id, url, and date. For each, one line on why it matters. Also capture decisions made, disagreements (who pushed back on what), and questions left open.
   FULL UUIDS ONLY: Quill meeting ids and note ids are UUIDs (e.g. 1737e957-8a05-410f-9b77-23c46338ba7a). Copy the ENTIRE id verbatim — never truncate, shorten, or paraphrase it. A quill:// deep link only resolves with the complete UUID, so a partial id is worthless. Same for any note id you cite.

ADVERSARIAL: don't just collect supporting quotes. Look for evidence a claim is WEAK, contested, or unresolved. If the window has little/nothing relevant, say so plainly — that is a valid finding.

WRITE your full evidence report (markdown, organized by dimension, every claim with a meeting link) to: ${rawPath(i, w)}
Use the Write tool. Create the file even if sparse.

THEN return the schema object: window label, meetingsReviewed (id/title/date/url), evidenceByDimension (dimension key, count of quotes, 2-4 highlight strings), notableDecisionsOrDisagreements, and reportPath="${rawPath(i, w)}".`
}

function reducePrompt(d) {
  const paths = windows.map((w, i) => rawPath(i, w))
  return `You are the REDUCE agent for ONE dimension: **${d.name}** (key: ${d.key}).
Definition: ${d.definition}

Top-level question: "${question}"

The MAP agents wrote per-window evidence files (time-ordered, oldest first):
${paths.map(p => `- ${p}`).join('\n')}

Read ALL of them (Read tool) and pull out everything about **${d.name}** — ignore the other dimensions. The windows are chronological, so you can see how the thinking changed over time. When you carry a meeting or note id forward, copy the FULL UUID verbatim — never truncate it.

Produce a consolidated dimension report:
- A crisp summary of where things stand on this dimension, grounded in quotes (keep meeting links).
- Key findings (the load-bearing ones).
- EVOLUTION — as a dated timeline: a chronological list of the pivotal moments ("YYYY-MM-DD — what changed / was decided / newly surfaced"). Keep dates and specifics; this feeds the report's timeline.
- DISAGREEMENTS: where participants diverged (who pushed back on what)${participantsHint.length ? ` — e.g. among ${participantsHint.join(', ')}` : ''}.
- The sharpest OPEN QUESTIONS that the meetings did not resolve.
- A bottom-line assessment of this dimension, in whatever terms the top-level question calls for. (If the dimension definition asks for a specific score or rating, provide it; otherwise don't invent a scale.) Plus your confidence — low/medium/high — based on how much evidence there was.

BALANCED & FACTUAL: weigh evidence for AND against this dimension proportionally — neither inflate nor over-discount. Separate what the evidence shows from what you infer, and label inferences as such. Don't build a sweeping claim on a single quote; if sources conflict (about a date, a person's status, or a commitment), note the conflict rather than choosing the more dramatic reading.

THE FILE IS THE DELIVERABLE — the value you return is only a tiny digest and will NOT preserve your analysis. In strict order:
1. Use the Write tool to save the FULL consolidated report (everything above, cited, with meeting links) to: ${dimReportPath(d)}
2. Use the Read tool to read it back and confirm it saved with your full content.
3. Only then return the digest: dimension="${d.key}", confidence, oneLineSummary (ONE sentence — include a score/rating only if the dimension definition asked for one), openQuestions (the sharp ones), reportPath="${dimReportPath(d)}".
Never put the full report in the return value — it belongs in the file.`
}

function synthPrompt(reduceResults) {
  return `You are writing the most important artifact of this research: a rigorous analytical report that answers the question for whoever asked it. Question: "${question}"

The per-dimension analyses are at:
${reduceResults.map(r => `- ${r.dimension}: ${r.reportPath}`).join('\n')}

Read those analyses fully (Read tool). To ground or verify a specific claim, you may also open the raw evidence in ${outDir}/_raw/ and the deep-dives in ${outDir}/questions/.

Work in TWO PASSES. First, design the report's outline yourself: decide the section sequence that best answers the question. A suggested shape is offered at the end, but you are not bound to it — aim for the best possible report. Make the outline logically sound, each section earning the next. Then, once the outline holds together, fill it in.

This is a REPORT, not an essay or a pitch. Register: a senior analyst briefing a principal — measured, fact-first, proportional. No hype, no flourish, no breathless framing.

Respect the reader's intelligence: present the evidence, well-organized, in a logical sequence, and let THEM reach their own conclusions. You are structuring and assessing data, not selling a thesis. A clear bottom-line assessment up front is good, but it must rest on evidence the reader can verify below, not on rhetoric. Aim for a logical analytical sequence — never an emotional story.

Principles:
- FACT-HEAVY, not opinion-heavy. Lead with what the evidence shows: named accounts, dated events, direct quotes. Where you draw a conclusion the evidence only implies, mark it ("[inference]" / "this suggests") and let the reader weigh it. Never assert an inference as established fact.
- One data point is one data point — don't escalate a single quote into a sweeping characterization.
- Cross-check facts against the whole corpus before stating them — especially a person's status, a date, or a commitment. Do NOT infer someone's presence, absence, or whereabouts from a phrase like "defer until X returns" — it usually just means "until X is next available," not that they were away. Report the literal fact ("the decision was deferred") and do not invent a reason for it. When sources conflict, report the conflict; never pick the more dramatic reading.
- Proportional and balanced: give strengths and weaknesses exactly the weight the evidence gives them. Credit what works plainly; flag what is weak plainly. Neither cheerlead nor catastrophize.
- Do not narrate the research mechanics: no "windows" / "W1/W2", "this run", "the agents", "search returned empty", "reportPath", or raw confidence-label scaffolding.

Include a TIMELINE: a compact, dated list of the pivotal developments ("YYYY-MM-DD — what changed / was decided / newly surfaced") — a handful of factual entries, in order. Put it near the top or as its own short section; it orients the reader and anchors the report in checkable events.

Headers state a finding, plainly. Each section header is a specific claim in plain language — e.g. "Data control opens regulated rooms; whether it converts is unproven." NOT a tease or hook ("What six weeks actually proved", "...and it's not flattering"). If a header would work as a viral post title, rewrite it as the finding it hides.

Craft:
- Write for a smart reader who already knows this business; advance their understanding, don't re-explain basics.
- Plain, precise language. No metaphor-as-argument, no loaded verbs. Short sentences and paragraphs; line breaks so claims breathe and the report stays scannable.
- Tables only where they sharpen a comparison. Link to the deeper analyses inline where a reader wants depth: ${reduceResults.map(r => `[${r.dimension}](${r.dimension}/report.md)`).join(', ')}.
- Close with recommendations: concrete and prioritized, each following visibly from the evidence above it.

Suggested (optional) shape: bottom-line assessment → timeline → one section per major finding (each header a claim) → recommendations → appendix. Adapt it, or replace it with a better structure.

End with a short APPENDIX, clearly separated so it never intrudes on the report:
- a one-line Sources / provenance note;
- a brief map of the sub-research the reader can dig into — the per-dimension analyses (${reduceResults.map(r => `${r.dimension}/report.md`).join(', ')}), the dated raw evidence under \`_raw/\`, and the deep-dive answers under \`questions/\`.

If you cite any meeting/note id, copy the FULL UUID verbatim — never truncate it.

Write the file, then Read it back to confirm it saved.

THEN return the schema: executiveSummary, crossCutting (array), nextQuestions (array of {q, why, dimension}), summaryPath="${outDir}/00-SUMMARY.md".`
}

function qrPrompt(nq, i) {
  const path = `${outDir}/questions/${String(i + 1).padStart(2, '0')}-${slug(nq.q)}.md`
  return `You are a ROUND-2 targeted research agent. Investigate exactly this question, generated by the synthesis step:

QUESTION: "${nq.q}"
WHY IT MATTERS: ${nq.why}
DIMENSION: ${nq.dimension}

LOAD TOOLS: ${QUILL_TOOLS}

Search the Quill corpus broadly (no tight time window this time — search across the whole period). Bias to transcripts (scope:"deep-content", then get_transcript). ${peopleNote} If the answer genuinely isn't in the meetings, say so — and note what evidence WOULD answer it (e.g. "needs an internal accuracy eval", "needs a customer conversation").

WRITE your findings to: ${path} (markdown, cited with meeting links — use FULL meeting/note UUIDs, never truncated — lead with the answer).
THEN return: question, answer (the synthesis), confidence (inconclusive/low/medium/high), evidence (array of meeting refs), path="${path}".

Cap the written report at ~500 words. Permission to come back "inconclusive."`
}

function finalizePrompt(synth, round2) {
  return `You are the FINALIZE agent. A map/reduce research run just completed in ${outDir}.

1. Read ${outDir}/00-SUMMARY.md.
2. Append a section "## Round 2 — deeper answers" that links each round-2 question doc with a one-line takeaway:
${round2.length ? round2.map(r => `   - [${r.confidence}] ${r.question} → ${r.path}`).join('\n') : '   (no round-2 questions were run)'}
3. Write ${outDir}/_next-questions.md: a dashboard table of all generated questions with status. Mark a question "answered (r2)" if it has a round-2 doc, else "open". Generated questions:
${(synth?.nextQuestions || []).map(q => `   - [${q.dimension}] ${q.q}`).join('\n') || '   (none)'}
Round-2 docs written:
${round2.map(r => `   - ${r.path} (${r.confidence})`).join('\n') || '   (none)'}

Use the Write/Edit tools. Return a one-line confirmation with the path to 00-SUMMARY.md.`
}

// ---------- run ----------
phase('Map')
log(`Mapping ${windows.length} time windows in parallel…`)
const mapResults = (await parallel(windows.map((w, i) => () =>
  agent(mapPrompt(w, i), { label: `map:${w.label}`, phase: 'Map', schema: MAP_SCHEMA, model: M.map })
))).filter(Boolean)

phase('Reduce')
log(`Reducing ${dimensions.length} dimensions across ${mapResults.length} window reports…`)
const reduceResults = (await parallel(dimensions.map(d => () =>
  agent(reducePrompt(d), { label: `reduce:${d.key}`, phase: 'Reduce', schema: REDUCE_SCHEMA, model: M.reduce })
))).filter(Boolean)

phase('Synthesize')
const synth = await agent(synthPrompt(reduceResults), { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, model: M.synthesize })

let round2 = []
if (recursion && recursion.rounds > 0 && synth && synth.nextQuestions && synth.nextQuestions.length) {
  phase('Recurse')
  const top = synth.nextQuestions.slice(0, recursion.topK || 4)
  log(`Recursing on top ${top.length} generated questions…`)
  round2 = (await parallel(top.map((nq, i) => () =>
    agent(qrPrompt(nq, i), { label: `q:${slug(nq.q)}`, phase: 'Recurse', schema: QR_SCHEMA, model: M.recurse })
  ))).filter(Boolean)
}

phase('Finalize')
await agent(finalizePrompt(synth, round2), { label: 'finalize', phase: 'Finalize', model: M.finalize })

return {
  outDir,
  summaryPath: synth && synth.summaryPath,
  windows: mapResults.map(m => ({ window: m.window, meetings: m.meetingsReviewed.length, reportPath: m.reportPath })),
  dimensions: reduceResults.map(r => ({ dimension: r.dimension, strength: r.strength_1to5, confidence: r.confidence, reportPath: r.reportPath })),
  nextQuestions: (synth && synth.nextQuestions) || [],
  round2: round2.map(r => ({ q: r.question, confidence: r.confidence, path: r.path })),
}
