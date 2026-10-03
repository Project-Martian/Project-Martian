# Radar

Radar v1 adds an operational feed alongside the immutable incident archive. The foundation and worker are deployed with verified Bedrock access. The October 4 RSS pilot and activation are recorded in the [deployment guide](../../martian-helm-charts/docs/project-martian.md#radar-deployment-and-activation); X and Reddit remain disconnected until credentials are supplied. `MARTIAN_RADAR_MODE=sample` preserves the existing labelled examples; `live` reads only the new public projections. A live error never displays sample posts.

## Sources and publication

The worker polls enabled sources every 15 minutes. X recent search and account mentions use the official v2 API; Reddit uses OAuth listings and item lookups; In the wild accepts explicitly approved RSS/Atom feeds. The checked-in [source configuration](../config/radar-sources.example.json) contains editable keyword queries and subreddit lists, all disabled. Feed URLs, X mention user ID, permissions and approval names must be completed before enabling a source. There is no HTML page scraper. The first selected feed is the publisher-linked [Google Security RSS](https://blog.google/security/rss/). It supplies short excerpts and original article links. Only direct RSS/Atom title and excerpt fields contribute text; nested media captions and author metadata are excluded. One feed publisher counts as one source account, so its own articles cannot establish cross-author independence.

LinkedIn API ingestion is disabled. Its [restricted-use rules](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases) conflict with a public social feed. Send to Radar accepts LinkedIn links and submitter text as private tips for human review, without fetching the link or publishing its contents. A tip does not become a Radar post. This deliberately narrows the PRD's LinkedIn requirement.

X source display preserves author name, handle, avatar, original text, linked timestamp and View on X. Radar does not anonymize or redact X posts; unsafe items stay private or are removed. Sharing opens a user-reviewed draft and never publishes automatically. See [X display requirements](https://docs.x.com/developer-terms/display-requirements). Approved Reddit access and feed republication rights remain operator prerequisites.

Each source has an immutable ID/configuration, a bounded retention period and a persistent daily request allowance. Use a new ID after changing its query, subreddit, feed URL or mention account; this prevents reusing approval or pagination state. The `sources` command updates only listed IDs, so explicitly set `enabled:false` to disable an existing source. Sources are never enabled by a Helm flag alone.

## Pipeline and evidence limits

1. Validate source data, remove tracking parameters for duplicate comparison, fold exact/canonical-link duplicates and text with trigram Jaccard similarity above 0.90. X reposts and model-classified reshare quotes point to their originals and do not inflate cluster counts. Substantive quote commentary is vetted separately; sharing a cited article does not itself make two accounts duplicates. X-provided expanded links inform classification; arbitrary short-link following is not implemented.
2. Apply the versioned rules scorer: required agent term; harm +0.4, catalog name +0.2, evidence +0.2, declared researcher +0.1, new account −0.3, short unevidenced text −0.2; recognized promotion drops. An optional `researcher_ids` list in each approved source config supplies known platform author IDs; adapters do not infer prior researcher history. Reddit account age remains unknown. Media and simple credential/contact detections cause a hold before inference.
3. Claude returns strict relevance, plausibility, claim, taxonomy, evidence, flags, confidence and reason fields. Any flag holds; irrelevant/implausible or confidence below 0.5 drops; 0.5–0.79 holds; 0.8+ publishes as Unverified. Quoted/replied-to text is untrusted context. Model calls have no browsing or execution tools. Model errors become `processing-error`, requiring explicit reprocessing.
4. Embed eligible claims with Titan Text Embeddings v2 (1,024 dimensions). Match an active 72-hour cluster at cosine ≥0.82 with a shared attack, company, model or harness. Titles are generated from at most 32 claims and refreshed when membership doubles. Unsafe titles stay hidden. A same-claim spike dominated by known new accounts is held for review; this heuristic does not establish independent people or prevent all coordination.

The heat calculation is `N6 / (N48 / 8 + 1) × platform multiplier × author multiplier × evidence multiplier`. Multipliers are 1/1.3/1.5 for one/two/three-plus platforms, 0.5 below three distinct platform accounts, and 1.2 for a reviewed primary source or screenshot. Counts exclude folded reshares. The top five clusters require five posts and three accounts in the last 72 hours. No new post for 12 hours means Cooling; 72 hours means Faded and removal from the hotspot card. Feed search and direct links remain available only while source permission, verification and retention allow; Radar is not a permanent social archive. A linked record is shown separately from activity state.

Detail ranks human-reviewed primary sources first, then the earliest report, other first-hand reports and remaining items. It includes the 72-hour platform mix, distinct accounts, first seen, 24-hour velocity against the preceding day and a folded-reshare count. Linking a cluster to a current incident makes its visible posts Linked. Linking does not create an incident or verify every assertion in a cluster.

The UI preserves the light desktop feed-left/detail-right layout. Search, pagination, source availability, provenance, report and share controls read the live API. Stable links use `#signals/post/UUID` and `#signals/cluster/UUID`. Source attribution is not a declaration that its claims are true.

## Storage, deletion and boundaries

Migration `003_radar.sql` creates `radar_private` and `radar_public`, outside the public schema's blanket reader grants. Private tables hold source configuration, original content, decisions, embeddings, intake, quotas and worker status. Security-barrier views expose only enabled, published, unflagged posts whose verification and retention have not expired. Global publication defaults off. Migration 004 keeps intake disabled when a restored database has no private control row; 005 prevents a quote/reply from exposing context whose known source has expired or been disabled.

| Credential | Permission |
| --- | --- |
| `project_martian_app` | Public views and existing incident reads; no private Radar access |
| `project_martian_radar_worker` | Collection, decisions, clusters and cleanup; no incident writes or publication-control changes |
| `project_martian_radar_reviewer` | Private review and audited post/cluster decisions; no source/control changes or incident writes |
| `project_martian_radar_intake` | Execute a single insertion function; no private reads or direct table writes |
| `project_martian_radar_backup` | Read/dump schemas; kept out of the web/worker and used with private table data excluded |
| `project_martian_owner` | Migrations, role provisioning, source approval and global controls |

Only one worker runs, enforced by a database advisory lock. Source text expires from public views no later than one hour after successful verification, even if the worker stops. Browsers poll every 30 seconds and remove loaded expired content on their next one-second timer tick; suspended tabs refresh on return. Successful source refreshes renew display eligibility, while changed content invalidates classification and review. Engagement freezes after 48 hours. Explicit deletions erase raw/model material and source-dependent quote/reply decisions, invalidate titles and retain a minimal removal tombstone until retention cleanup. Unavailable source responses do not renew display eligibility. RSS entries cease renewing after leaving the configured feed.

The worker deletes expired stored posts, their decisions and embeddings. Intake expires after seven days and rate-limit identifiers after two hours. If the worker is stopped, SQL still hides expired posts, but physical cleanup waits for worker recovery. Private Radar rows are excluded from logical backups; incident history and Radar schema definitions remain included. Old backups from before Radar contain only the historical samples. Operator reasons must not paste credentials, raw posts or private contact information.

Intake requires both a process setting and the owner-controlled database switch. The web process uses a second, function-only credential, accepts same-origin JSON, and returns a private receipt. The database enforces ten submissions/reports per hourly HMAC client identifier and 200 globally. Set `MARTIAN_TRUSTED_PROXIES` only to actual trusted proxy CIDRs; without it, proxied clients share the direct peer's quota. Never trust arbitrary forwarded headers. Intake is a queue, not automated takedown approval; meeting the 24-hour response target requires staffed review.

Source networking permits public HTTPS DNS addresses only, with no redirects, arbitrary ports, credentials in URLs or entity expansion. Bodies are capped at 2 MB and requests at 15 seconds. The worker has no inbound service. Source credentials and Bedrock identity never enter browser assets.

## Configure and run

Use the existing [database setup](usage.md#local-database), build and apply migrations as owner. The migration creates disabled login roles. Provision each required credential from a private 32–200-character password file; never put values on a command line. `PGHOST`, `PGPORT` and `PGDATABASE` below use that setup.

```sh
npm run build
PGUSER=project_martian_owner PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/owner-password" npm run db:migrate
PGUSER=project_martian_owner PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/owner-password" \
  npm run radar:manage -- provision --role worker --password-file "$MARTIAN_DB_SECRETS/radar-worker-password" \
  --actor YOUR_NAME --reason 'Provision private Radar pilot'
```

Repeat provisioning with roles `reviewer`, `intake` and `backup` only when needed, using separate password files. The owner must be allowed to create/alter these roles. Reviewer authentication is the private database login; `--actor` is a declared operator identity, not a second authentication system.

Copy the source example to a private operator file, replace placeholders and record approved access/retention. Then, as owner:

```sh
npm run radar:manage -- sources /absolute/private/path/radar-sources.json --actor YOUR_NAME --reason 'Approved source configuration'
npm run radar:manage -- controls --public off --intake off --model-calls 200 --actor YOUR_NAME --reason 'Private pilot'
```

The worker uses `PGUSER=project_martian_radar_worker`, its own `PGPASSWORD_FILE`, and `npm run radar:worker`. `-- --once` performs one full cycle. Leave `MARTIAN_RADAR_INFERENCE_ENABLED=false` for an offline/no-model run. Enable it explicitly for classification, embedding and titles. Defaults are `MARTIAN_RADAR_REGION=us-east-1`, `MARTIAN_RADAR_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0`, and fixed `amazon.titan-embed-text-v2:0`. Grant a dedicated worker identity access to those models and required inference-profile destination resources; the Ask identity/model are unchanged. The [deployed IAM policy](../deploy/radar-bedrock-policy.json) records the current profile and model resources; adjust account and profile resources for another environment.

Source credentials are file paths: `MARTIAN_RADAR_X_TOKEN_FILE`; `MARTIAN_RADAR_REDDIT_CLIENT_ID_FILE`, `MARTIAN_RADAR_REDDIT_CLIENT_SECRET_FILE`, `MARTIAN_RADAR_REDDIT_REFRESH_TOKEN_FILE`. Reddit also needs a descriptive `MARTIAN_RADAR_REDDIT_USER_AGENT` containing the responsible `/u/` account. RSS needs an approved enabled source, not a platform token. Keep all credentials out of source JSON.

Run the web app using its existing app role and `MARTIAN_RADAR_MODE=live`. Publication remains empty until the owner explicitly uses `controls --public on`. For intake, also set `MARTIAN_RADAR_INTAKE_ENABLED=true`, `MARTIAN_RADAR_INTAKE_KEY_FILE` (at least 32 characters), and the separate `RADAR_INTAKE_PGHOST`, `RADAR_INTAKE_PGPORT`, `RADAR_INTAKE_PGDATABASE`, `RADAR_INTAKE_PGUSER=project_martian_radar_intake`, `RADAR_INTAKE_PGPASSWORD_FILE`; then enable `controls --intake on`. The web process never receives reviewer, worker or owner credentials.

## Review commands

Use the reviewer credential for these commands. `queue`, `inspect`, `status` and `intake` read; all mutations require `--actor` and `--reason`. Run private-content commands only in a private operator session.

```sh
npm run radar:manage -- queue --decision held
npm run radar:manage -- inspect POST_UUID --content
npm run radar:manage -- reprocess POST_UUID --revision 1 --clear-flags uninspected-media --actor YOUR_NAME --reason 'Inspected attached media'
npm run radar:manage -- approve POST_UUID --revision 2 --actor YOUR_NAME --reason 'Reviewed complete source'
npm run radar:manage -- primary POST_UUID --revision 3 --actor YOUR_NAME --reason 'Reviewed primary evidence'
npm run radar:manage -- drop POST_UUID --revision 4 --actor YOUR_NAME --reason 'Outside agent security scope'
npm run radar:manage -- remove POST_UUID --revision 5 --actor YOUR_NAME --reason 'Author removal request verified'
npm run radar:manage -- link-cluster CLUSTER_UUID --record INCIDENT_ID --actor YOUR_NAME --reason 'Matched reviewed incident'
npm run radar:manage -- unlink-cluster CLUSTER_UUID --actor YOUR_NAME --reason 'Record match withdrawn'
npm run radar:manage -- intake --content
npm run radar:manage -- resolve RECEIPT_UUID --actor YOUR_NAME --reason 'Completed private review'
npm run radar:manage -- status
```

These UUIDs/revisions are placeholders, not a sequence to run blindly. Always inspect the current revision. `reprocess` explicitly overrides the rules cutoff; only named flags are cleared. It does not publish, and Claude can still drop/hold. Direct approval requires a valid classification, no unresolved flags and current source verification. Primary-source status is a human declaration, never automatic from Claude's kind. `inspect` suggests current incident IDs sharing an exact canonical evidence URL; it never links automatically, and semantic match suggestions are not implemented. Create/review an incident through the existing contribution/publication workflow before linking it.

## API and operational bounds

`GET /api/radar` returns a versioned sample or live response. Live accepts `source=all|x|reddit|linkedin|wild`, `q` up to 120 characters, `limit` 1–50 and an opaque cursor. It includes source health, current publication ID, posts, top clusters and next cursor. LinkedIn returns no public posts. `GET /api/radar/posts/:uuid` and `/api/radar/clusters/:uuid` return only currently visible source detail; unavailable objects return 404. `POST /api/radar/submissions` accepts a LinkedIn `url`, pasted `text` and optional `contact`; `/api/radar/reports` accepts `post_id`, `reason` and optional `contact`. Successful intake returns 202 plus a receipt. No public route exposes raw held/dropped content, model explanations or queue contents.

The first release is intentionally bounded: one X page per source/cycle with persisted pagination; newest 100 Reddit entries per listing/cycle, reporting a capacity error on a full page; up to 100 source rechecks per cycle; 200 RSS entries; 20 vetting and 20 embedding jobs per worker pass; 2,000 recent duplicate candidates; 5,000 visible clustered posts for aggregation; 500 posts in one detail response. Hitting an aggregation/detail cap gives an unavailable response rather than partial statistics. These limits and small resource allocations need measurement in the pilot. Reddit busy-listing completeness, X backlog latency and 30-minute tagged-post latency are not established.

Request allowances count HTTP calls, not returned posts or dollars. X can bill separately for returned posts/users and expansions; 192 requests/day can retrieve far more than 192 posts. Configure provider billing limits and narrow source budgets before enabling collection. The shared model allowance counts all classification, embedding and title calls, including failures; it is not an account-wide spend cap. Model failures do not bypass review. `status` exposes quota usage, source errors and worker heartbeat; `--health` checks the worker's local heartbeat. Production has a ten-call daily model allowance. RSS collection uses its own persistent allowance; X and Reddit tokens are not configured. Source requests and model usage are separate meters. Monitor held/error queues as well as the public feed; an empty feed can mean recent articles were correctly rejected.

Release steps and private-data-free backup/restore belong to the [Helm guide](../../martian-helm-charts/docs/project-martian.md#radar-deployment-and-activation). Before public activation, verify real provider payloads/edit/delete behavior, reviewed relevance/false-drop samples, complete attribution, private intake and staffed takedowns. Paid model output contracts passed the bounded foundation check; this does not establish moderation accuracy. None of the PRD's 90% relevance, <10% tagged false-drop or early-discovery targets can be claimed from compilation or an empty-feed preview.

## Verification — October 4, 2026

The initial foundation checks passed TypeScript/JavaScript validation, build and Docker image build without adding tests. The user-requested follow-up acceptance runner is documented below. Migrations 003–005 applied and their repeated checksum check passed in the existing local database. Public reads, empty worker execution under its own role, restricted grants, disabled intake, invalid-query handling and private-path denial were checked. The original sample mode still returns eight sample signals/three clusters and filters in the light desktop UI; live mode shows an empty private pilot with no browser errors. The 44-record publication remains in place. All 16 source examples validate and are disabled. Helm dependency/lint/default/Ask-disabled/Radar-enabled renders, changed documentation file links and diff whitespace checks passed.

An actual production archive backup was restored into an isolated database in the existing local PostgreSQL instance. Its full archive, analytics and Timeline exactly match the saved production response, including publication 3 and all 44 records. Both Radar schemas are included, with zero private Radar table-data entries. A separate local restore confirmed intake stays disabled when private controls are absent. The deployed web, worker and database are healthy, the backup schedule is active, and the light desktop page clearly labels samples without captured browser errors.

Claude classification, Titan’s 1,024-dimensional embedding and structured title output passed under the worker’s dedicated identity using an existing labelled sample. The initial local call exposed missing catalog enums in the model-facing schema; the deployed schema now exports those constraints. Four local attempts and three production calls establish access and contracts only. The sample was held and never ingested or published; moderation calibration is still required.

The requested follow-up verified real Google RSS collection and bounded Claude moderation, plus controlled local clustering, provenance, edits, deletion, retention and intake. All three recent RSS entries were rejected: two by rules and one by Claude as general AI-security news, so none became a public signal. This small negative sample does not establish relevance precision, tagged false-drop rates or real X/Reddit edit/delete behavior. Those provider checks wait for credentials. The existing local preview on port 8766 has separate configuration; the deployed site is the authority for activation status. The [deployment guide](../../martian-helm-charts/docs/project-martian.md#verified-foundation-release--october-4-2026) retains image provenance, migrations and release evidence.

## Requested acceptance checks

`scripts/verify-radar.mjs` is a Node.js 24 integration runner for an empty, isolated local database named `project_martian_radar_pilot_<digits>`. It refuses any other host/database and any existing posts, sources or intake. Restore the public archive into that disposable database first and provision the documented local worker/intake credentials. It uses deterministic model responses to exercise thresholds, model failure, cluster matching and heat, duplicates, provenance, edits, context expiry, removal/tombstones, retention, private receipts, quotas and role boundaries. RSS/Atom fixtures cover nested metadata. No synthetic post is sent to production.

Set the standard owner `PG*` variables, `RADAR_PILOT_WORKER_PASSWORD_FILE`, `RADAR_PILOT_APP_PASSWORD_FILE`, the documented `RADAR_INTAKE_PG*` variables and `MARTIAN_RADAR_INTAKE_KEY_FILE`, then run:

```sh
node --experimental-test-module-mocks scripts/verify-radar.mjs
```

`RADAR_PILOT_REPORT` optionally names a private JSON evidence file. The optional `RADAR_PILOT_UI_MARKER` writes the fixture post ID and pauses for desktop inspection until Enter; a separately started local web process must use the same disposable database. The runner cleans its fixtures and disables the disposable database’s publication/intake switches. Fourteen groups passed on October 4; the light desktop also rendered the primary-first source list, returned a private tip receipt and removed an expired signal/detail/hotspot without a page reload. These checks establish application behavior, not provider deletion guarantees or calibrated model quality.
