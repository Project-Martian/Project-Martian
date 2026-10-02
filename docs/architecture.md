# Architecture and data ownership

Project Martian is an independent public publication. One Node.js 24 / Fastify process serves the plain HTML/CSS/JavaScript frontend, read APIs and Bedrock Ask. One PostgreSQL 18 database stores its public evidence and publication history. The application uses its own database and credentials and has no external product API or customer-data connection. Helm resources live in the separate `martian-helm-charts/charts/project-martian` chart.

## Publication flow

`db/migrations` owns the schema. The operator CLI applies checksum-checked migrations and imports `data/records.json` plus `data/publication-seed.json` once. The import is transactional and records its content hash; subsequent imports with identical seeds do nothing, and changed seeds are rejected. Application startup never imports or modifies data.

PostgreSQL is the runtime source of truth. A publication contains an actor, reason, timestamp, content hash and display settings. Each publication writes a complete set of incident revisions. Stable incident IDs link revisions; sources, ordered source citations, timeline events, organizations, systems and incident/system relationships have separate tables. Existing descriptive fields, including the text `impact`, remain preserved in revision JSON. Radar signals and clusters retain explicit sample flags. Source dates are preserved as reported labels; they are not independently established disclosure dates.

The operator exports a publication, edits and reviews it, then explicitly publishes a new version. A transaction and advisory lock prevent partial or interleaved publication. Old revisions remain available in SQL; the public API reads the latest committed publication in a read-only repeatable-read transaction. A running page retains its loaded snapshot until reloaded. Ask reads one current database snapshot per request and returns its publication ID. No per-process incident cache or static-data fallback is used.

The application role `project_martian_app` has SELECT access only. The separate `project_martian_owner` role is reserved for bootstrap, migrations and operator publication. There is no public write API, admin screen, automatic source ingestion, reviewer assignment or factual verification system. A separate, explicitly enabled contribution worker can publish human-reviewed GitHub proposals using the owner role; the web application never gains that credential. Publication history records operator changes; it does not prove that an incident claim is true. Versioned Rogue Index assessments live in each revision's `content.impact_assessment`, separately from the preserved descriptive `impact` text. No additional database schema or service is needed. The [scoring and review guide](rogue-index.md) defines the rubric, declared human reviews, draft preview and historical API.

Microtrends v1 stores canonical `content.map` fields alongside impact assessments. Controlled catalogs and source/review validation generate its normalized maker/model relationships and primary attack; publication rejects any divergent derived mapping. The [mapping guide](microtrends.md) owns taxonomy, grouping, attribution and review rules.

Narrative and Comparison store versioned `content.context` annotations in the existing revision JSON: occurrence precision, operating context, publisher identity/role, checked source dates, disclosure selection and account developments. `backend/context.ts` validates these annotations and computes both views. Comparison reuses the Rogue Index landing assessment. Impact, mapping and context approvals independently bind to shared original incident evidence; editing one annotation does not invalidate another annotation's approval. No new migration, dependency or service is required. The [Narrative and Comparison guide](narrative-comparison.md) owns chronology, counting and review rules.

## API and presentation

| Route | Data |
| --- | --- |
| `GET /api/archive` | One consistent publication: records, metadata, mappings, Radar and analytical series; frontend entry point |
| `GET /api/incidents` | Current publication and all records |
| `GET /api/incidents/:id` | One current record, or 404 |
| `GET /api/incidents/:id/impact-history` | Published changes to one assessment, including prior inputs and computed scores |
| `GET /api/trends` | Rogue Index, Narrative, Comparison and sidebar series |
| `GET /api/impact-index` | Impact methodology, monthly series, assessments and coverage; 409 for a legacy publication |
| `GET /data/impact_index.json` | Monthly impact entries with methodology, review mode and publication ID; 409 for a legacy publication |
| `GET /api/microtrends` | Generated maker/model/attack mappings, display date, version, review mode, family map and coverage; explicit legacy metadata for old publications |
| `GET /api/incidents/:id/mapping-history` | Changed mapping values and publication dates, including original legacy mapping |
| `GET /api/narrative` | Checked disclosure sources, publisher counts, account developments and review coverage; 409 before context is enabled |
| `GET /api/comparison` | Monthly/cumulative record membership by landing; context, evidence and date-basis filters; 400 for invalid filters, 409 before context is enabled |
| `GET /api/incidents/:id/context-history` | Published context changes, including the initial null context; 404 for an unknown incident |
| `GET /api/radar` | Stored signals/clusters with sample flags |
| `GET /data/records.json` | Current records as JSON from the database, for compatibility |
| `GET /healthz` | Process health |
| `GET /readyz` | Database reachable and at least one publication present |
| `GET /api/config`, `POST /api/ask` | [Ask contract](ask.md) |

The browser renders, filters and navigates the returned snapshot. Shared analytical calculations run in `backend/analytics.ts`; Microtrends interaction and layout remain in `js/app.js`. HTML, CSS, logo assets and editorial interface text remain source-controlled. `js/records.js` is removed. The standalone HTML embeds assets but still loads `/api/archive` and requires the Node service.

Publications explicitly select `legacy-setting-v1` or `impact-v1`. The former preserves the original setting weights 3/2/1 and archive-peak normalization. Impact v1 calculates Damage, Reach and Reversal with the landing multiplier, sums exact points over three months and uses a fixed 300-point reference capped at 100. The chart's months, axis, six-month illustrative extension, colors and controls are retained; its tooltip lists each incident's computed score, band and uncertainty. A draft publication is visibly labelled and needs an explicit operator flag. Version selection is part of publication data, never an automatic recovery path.

The Jan 2025–Sep 2026 chart range and Sep 28, 2026 Microtrends date are unchanged. Narrative uses explicit checked source metadata. Comparison uses monthly counts by landing with a cumulative option and no projection; unknown chronology is retained as an exclusion. The browser uses `analytics.narrative_v1` and `analytics.comparison_v1`, also exposed by the dedicated endpoints. Older `narrative`, `sourceTypes`, `comparison`, `cumReal` and `cumLab` analytical fields remain legacy compatibility output and do not power these two views. A Comparison filter response must match the browser's loaded publication ID; otherwise it asks for a reload.

Rogue Index and Microtrends have an authorized draft production release recorded in the [Helm deployment guide](../../martian-helm-charts/docs/project-martian.md). Narrative and Comparison implement 23 draft context annotations as of October 2, 2026; their release configuration and deployment evidence are recorded in the same Helm guide. All 44 original records, Rogue Index results and Microtrends mappings remain unchanged. Radar still has eight illustrative posts and three sample clusters. These views are not live monitoring or calibrated risk measures.

## Timeline and contributions

`backend/timeline.ts` derives `timeline-v1` from the same published snapshot as the rest of the archive. `/api/archive` includes this projection; `/api/timeline` returns it separately with publication metadata. Each record has canonical model makers, searchable narrative/model/operator/target/source text, unique citation URLs, per-record impact/mapping/context review status, and separate archive, occurrence and checked-disclosure dates. Missing chronology stays unknown. Source counts count distinct URLs, not independent witnesses. Archive order is historical sorting metadata, not a standardized event date. Occurrence ranges group by their start year; month precision stays visible. Source publication, update and original archive date labels remain distinct.

The browser filters this one snapshot by scope, maker and search, updates counts for matching records, and renders all citations and evidence limits. The default date basis is archive order. Unknown dates remain in their own group in every mode. `#timeline/INCIDENT_ID` opens a stable record link; Joe/Jill shows the recorded sequence at equal spacing without inferring laboratory escape or precise elapsed time. Reload to get later publications.

Contribute prepares a public GitHub issue through the repository's issue-form URL parameters; it sends no database write and creates no server-side draft. The contributor reviews and submits on GitHub. Website and `.github/ISSUE_TEMPLATE/incident.yml` share the `source`, `date` and `summary` field IDs. Drafts are only in page memory. The issue number is the contribution identity; submitting the same report twice creates two issues and requires human deduplication.

`contribution-github.ts` reads the fixed public repository over GitHub's REST API using a dedicated Issues-read/Metadata-read token. It recognizes one versioned JSON proposal comment, verifies hash-bound approval comments and live repository permissions, and requires a maintainer to complete the issue. Proposals and comments are data, never executable code. Approval does not come from contributor-controlled labels or issue text. Severe incidents require two distinct approvers, and every declared annotation reviewer must approve from their own GitHub account. Revisions after completion require re-review; a final issue-state check catches changes during the API read. GitHub and PostgreSQL cannot share a distributed transaction: the worker uses the last observed GitHub review state before its database transaction.

`contributions.ts` validates a single add/correction, preserves unrelated records/settings/Radar data, rebuilds that record's map and applies the existing full-publication validators. New annotations require human reviews even when the existing archive is in draft mode. `002_contribution_publications.sql` stores one receipt per repository/issue with incident ID, operation, proposal hash/comment ID, approvers and publication ID. It commits alongside the immutable publication under the existing advisory lock. Corrections must match the current record hash. Receipts prevent duplicate publication on subsequent scans. Later edits or reopening do not retract a published incident; a new correction issue is required.

`GET /api/contributions/ISSUE_NUMBER` exposes a successful receipt or `published:false`; it does not query GitHub, confirm issue existence, or expose pending reports. Timeline includes accepted issue links. This integration is implemented in source and defaults disabled in Helm; production activation needs the token, migration, new image and explicit rollout. The [contributor guide](../CONTRIBUTING.md) owns review instructions, and the [Helm guide](../../martian-helm-charts/docs/project-martian.md#github-contribution-publication) owns its optional five-minute CronJob.

## Runtime boundaries

Production has one application Deployment replica and one PostgreSQL StatefulSet replica, with a retained 10 GiB encrypted gp3 volume. Migration, backup and optionally enabled contribution Jobs create temporary additional pods. The app requests 250m CPU/256 MiB, limited to 1 CPU/512 MiB; PostgreSQL requests 250m/512 MiB, limited to 1 CPU/1 GiB. Its application connection pool is five, and PostgreSQL permits 30 connections. This small single-instance setup has downtime during database failure or maintenance and no automatic database failover. For the approved current project scope, automatic failover, cluster NetworkPolicy enforcement and backup alert delivery are not required; they are not release blockers or planned work for this phase. Existing persistent storage and daily backups remain in place.

Only the application Service is exposed through the dedicated ALB. Database credentials are existing Kubernetes Secret files, never browser variables or Helm values. Migrations use the owner credential; the app and dump Job use the read-only credential. The backup uploader has a separate S3-only workload role. Daily logical backups leave the cluster for a dedicated encrypted private S3 bucket. Retained EBS storage is not a backup. The [deployment guide](../../martian-helm-charts/docs/project-martian.md) records actual backup/restore checks and the current CNI NetworkPolicy limitation.

Ask uses the AWS SDK for JavaScript with the dedicated Bedrock-only IRSA role, or the existing local AWS profile. It binds private in-process MCP tools to a single database snapshot. There is no public MCP endpoint, source browsing, arbitrary SQL or model-directed write capability. Questions and public evidence reach Bedrock. [Ask](ask.md) owns model limits and probabilistic review boundaries. Only `css`, `js`, `assets` and named HTML entry points are served as static files; backend source, bootstrap seeds and credentials are not public routes.

`backend/` is the active TypeScript backend; `package-lock.json` pins dependencies. The earlier `server/`, `requirements.txt` and existing Python tests are retained as historical implementation/reference files. They are excluded from the Node container, and their passing tests do not validate the new Node runtime.
