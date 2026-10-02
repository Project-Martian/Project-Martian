# Microtrends mapping and review

Microtrends follows **model maker → model → primary attack type**, with each path pointing to the existing incident and its sources. The October 1 PRD is implemented as `maker-model-attack-v1`. The rings, logo nodes, badges, curves, panels, filters, incident list and zoom/pan/Fit controls retain their existing design. Labels and incident detail text now describe the new fields. Links retain incident-count weighting; Rogue Index scores do not weight this map.

## Ownership and taxonomy

PostgreSQL owns published `record.map` values inside immutable incident revisions. `data/taxonomy/companies.json`, `models.json` and `attacks.json` define the controlled vocabulary, compiled into the application image. Catalog changes require code review. Additions do not invalidate unrelated mapping approvals; changing a used model definition or attack family does. Preserve existing definitions for historical interpretation; a semantic taxonomy replacement needs a new version.

Each mapping contains:

- `links`: one or more maker/model/version tuples, the `model_named_in_source` flag, and a source URL plus a short quotation for every named model.
- `attack` and optional `attack_2`: only the primary type feeds the ring. Both must match the record's agent/non-agent scope.
- `harness`, `ran_by`, `hit`: the agent product, operator and affected resource. Operators and targets are not promoted to model makers.
- `sources.model` and `sources.attack`: URLs already cited by the incident. Per-link sources support incidents involving several models.
- `exposure_category`: the existing “What was exposed” panel's category, independent of attack family.
- `rationale`, `notes`, proposal provenance and declared human reviews.

The maker catalog includes the PRD's labs, Open source and Unknown, plus Amazon, IBM, Microsoft and Face++ for existing non-agent records. It is a vocabulary, not a list of empty nodes. Only makers represented in incidents appear. Unknown maker/model values are explicit editorial classifications, never inferred from a product name or substituted after a runtime error.

The 13 agent attack types are organized into **Attacked from outside** and **Went rogue**. **AI failure** retains the non-agent harm categories, including privacy, forecasting, impersonation and evasion cases already in the archive. AI failure records appear only under All AI. Attack-family membership does not independently establish attacker intent: the self-generated compaction injection is labelled Prompt injection with an explicit note that no outside attacker is established.

A named model needs an explicit family or internal model identifier in a source. Versions are allowed only when listed for that model. An internal checkpoint based on GPT-5.4 mini is labelled “GPT-5.4 mini (research)”, not equated with the released model. A maker-owned harness can supply a qualified label such as “Claude (via Claude Code)” when no model is named; it does **not** count toward named-model coverage. Replit Agent, GitHub MCP and internal Meta deployment do not establish a particular model maker.

## Build and interaction contract

`backend/microtrends.ts` derives the existing `{p: [[company, model]], act, exp, cat}` object from records. Publishing rejects a stored object that differs from the derived one. The normalized relationship tables store that generated representation; the API reads it alongside the canonical record mappings in one publication snapshot. There is no second hand-maintained mapping in browser code and no schema migration for this change.

The backend also generates a family map and the version-to-family labels. The browser selects that map when the current time/setting/scope window has **more than 20 distinct model nodes**. It rolls up every record, never truncates the list. Model selections translate across grouping changes. Unnamed models and qualified harness labels retain their meaning; a family rollup cannot guarantee fewer than 20 nodes if more than 20 distinct families eventually exist.

One incident counts once in totals, once per distinct maker/model node and once per distinct link. Collapsed versions do not multiply counts. Selection is OR within a ring and AND across rings, with maker and model required to occur in the **same pair**. Highlighted paths, summary counts and hover counts follow those pairs. For example, selecting Anthropic and GPT-5.6 Sol yields no path even though both occur in the multi-maker AISI incident. The incident list opens the Timeline, where mapping evidence, harness, operator, target, secondary attack and uncertainty appear in the existing evidence disclosure.

The public API adds:

- `GET /api/microtrends`: existing `map`, `as_of` and publication identity, plus version, review mode, family mapping, grouping threshold and coverage. The same metadata is in `/api/archive` and `/api/trends` under `analytics.microtrends` and `microtrends`, respectively.
- `GET /api/incidents/:id/mapping-history`: changed published mapping values, publication date, operator and reason. Original legacy mappings are retained as `legacy_mapping`; later record mappings are in `mapping`. Unknown IDs return 404.

Publications without the new Microtrends settings explicitly retain `legacy-mapping-v1`. This preserves historical publications. The original seed files remain untouched. Mapping, impact and [Narrative/Comparison context](narrative-comparison.md) review hashes are independent; changes to original incident evidence still invalidate all affected reviews.

## Prepare, review and publish

Extraction in this first pass is manual, assisted by source reading. No Claude API, paid inference, crawler or weekly extraction automation is connected. A contributor supplies proposed mappings; a person must confirm the source actually identifies the model and supports the classification. Validation cannot authenticate reviewer identities or prove a quotation appears on a web page.

Build first with `npm run build`. Export a full publication using the [database workflow](usage.md#publishing-data). For a first migration, a draft file must cover all records and its `based_on_source_hash` must match that export exactly:

```sh
node dist/backend/microtrends-manage.js prepare \
  /path/to/export.json /path/to/mappings.draft.json /path/to/proposed.json
node dist/backend/microtrends-manage.js report /path/to/proposed.json
```

The checked-in `data/microtrends-mappings.draft.json` targets the local pre-Microtrends publication hash `953ca55e3710f7a2ed37748510566d586efd166e25eab0d6975d9b4457847edb`. It is a review artifact, not a startup seed or an automatically applied update. Do not rewrite its base hash to bypass a mismatch. Current exports already containing maps can be edited directly; retain source citations and remove stale reviews when changing evidence.

After editing `record.map`, rebuild its derived representation into a **different** file:

```sh
node dist/backend/microtrends-manage.js build /path/to/edited.json > /path/to/proposed.json
node dist/backend/microtrends-manage.js review /path/to/proposed.json \
  --record INCIDENT_ID --reviewer HUMAN_HANDLE --decision approve \
  --note 'Verified the source identifies this model and supports the mapping'
```

`build` emits a complete validated publication. Never redirect output over its input. Reviews bind to the mapping, incident evidence and used catalog definitions. A dispute blocks reviewed mode; changing a mapping invalidates previous approvals. Do not invent reviewer identities or approvals. Metadata is public after publication, so use public handles and notes.

After all mappings are approved, set `settings.microtrends_review_mode` to `reviewed`, then publish using the owner-only operator command in the usage guide. Explicitly authorized draft releases and local previews require `--allow-draft` and display “Draft mappings · human review pending.” Impact and context review modes remain separate: a publication containing any kind of draft still requires that explicit flag. An application build, Git commit or merge does not update PostgreSQL or deploy EKS.

## First-pass coverage and limits

The October 2 local preview has 44 mapped records, including 23 agent records, and **zero human-approved mappings**. Seven agent records have source-supported model names (30.4%); the one-third PRD goal needs at least eight. The majority of OpenAI records remain explicitly unnamed. Consequently the current leading-company conclusion often names an unnamed model; the PRD's top-three named-model conclusion goal is not met. Do not manufacture specificity to meet either target.

The seven records cite Astra; GPT-5.6 Sol; Mythos 5; Claude Opus 4/4.7; IM1; and the separately described GPT-5.4-mini research checkpoints/GPT-5.5 evaluations. Model comparisons elsewhere in a report are not treated as actor identification. The aggregate Irregular report does not link each sub-incident to a particular one of its named models; its mapping notes preserve that limit. RubyGems attribution remains disputed, and all historical non-agent maker assignments remain reviewable drafts.

The named-model evidence used in this draft is traceable here:

| Incident | Models identified in the source |
| --- | --- |
| [Self-generated summaries](https://alignment.openai.com/misalignment-reports/self-generated-prompt-injections-in-compaction-summaries/) | Astra family |
| [Deceptive handovers](https://alignment.openai.com/misalignment-reports/encouraging-deception-in-compaction-summaries/) | GPT-5.6 Sol |
| [AISI evaluations](https://www.aisi.gov.uk/blog/incident-report-unsanctioned-agent-behaviour-during-cyber-testing) | Mythos 5 and GPT-5.6 Sol |
| [Hugging Face incident](https://openai.com/index/hugging-face-incident-and-the-road-ahead/) | IM1 and separately identified GPT-5.6 Sol activity |
| [Irregular evaluations](https://www.anthropic.com/news/investigating-incidents-cybersecurity-evals) | Opus 4.7, Mythos 5 and an unnamed internal model |
| [Self-replicating instructions](https://alignment.openai.com/misalignment-reports/self-replicating-prompt-injections-exist/) | GPT-5.4-mini-based research checkpoints; GPT-5.5 in the separate evaluation |
| [GitHub MCP demonstration](https://invariantlabs.ai/blog/mcp-github-vulnerability) | Claude Opus 4 |

The local preview preserves the original 44 incident narratives and all Rogue Index inputs and results. Deployment approval does not approve mapping evidence. The Helm deployment guide records the verified production release. Weekly extraction and authenticated reviewer management remain future work.
