# Contributing to Project Martian

Bring public evidence of one incident, a documented research demonstration, or a correction. You do not need to write code. Submissions are leads for human review, not automatic additions to the archive. Credible reporting can establish a reported claim; it does not make every claim independently verified.

## Submit from the website

1. Search **Timeline** and [existing issues](https://github.com/Project-Martian/Project-Martian/issues) for the event. For a correction, use **Suggest a correction** on the existing record.
2. Open **Contribute**. Give the public source URL, product or organization, what happened, observed effects and uncertainty. Keep occurrence dates separate from the source's publication date; write “unknown” rather than guessing. Additional links should support the same event.
3. Select **Prepare GitHub issue**, review the preview, then **Review and submit on GitHub**. A GitHub account is required. The website prepares the issue; it does not submit it on your behalf. Until you submit on GitHub, there is no issue number or saved server-side submission. The draft stays in the page and is lost on reload or leaving the site.
4. Keep the issue number. It is the review thread for this contribution. Follow questions and decisions there. The website's **Check publication** control shows a receipt once the reviewed record has reached the database; no receipt does not mean rejection or prove the issue exists.

You can also use the [GitHub incident form](https://github.com/Project-Martian/Project-Martian/issues/new?template=incident.yml) directly. It uses the same `source`, `date` and `summary` fields as the website link. Each submission is one issue; each accepted issue produces at most one incident revision. New incidents get stable IDs `github-issue-N`. A correction issue points to an existing ID rather than creating a duplicate incident.

A useful summary states the intended task, observed action, affected systems and limits of the source. Label simulations, evaluations, provider accounts and allegations explicitly. A social post or screenshot alone is a lead; include a checkable disclosure, investigation or credible report. Never infer a model from a product name, invent dates, estimate monetary losses without evidence, or turn several articles about one event into separate incidents. Do not submit credentials, private/customer data, personal details, or instructions for attacking live systems. Public issue discussion remains attributable to your GitHub account. There is no contributor certificate or automatic reward system.

## Maintainer review and publication

The source implementation supports the following workflow. Automatic transfer is **not active until its GitHub credential and Helm CronJob are configured and deployed**; see the [deployment guide](../martian-helm-charts/docs/project-martian.md#github-contribution-publication). The public web process remains read-only.

1. **Triage the issue.** Check scope, duplicates and source access. Ask for missing evidence in the issue. Close unsupported or duplicate reports as **not planned**. A closed issue with no approved structured record is never imported. Subscribe to repository issue notifications to receive submissions; the website does not send email.
2. **Prepare the record.** Export the latest publication using the [operator workflow](docs/usage.md#publishing-data), keeping an untouched base export and a separate working copy. For a new incident use `github-issue-N`; for a correction preserve the existing ID. Edit just that record. `backend/publication.ts` and `backend/types.ts` define required narrative, citation and event fields. Keep `u`, `srcs`, `th`, impact, limits and source labels complete. The seed JSON files are historical import data, not the current archive.
3. **Review the annotations.** Prepare source-backed impact, maker/model/attack mapping and, for agent incidents, source chronology/operating context using the guides below. Rebuild the derived map. Incoming records must have current human approvals for each applicable annotation; Severe impact needs two distinct reviewers. Existing unrelated draft records remain drafts. Use the reviewers' exact GitHub login names. Remove stale review entries from the proposed revision after re-review; past published revisions retain their own review history. Do not invent approvals or relabel the rest of the archive as reviewed.
4. **Prepare the issue proposal.** The commands below validate and extract only the selected record from the reviewed working copy. They do not write GitHub or the database. Post the resulting comment in the issue. Keep exactly one current proposal comment per issue; edit that comment when revising a pending proposal.
5. **Approve the exact content.** Each declared reviewer uses their own GitHub account to post a fresh comment containing exactly `/approve-incident SHA256`, with the hash printed by `format`. Approvers need write, maintain or admin permission in this repository. Every declared annotation reviewer must authenticate their approval this way. Severe incidents need at least two distinct maintainer approvers. Do not edit approval comments. A fresh `/revoke-incident SHA256` withdraws that review before publication. After any proposal edit, reviewers must post new approvals even if the content hash stays the same.
6. **Mark Done.** A maintainer closes the issue with reason **completed**, after all approvals. For this worker, Done means issue completion; merely moving a GitHub Projects card is not a trigger. The enabled job scans every five minutes, rechecks GitHub permissions and content, validates the record against the latest publication, and writes the revision and receipt in one transaction. Proposal or review-decision changes after completion require reopening, reviewing and completing again.
7. **Confirm the receipt.** Check `/api/contributions/N` or the website status control, then open the linked Timeline record. The issue number, approvers, proposal hash and publication ID are retained in PostgreSQL. Timeline links back to each accepted contribution. If blocked, inspect the Job's issue-specific reason; a stale correction needs a fresh base export and review. Completion alone is not proof of successful publication.

```sh
# Use the documented database environment with the read-only application role.
node dist/backend/manage.js export > /path/to/base.json
# Copy base.json to reviewed.json, then edit and review the selected incident.
# Rebuild its derived mapping after edits (see docs/microtrends.md).
node dist/backend/contribution-manage.js propose /path/to/base.json /path/to/reviewed.json \
  --issue 12 --record github-issue-12 > /path/to/proposal.json
node dist/backend/contribution-manage.js check /path/to/proposal.json /path/to/base.json
node dist/backend/contribution-manage.js format /path/to/proposal.json > /path/to/issue-comment.md
# Post issue-comment.md on issue #12; reviewers post the printed approval command.
# A maintainer then closes #12 as completed. The configured worker handles publication.
```

These are examples, not actual incident IDs or approved submissions. Source review remains human work; schema checks establish structure and approval consistency, not factual truth. A proposal cannot change settings, Radar data or another incident. Calendar extensions and taxonomy changes need their existing explicit review/release process. New records outside the chart calendar still appear in Timeline but do not extend historical charts automatically.

Repeated scans, restarts and concurrent workers do not duplicate a successfully published issue: `(repository, issue_number)` is unique and shares the publication transaction. A correction's `base_record_hash` prevents overwriting a changed record. Reopening or editing an already published issue does not unpublish or update it; submit a new correction issue. A receipt remains historical evidence even if a later manual publication removes an incident from the current archive. Failed attempts are reported in Job logs and produce no successful receipt; the worker does not post GitHub status comments.

## Evidence and code guides

- [Rogue Index](docs/rogue-index.md): four impact inputs, reasons, source references, uncertainty and independent review, including two reviewers for Severe scores.
- [Microtrends](docs/microtrends.md): controlled maker/model/attack catalogs, operator versus target, quoted evidence for named models, derived map generation and attribution disputes.
- [Narrative and Comparison](docs/narrative-comparison.md): occurrence precision, source publication/update dates, publisher roles, original reporting versus syndication, and account developments.
- [Architecture](docs/architecture.md): APIs, data ownership and the contribution trust boundary.
- [Setup and publishing](docs/usage.md): local runtime, manual owner publication and contribution worker commands.

For code changes, run `npm run check`, `npm run build` and `git diff --check`. Open the light desktop website against PostgreSQL and exercise the affected flow. Do not add tests without a request. Do not send synthetic public issues or approve invented incidents to verify the integration. Git changes alone do not change published records or deploy the application.
