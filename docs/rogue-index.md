# Rogue Index scoring and review

Rogue Index v1 implements the October 1 thesis: impact per incident, a three-month rolling sum and a fixed reference. It preserves the desktop line chart, 0–100 axis, selected range, colors, controls and six-month illustrative extension. The extension keeps the existing bounded slope calculation; it is not a forecast or confidence interval. Evidence labels do not change severity. Controlled demonstrations and human-directed agent misuse remain included, as in the thesis.

## Rubric and calculation

| Dimension | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| Damage | Nothing happened | Attempt or rule violation | Real action or exposed data | Deletion, theft, spending or production breach |
| Reach | No one | One system or team | One company or its users | Several companies or the public |
| Reversal | Fully undone | Recovered with effort | Partly recovered | Permanent |

The landing multiplier is 0.25 for sandbox/simulation, 0.5 for the operating company and 1 for external users, the internet or third-party systems. Judge where effects landed, not where the model ran. A public upload from training uses 1. An internet-accessible controlled demonstration does not automatically establish real victim harm. Describe the boundary in `why.landed`.

`points = (damage + reach + reversal) / 9 × 100 × multiplier`. The displayed incident score is rounded to the nearest integer. Bands use that displayed score: Contained 0–19, Notable 20–49, Serious 50–79, Severe 80–100. Sandbox scores cannot exceed 25. These ordinal editorial categories are not monetary loss, a probability or a calibrated comparison between different kinds of harm.

For each displayed month, sum **unrounded** points for dated agent records in that month and the preceding two calendar months, including records before the visible chart start. Divide by 300, multiply by 100, round to the nearest integer and cap at 100. Uncapped points and a saturation flag remain in the API. Adding an incident does not rescale unrelated months. The real-world overlay uses the same reference with only `landed: world`; it is no longer separately normalized. The tooltip lists incidents from the hovered month and separately identifies the three-month point total.

The initial archive has 23 agent records, of which 22 have dates. All 44 records receive assessments; non-agent records are scored for the archive but do not enter the agent index, preserving the existing chart population. The undated agent record is explicitly excluded from monthly totals. Grouped reports still count as one archive record; possible overlaps and disputed attribution are retained in the evidence, not silently resolved. `behavior` records autonomous, human-directed, unclear or non-agent context without changing the formula.

Use `confirmed` for an affected-company/provider or official account, `reported` for credible reporting and `alleged` for an uncorroborated claim. These identify the evidence basis, not independent proof. Source statements can establish an action without establishing its full harm or attribution. Unknown dimensions require an explicit proposed value and an `estimated` flag, never silent imputation; use the thesis's 2 for undisclosed reversal. Explain uncertainty in the associated reason.

## Data and review ownership

The existing text field `impact` remains unchanged. `impact_assessment` contains rubric version, proposer/time, three integer dimensions, landing category, evidence, uncertainty, reasons, source URLs and reviews. Source URLs must belong to the record's existing citations. Computed scores are never accepted as assessment inputs. PostgreSQL retains assessments with immutable incident/publication revisions; changing a record creates a new publication rather than rewriting old scores.

`data/impact-assessments.draft.json` is a proposed first pass tied to the initial publication hash. Its 44 assessments have **no human approvals**. `source_check: curated-record` means the draft used the existing curated account; `source-read` means a linked primary account was read for this pass. Neither is a reviewer approval. The file does not automatically import on startup or deployment.

The rubric's sample arithmetic produces 100, 89, 56, 44, 11 and 8 from the six input tuples in the thesis. Those sample inputs are not established facts. Two draft assessments differ after checking the evidence:

- Hugging Face is proposed as 78 (3/2/2, world), with reversal estimated. Its [affected-party disclosure](https://huggingface.co/blog/security-incident-july-2026) establishes internal compromise but leaves customer impact under investigation; platform reach alone does not establish several-company/public harm. The thesis's 89 requires Reach 3.
- Citation uploads are proposed as 56 (2/1/2, world), with reversal estimated. The [provider account](https://alignment.openai.com/misalignment-reports/uploading-files-to-the-internet-in-order-to-cite-them/) establishes uploads and preventive changes, not recovery of those files. The thesis's 44 assumes Reversal 1.

These are review proposals, not new approved claims. With the current drafts, May–July 2026 hit the 100 cap. The implementation preserves the requested 300 reference and reports excess points instead of recalibrating it to fit the archive.

One distinct reviewer must approve each assessment; Severe requires two. Reviews bind to a hash of the assessment and the full incident evidence. Edits invalidate old approvals and require removing the obsolete declarations and reviewing the new version. Explicit disputes, different landing categories, or a difference greater than one on a numeric dimension (against the proposed values or between reviewers) mark the assessment disputed. Disputed assessments can be shown in a labelled draft preview; they cannot pass reviewed publication validation. Reviewer identity is an operator-supplied public handle checked through the contributor/PR process, not authenticated by the CLI. Never use the same person under multiple handles to satisfy Severe review.

Microtrends mappings and [Narrative/Comparison context](narrative-comparison.md), including their reviews, are excluded from impact approval hashes. An independent annotation correction does not change the impact assessment; changes to the underlying incident evidence still require renewed review.

## Prepare and review

Build first with `npm run build`. Export the current publication through the existing read-only database role as documented in [usage](usage.md#publishing-data). The commands below operate on review files, without a database or model connection:

```sh
node dist/backend/impact-manage.js prepare /path/to/export.json \
  data/impact-assessments.draft.json /path/to/impact-review.json
node dist/backend/impact-manage.js report /path/to/impact-review.json > /path/to/impact-report.json
# Only after the named person has actually reviewed the linked evidence and inputs:
node dist/backend/impact-manage.js review /path/to/impact-review.json \
  --record INCIDENT_ID --reviewer PUBLIC_REVIEWER_HANDLE --decision approve \
  --note 'Reason for accepting the dimensions and landing boundary'
```

Preparation refuses a mismatched publication hash or incomplete coverage and creates a new file. Review updates the named file atomically. A reviewer can use `--decision dispute`, or record different proposed values with `--damage`, `--reach`, `--reversal` and `--landed`. A subsequent declaration by the same handle replaces that handle's declaration in the review file; already published history remains unchanged. Source/score corrections require editing the assessment, clearing obsolete reviews and collecting fresh reviews. Changing evidence category never directly changes points.

For an explicitly authorized, labelled draft release or local preview, publish the prepared file with the owner CLI and `--allow-draft`, retaining `settings.impact_review_mode: draft`. This workstation's preview is `http://127.0.0.1:8766/#trends`; its draft inputs/export/report are under `~/.local/state/project-martian/rogue-index-20261002/`. Deployment approval does not approve the evidence or change draft status; the Helm deployment guide records the live publication.

After actual review is complete, set `settings.impact_review_mode` to `reviewed` and use the ordinary owner publication command with actor and reason. Validation rejects insufficient, stale or disputed reviews. The application needs the impact-capable release before this publication is made in production. Neither a Git commit nor a deploy overwrites database content. No new Helm resource or database migration is needed. The existing JSON import seeds remain unchanged.

## API and history

`GET /api/archive` and `/api/trends` include `analytics.impact` / `impact` with version, reference, review mode, coverage, computed assessments and monthly series. Existing chart arrays keep their shape. `GET /api/impact-index` returns that impact object with publication metadata. `GET /data/impact_index.json` returns monthly entries directly from the database-backed calculation, with review mode and publication ID on every entry; there is no second static source of truth. Impact-only endpoints return 409 when the selected publication explicitly uses the legacy methodology.

`GET /api/incidents/:id/impact-history` returns changes in published assessment inputs/reviews, timestamps, operator actor/reason and the computed score for each version. Unchanged assessments across publications are collapsed. A pre-assessment revision has a null assessment/score. All metadata is public, so use public handles and avoid private information in review or publication notes. The read-only application role cannot create reviews or publish.

The first pass does not implement automatic news ingestion, Claude extraction, a browser review console or authenticated reviewer accounts. Source assessment and human review use the existing contributor/operator workflow. The scoring change preserves Narrative, Comparison, Radar, Timeline and Ask behavior; Microtrends has its separate [mapping workflow](microtrends.md). No new inference calls or external integrations are needed for scoring.
