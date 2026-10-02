# Narrative and Comparison

`disclosure-comparison-v1` adds source chronology and operating context to the 23 agent records. The desktop views and read APIs are implemented; the October 2, 2026 source audit is a draft with no human approvals. The [Helm deployment guide](../../martian-helm-charts/docs/project-martian.md) records release configuration and verified production rollout separately. PostgreSQL owns the published annotations, stored in each incident revision's existing `content.context` JSON. No schema migration or additional service is needed.

## Narrative

“Disclosure sources” groups each record by the publisher type of its earliest dated source checked in this audit. It does not establish the first disclosure worldwide, media reach, popularity, reporting quality or independent corroboration. Category percentages include every agent record, including unknown chronology. Each category opens its contributing records; disclosure-month dots open source details.

Publisher type (lab/vendor, independent research, government, news, individual/blog or other) is separate from role (provider, affected party, evaluator, investigator or journalist). A vendor can be an affected party. A syndicated article retains its original publisher in `origin`; several copies of an article do not become several incidents or independent confirmations. Same-day sources are retained together; sources from different publisher types appear in the tie category.

`published_on` and `updated_on` are separate nullable dates. An update label cannot establish original publication. `checked_at`, `check` and `date_note` record what was inspected and any limitations. Selection lives in `disclosure.source_urls`: a nonempty selection must contain every checked source tied at the earliest known publication date. Leave the selection empty, with an explanation, when chronology remains unresolved—for example, checked coverage refers to an earlier report whose date has not been established. Reading a source verifies what it says, not the truth of every underlying claim.

“Accounts & updates” is a three-record pilot: Hugging Face's initial account and the later provider investigation; RubyGems' service disruption and later response about uncertain AI attribution; and the US-government story's provider response and subsequent coverage. Its six source-linked steps distinguish initial accounts, responses and follow-ups, each with an explicit limitation. This is a manually curated sequence of checked accounts, not a comprehensive media narrative or automated sentiment analysis. A step adds no incident count. Development dates must match a cited source's publication or update date; unknown dates remain null.

## Comparison

Comparison separates where the agent was operating from where its effects landed:

| Dimension | Values and ownership |
| --- | --- |
| Operating context | Training, evaluation, research use, deployed use or unknown; source-linked `context.operating_context` |
| Landing | Sandbox, operating company, external users/systems; existing Rogue Index `impact_assessment.landed` |
| Unknown landing | The impact assessment explicitly marks `landed` as estimated |
| Evidence basis | Existing impact assessment: confirmed, reported or alleged |

Evaluation origin does not imply sandbox-only effects. “Confirmed” retains the [impact rubric's definition](rogue-index.md); it is not a new claim of independent verification or human review.

Monthly stacked counts are the default. Cumulative lines count records from the start of the displayed calendar, with no projection or earlier carry-in. Filters select operating context, evidence basis and occurrence/disclosure date basis. A bar, point, landing card or month selector narrows the contributing-record list; records open in Timeline with their context evidence. The exclusion control lists records missing a usable month or outside the chart window. The sidebar follows the selected filters.

Occurrence annotations retain `start`, `end`, precision and a cited explanation. Day precision uses one date; month precision uses whole-calendar-month bounds without implying a known day. A range entirely within one month can enter that month. A range spanning months is excluded from monthly occurrence counts rather than assigned an invented month. Disclosure mode uses the selected checked publication date. Neither mode falls back to the original archive sorting field `d`; discovery dates alone do not establish occurrence dates.

Counts are **archive records**, not deduplicated events, victims or rates of AI failure. `record_unit` and `unit_note` expose grouped reports, campaigns and unresolved overlap. A grouped record contributes once. The chart retains January 2025–September 2026; the context audit's October 2 date does not extend the chart calendar. Landing cards show the total, the last six calendar months and the absolute change from the preceding six, avoiding a percentage from a zero baseline.

## API and snapshot contract

`GET /api/narrative` returns publication metadata alongside the Narrative fields. Its records contain disclosure selection, all checked sources, occurrence/context, developments and review status. Breakdown rows expose their contributing `record_ids`; coverage includes dated disclosures, unknown chronology, unique source URLs, reviewed records and records with developments.

`GET /api/comparison` returns publication metadata alongside the Comparison fields. Accepted query parameters are:

| Parameter | Values | Default |
| --- | --- | --- |
| `context` | `all`, `training`, `evaluation`, `research`, `deployment`, `unknown` | `all` |
| `evidence` | `all`, `confirmed`, `reported`, `alleged` | `all` |
| `basis` | `occurrence`, `disclosure` | `occurrence` |

Series expose monthly `record_ids`, `cumulative_ids`, totals and recent/prior-six-month counts. Records retain their month, landing, context, evidence, both review states and exclusion reason. Coverage reconciles selected records into included, unknown-month and outside-window counts. A record counts as reviewed here only when both its impact and context reviews are current.

Invalid or unknown query parameters return 400. These two endpoints return 409 if the publication has not enabled this context version. `GET /api/incidents/:id/context-history` returns changed published annotations, including the first null context, or 404 for an unknown incident. `/api/archive` includes `analytics.narrative_v1` and `analytics.comparison_v1`; `/api/trends` exposes these two fields at its top level; older similarly named analytical fields remain legacy compatibility outputs.

All calculations use one database publication. The browser accepts a filtered Comparison response only if its publication ID matches the loaded archive; a newer publication requires reloading the page. Failed requests display an error. The frontend does not substitute static values or another date basis.

## Prepare, review and publish

Build with `npm run build` and export a publication using the [owner/application-role workflow](usage.md#publishing-data). For the initial migration:

```sh
node dist/backend/context-manage.js prepare \
  /path/to/export.json data/context-audit.draft.json /path/to/context-publication.json
node dist/backend/context-manage.js report /path/to/context-publication.json
```

The checked-in audit targets publication hash `a93a5b18af239606dac61cd1d482305cc4804af13876149cc1ba9e15558a964b`. It is a review artifact, not a startup seed. Preparation requires an exact source hash and exactly one context for every agent record, then writes a new file without overwriting an existing one. Do not rewrite the base hash to bypass changed evidence. Later exports already containing context can be edited directly and validated with `report`.

Record an actual human's review after they inspect the evidence:

```sh
node dist/backend/context-manage.js review /path/to/context-publication.json \
  --record INCIDENT_ID --reviewer PUBLIC_HANDLE --decision approve \
  --note 'Reviewed the cited chronology, context and account limitations'
```

Use `dispute` to record disagreement. Reviews bind to the context and original incident evidence through `context_hash`; edits invalidate old approvals. Reviewer handles are public declared metadata, not authenticated identities. No approvals are generated by preparation or deployment. One current approval with no current dispute is required for reviewed context mode. After all contexts are reviewed, set `settings.context_review_mode` to `reviewed` and use the owner-only publication command in the usage guide.

Impact, mapping and context review hashes exclude one another's annotation blocks while retaining the shared original evidence. Adding a source-audit annotation therefore preserves existing impact and mapping hashes. Editing original incident content invalidates all affected reviews. A context publication requires `impact-v1`, its version, review mode and as-of date. Drafts in any of the three review systems require the explicit `--allow-draft` publication flag. Local previews and any separately authorized draft release keep the pending-review label visible.

## Current coverage and verification

The October 2 audit covers 23 agent records and 26 unique source URLs. Eleven records have selected dated disclosures: five lab/vendor, two research, two government and two news; twelve retain unknown chronology. Fourteen records have an occurrence interval wholly within one calendar month: two sandbox, two operating-company and ten external-system landings. Nine lack a usable occurrence month. All 23 contexts await human review. These counts describe this draft, not continuous monitoring; source changes require another audit and publication.

All 44 original incident objects, apart from the added context annotations, are preserved. Local before/after comparisons found identical Rogue Index, Microtrends and Radar results. All 48 combinations of operating-context, evidence and date-basis filters reconciled their series IDs to the included record list; invalid-filter and unknown-history responses were checked. Existing TypeScript/JavaScript checks and the build passed. Desktop verification covers source filters/details, account developments, Comparison modes and drill-downs. These local implementation checks introduced no test infrastructure and used no paid inference. Production rollout and its checks belong in the Helm deployment guide.
