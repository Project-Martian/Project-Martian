# Usage and publishing

Use Node.js 24 and Docker with PostgreSQL 18. Environment variables are explicit; the process does not automatically load `.env.example`. Preserve the approved light desktop UI.

## Local database

For a fresh setup, generate two passwords outside the repository. These commands refuse to replace existing credentials. Keep them for the lifetime of the volume; changing a password file alone does not rotate the database role.

```sh
export MARTIAN_DB_SECRETS="$HOME/.local/state/project-martian/dev"
mkdir -p "$MARTIAN_DB_SECRETS"
chmod 700 "$MARTIAN_DB_SECRETS"
(umask 077; set -C; openssl rand -hex 32 > "$MARTIAN_DB_SECRETS/owner-password")
(umask 077; set -C; openssl rand -hex 32 > "$MARTIAN_DB_SECRETS/app-password")
# Files must be readable by the postgres UID through the read-only mount.
# The containing host directory remains private.
chmod 444 "$MARTIAN_DB_SECRETS/owner-password" "$MARTIAN_DB_SECRETS/app-password"
docker volume create project-martian-postgres-local
docker run -d --name project-martian-postgres-local \
  -p 127.0.0.1:5438:5432 \
  -e POSTGRES_USER=project_martian_owner -e POSTGRES_DB=project_martian \
  -e POSTGRES_PASSWORD_FILE=/run/database/owner-password \
  --mount type=volume,src=project-martian-postgres-local,dst=/var/lib/postgresql \
  --mount "type=bind,src=$MARTIAN_DB_SECRETS,dst=/run/database,readonly" \
  --mount "type=bind,src=$PWD/db/bootstrap-app.sh,dst=/docker-entrypoint-initdb.d/01-app-role.sh,readonly" \
  postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650
docker exec project-martian-postgres-local pg_isready -U project_martian_owner -d project_martian
```

Wait for `pg_isready` to succeed before running migrations. The bootstrap creates the read-only login on the empty volume; migrations grant its table permissions. For a previously initialized container use `docker start project-martian-postgres-local`, retaining the original volume and credentials. Do not delete the volume to restart the app.

The October 2 workstation setup already uses this container/volume and port. Its credentials are in `~/.local/state/project-martian/architecture-20261002/local`, so use that directory as `MARTIAN_DB_SECRETS` on this workstation. Do not repeat fresh initialization over it.

```sh
npm ci
npm run build
export PGHOST=127.0.0.1 PGPORT=5438 PGDATABASE=project_martian
PGUSER=project_martian_owner PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/owner-password" npm run db:migrate
PGUSER=project_martian_owner PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/owner-password" npm run db:import
export PGUSER=project_martian_app PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/app-password"
aws login --profile martian
AWS_PROFILE=martian AWS_REGION=us-east-1 npm start
# Open http://127.0.0.1:8766
```

Use `MARTIAN_ASK_ENABLED=false npm start` when developing without inference. Every publication view still requires PostgreSQL. `PORT` defaults to 8766 and `HOST` to 127.0.0.1 locally. The container defaults to 0.0.0.0:8080. `/healthz` checks the process; `/readyz` checks database publication availability. A database failure produces an unavailable response, never a stale JSON replacement.

## Local preview lifetime

Keep the foreground process running, or use a systemd user service with the same database environment. Stop the old Python preview first if it already owns the port, then start the new implementation:

```sh
systemctl --user stop project-martian-preview.service
systemd-run --user --unit=project-martian-preview \
  --description='Project Martian Node preview' \
  --property="WorkingDirectory=$PWD" \
  --setenv=PGHOST=127.0.0.1 --setenv=PGPORT=5438 \
  --setenv=PGDATABASE=project_martian --setenv=PGUSER=project_martian_app \
  --setenv="PGPASSWORD_FILE=$MARTIAN_DB_SECRETS/app-password" \
  --setenv=AWS_PROFILE=martian --setenv=AWS_REGION=us-east-1 \
  "$(command -v node)" "$PWD/dist/backend/app.js"
systemctl --user status project-martian-preview.service --no-pager
```

This transient service survives the launching terminal but is not enabled at boot and has no restart policy. The database container must also be running. Rebuild and restart the preview after backend edits. Credentials remain in the existing local AWS profile; renew its login when expired.

## Desktop navigation

The header and footer Project Martian titles link to `https://projectmartian.ai/`, opening a fresh Ask homepage. Use the Ask tab to return to the current conversation without reloading it. After the first question, the follow-up chatbox stays within the Ask section and above the footer; see [Ask interaction](ask.md#desktop-chat-interaction).

The homepage totals use the same published archive as Timeline: all records, agent incidents, and agent records whose archive date falls in the current UTC year. Unknown archive dates are excluded from the year count. **Timeline updated (UTC)** shows the latest successful publication date; the note below includes its exact timestamp and publication ID. It reflects successful publication of approved contributions, including records whose occurrence date is unknown. It is not an incident date or the time research last ran. Use **View Timeline** to inspect incident/disclosure dates; reload after an approved contribution publishes to see updated totals. Pending GitHub drafts and Radar chatter are not included.

Trends includes the publication month and newer dated records using the shared [display calendar](architecture.md#api-and-presentation). Reloading after a publication updates Rogue Index, Comparison and Microtrends together; no manual September-to-October calendar edit is needed. Timeline continues to show the full snapshot, including unknown dates, with occurrence and disclosure evidence kept separate.

Each Trends tab has an information (`i`) icon: Microtrends explains maker/model/attack connections, Rogue Index explains recorded impact scoring, Narrative explains disclosure sources and account updates, and Comparison explains counts by where effects landed. Hover over an icon or focus it with the keyboard to reveal its tooltip without clicking or changing the selected view. The tooltip stays open while the pointer is over its text; move away, move keyboard focus away, or press Escape to dismiss it. The descriptions summarize the [mapping](microtrends.md), [scoring](rogue-index.md) and [context](narrative-comparison.md) guides; they do not change the data or review status.

### Finding an approved contribution

A successful receipt and the current archive must agree: check `/api/archive` publication metadata and the incident content. IDs are strings in JSON but are selected numerically in PostgreSQL. If a receipt points to a newer revision that is absent from the current archive, investigate snapshot selection before approving again or creating a duplicate.

1. Open the [production contribution checker](https://www.projectmartian.ai/#contribute) and enter the issue number. Its receipt is also available at `https://www.projectmartian.ai/api/contributions/N`. A receipt records a successful database commit; a GitHub approval alone is not that receipt. The publisher polls every five minutes, and the page needs reloading after publication.
2. Use the checker's **View incident** link. For a newly added issue, the direct route is `https://www.projectmartian.ai/#timeline/github-issue-N`. Check the hostname: a preview on `127.0.0.1` or `localhost` reads its configured database, which can have different records and publication IDs. Production approvals do not synchronize a local database.
3. Timeline defaults to **Date view → All dates**, showing occurrence, checked disclosure and archive dates together. It orders each record by the latest known date across those types, using the start of a range; records without any known date remain in **Unknown**. Every date view includes all records matching the search and maker/scope filters, so clear those filters if necessary. **Archive order**, **Occurrence** and **Checked disclosure** remain available to inspect one date type. **Checked disclosure** uses the earliest dated source checked for a record, not the date it was added to this publication. Unknown occurrence dates remain explicitly unknown in **All dates**.
4. In Microtrends, clear maker/attack filters and choose **All time** when looking for undated records. Date-limited views exclude records without a usable archive date; approving them does not create an occurrence date.

On October 11, issue #13's production receipt confirmed publication 6 at `2026-10-11T09:35:40.702Z`, with 47 records. The separate preview still had 44 records and an OpenAI filter. The published Anthropic record appeared under October 9 with **Checked disclosure**. These are observed snapshots, not expected permanent counts. If there is no production receipt after a scheduled run, inspect the issue-specific publisher error before changing the draft or asking for another approval.

## Substack Blog

Open **Blog** in the header or footer, or visit `/#blog`. It lists the public archive of [projectmartian.substack.com](https://projectmartian.substack.com), newest first, with titles, dates, subtitles and available cover images. **Load older posts** continues through the archive in pages of 20 without a fixed total-post limit. **Read on Substack** opens the original article, where Substack applies any subscriber access requirements. **Subscribe on Substack** opens its subscription page; Project Martian does not collect subscription details.

Publish and edit articles in Substack as usual; no repository or database import is required. The first visit to Blog loads posts, and **Refresh posts** reloads from the server. Each successful server page is cached for up to five minutes, so publishing or editing a post can take that long to appear on a later refresh. An already open page does not poll in the background. Refresh starts from the newest page; older pages remain live Substack pagination rather than an immutable snapshot.

The Node service requires outbound HTTPS to `projectmartian.substack.com`. There is no API key or new environment variable. An empty archive shows an explicit no-posts state; failed requests show an unavailable message and leave the Substack link visible. Drafts and private posts not exposed in Substack's public archive cannot be listed. On October 12, 2026, the supplied publication's public archive and RSS feed both returned no posts, so live populated-post coverage could not be verified. Deploy the application image through the existing Helm release procedure; no new Helm settings or database migrations are required.

## Publishing data

PostgreSQL owns current data. The JSON seed files are only the original import, and application deployment never overwrites later publications. Export from the application role, review the complete document, then publish using the owner role:

```sh
node dist/backend/manage.js export > /path/to/reviewed-publication.json
# Edit and review records, source metadata, mappings, settings and Radar sample flags.
PGUSER=project_martian_owner PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/owner-password" \
  node dist/backend/manage.js publish /path/to/reviewed-publication.json \
  --actor YOUR_OPERATOR_NAME --reason 'Reviewed correction with source references'
```

Use `node … export`, not `npm run db:export > file`, because npm's script banner would corrupt the JSON. Every publish requires an actor and reason and creates a complete immutable revision in one transaction. Prior publications are preserved. Removed IDs disappear from the current view but remain in historical SQL rows. Reload the website to read the new snapshot. There is no web editor; the optional GitHub publisher below is implemented but requires separate activation.

Production publication uses a short-lived operator Job with the same pinned application image, owner-password Secret, database environment, `projectmartian.ai/database-client: "true"` label, and no Bedrock identity. Supply the reviewed JSON through an explicitly managed input volume. Never mount the owner credential in the web application or publish through `/api/ask`. A Git push alone changes neither the live database nor the deployed image.

The CLI validates identifiers, dates, source URLs, references and display-calendar bounds. Impact publications additionally require a complete assessment for every record and explicit review mode. Reviewed mode requires a current approval (two distinct reviewers for Severe); stale approvals and unresolved disputes are rejected. An explicitly authorized draft publication requires `--allow-draft` and visibly labels the chart; deployment authorization never creates evidence-review approvals. These are structural and declared-review checks, not fact checking or authentication of reviewer identities. See [Rogue Index preparation and review](rogue-index.md#prepare-and-review).

Microtrends publications additionally validate catalog membership, maker/model/version pairs, named-model quotations, cited source URLs, scope/attack-family compatibility and exact generated-map consistency. Reviewed mode requires current declared approval for every mapping; drafts require the same `--allow-draft` flag. Use the [mapping preparation, build and review workflow](microtrends.md#prepare-review-and-publish) after editing record maps.

Narrative and Comparison publications additionally validate context coverage for every agent record, occurrence precision, checked source chronology, development citations and context reviews. Use the [context preparation and review workflow](narrative-comparison.md#prepare-review-and-publish). Any draft impact, mapping or context review mode requires `--allow-draft`; their approvals remain independent. Building the application does not apply the checked-in audit to PostgreSQL.

## Contribution worker

Follow [maintainer review and publication](../CONTRIBUTING.md#maintainer-review-and-publication) for manual proposals, or [research approval](../CONTRIBUTING.md#daily-research-contributions) for automated drafts. Run migrations through `006_research_contributions.sql` before starting this publisher. Migration 002 creates receipts; 006 makes a proposal comment optional for research issues and adds the review protocol, immutable research draft and unique research-payload hash. Existing records and publication hashes do not change during migration.

The worker requires a separate GitHub token file, limited to Issues-read and Metadata-read on `Project-Martian/Project-Martian`. It performs only GitHub reads and never uses the browser's credentials or `gh` login automatically. Use the owner role only for the explicit publisher command:

```sh
# This can publish approved research issues or eligible completed manual proposals.
# Run only against the intended database.
PGUSER=project_martian_owner PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/owner-password" \
  MARTIAN_GITHUB_TOKEN_FILE=/path/outside/repository/github-token \
  node dist/backend/contribution-manage.js sync --issue 12
# Omit --issue to scan research issues and completed manual proposals.
```

`propose`, `check` and `format` use local public JSON files and need no database owner credential or GitHub token. `sync` verifies current GitHub review permissions, then atomically publishes and records the issue receipt. Research issues publish on valid approval comments alone; legacy manual proposals still require completion. There is no automatic fact checking. Malformed, unapproved, stale or unsupported proposals fail closed; failed issue processing exits nonzero while independently eligible issues may succeed. Normal later scheduled scans repeat checks for issues without receipts. Owner/passwords and the GitHub token are never mounted in the web pod. The [Helm guide](../../martian-helm-charts/docs/project-martian.md#github-contribution-publication) owns deployment and operational prerequisites; this change does not enable production polling.

## Daily research worker

The private researcher uses the SELECT-only `project_martian_app` database credential, its own Bedrock workload identity and two file-based credentials: `MARTIAN_RESEARCH_TAVILY_TOKEN_FILE` and `MARTIAN_RESEARCH_GITHUB_TOKEN_FILE`. The GitHub token needs **Issues: write** and **Metadata: read** only on `Project-Martian/Project-Martian`; the publisher keeps its separate read-only GitHub token and owner database credential. Neither research credential belongs in the web process. The default model is Claude Haiku 4.5 through its US inference profile from `us-east-1`, independently configurable with `MARTIAN_RESEARCH_MODEL_ID` and `MARTIAN_RESEARCH_REGION`.

The [source configuration](../config/research-sources.json) contains two queries, a three-candidate limit and a two-new-issue limit. Search uses the past week on each daily run; it is not an exhaustive historical backfill. Each candidate gets one bounded follow-up search, up to four extracted pages, one drafting/correlation call and one independent review call. The default maximum per run is **five Tavily searches, three extraction requests (up to twelve URLs), six Bedrock calls and two issues**. These are request limits, not a currency budget or a persistent daily quota; additional manual runs can incur additional charges. Model requests use [Bedrock JSON-schema response output](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html) for a small decision envelope. A new record is JSON-encoded inside that envelope, parsed, and checked against the complete local record schema and publication rules before any issue write; each call has a three-minute deadline, including first-use schema compilation. No source/model call or issue write is retried automatically. Review Tavily and Bedrock account budgets before activation.

```sh
npm run build
# Offline configuration and schema validation: no network or inference.
npm run research -- check-config config/research-sources.json
# Uses real Tavily and Bedrock APIs, but creates no issues. Output contains public draft evidence.
MARTIAN_RESEARCH_ENABLED=true npm run research -- run config/research-sources.json --dry-run
# Uses the same research APIs and creates eligible review issues.
MARTIAN_RESEARCH_ENABLED=true npm run research -- run config/research-sources.json
```

Use the documented read-only database environment and credential file paths before the latter two commands. Research defaults disabled. A database advisory lock prevents overlapping research processes. The worker checks the complete archive/issue inventory, fails if it exceeds 600 items, and bounds each issue's model context to 5,000 characters with truncation labelled. Exact source matches still inspect complete issue bodies. It skips known source/title matches, holds uncertain semantic matches and unavailable sources, and re-reads the inventory before independent review. Extracted text is limited to 24,000 characters per page and labelled when partial; only supplied excerpts may support the draft. Private-address URLs, unexpected extraction URLs, unsupported quotes, unsafe draft content and invalid schemas block issue creation. Tavily performs source extraction remotely; the worker contacts only the fixed Tavily/GitHub APIs and Bedrock.

Before issue creation, all citations are checked against the URLs successfully extracted for that candidate. Supporting quotations are selected by passage ID from exact excerpts of at most 240 characters, then copied by the worker. Date/URL formats and the complete passage-ID catalog are enforced locally after inference to keep the provider grammar bounded. Full local validation still checks quotation length, exact evidence text and the relationships between citations and annotations. Held and failed candidates are recorded in Job logs with their source URL and processing stage; they are not public contribution issues or a durable review queue. An unknown GitHub write outcome must be inspected before rerunning; the next run checks existing issue bodies and does not blindly repeat the write. Inference is probabilistic, and external GitHub writes cannot share a transaction with PostgreSQL. Source/semantic correlation therefore reduces duplicates without proving universal novelty. Publication again checks sources/titles inside its database transaction, and each issue/research-payload hash can publish only once.

Daily scheduling and Secret mounts live in the [Helm deployment guide](../../martian-helm-charts/docs/project-martian.md#daily-research-contributions). Production runs daily at 09:00 Asia/Kolkata following the October 5 release. The credentialed pilot verified Tavily extraction and model correlation against the live archive, matching two reports to existing incidents and holding a candidate whose sources could not all be extracted. On October 5, a later held ICT&health lead was reviewed by the operator and narrowed to the previously unlisted Mayo Clinic probe report. [Issue #8](https://github.com/Project-Martian/Project-Martian/issues/8) contains that operator-assisted draft in the research protocol, with no invented human reviews. Its exact GitHub body passed schema, publication, duplicate-source/title and round-trip hash checks; the initial receipt correctly reported unpublished. This is not evidence that the automated drafting error was fixed. The scheduled publisher at 12:45 UTC detected issue #8 and returned `not-approved-for-publication`; the receipt stayed unpublished and the full archive response remained unchanged. After maintainer approval, its production receipt recorded publication 4 at `2026-10-05T19:20:07.970Z`; the receipt was checked again on October 11. Approval-to-publication is therefore verified for that real contribution. Do not create synthetic public incidents for verification.

## Verification

```sh
npm run check
npm run build
npm audit --omit=dev
git diff --check
```

Run the app against the local database and check the archive, trends, mappings, Radar, Timeline and Ask flows. Compare record content and calculations before a data migration. Exercise migration/import idempotency and read-only application permissions. No new test infrastructure is introduced by this migration.

The 16 existing Python tests can still be run with `.venv/bin/python -m unittest discover -s tests`; they check the historical Python implementation only. Its October 1 live-language/browser evidence is preserved in the [previous deployment checkpoint](../../martian-helm-charts/docs/project-martian.md#bedrock-ask-deployment-and-idle-connection-correction--october-1-2026), not proof of the Node port. Current runtime and restore checks belong in the October 2 deployment checkpoint.

## Responsive interface verification

The October 11 source reconciliation preserves migrations 006–012 byte-for-byte because their checksums are already recorded in deployed databases. It also retains the deployed research worker, hourly discovery, saved Radar history and disabled public intake.

The October 11 integration keeps the current live Radar module and applies Enter/Space selection and focus preservation to its cards and the separate sample renderer. The viewport evidence below is from the original October 2 PR; it is not a repeat verification of the integrated release.

Run `npm run check`, `npm run build` and `git diff --check`, then start the database-backed app. Use `MARTIAN_ASK_ENABLED=false` for interface checks that do not need inference. Check both `/` and `/project-martian-standalone.html`; rebuild and reload after source changes.

The October 2 mobile usability check used an isolated PostgreSQL 18 database with the 44 public seed records and a read-only application role. Browser checks covered all seven sections and all four Trends views at widths of 320, 390, 768 and 1280 pixels on both the main and generated standalone pages (88 combinations). They checked document overflow and that the contribution form and guide did not overlap. Additional interaction checks covered:

- All mobile navigation entries and 44px navigation targets; theme switching; arrow navigation, wrapping and End; skip-to-content focus without changing the current section.
- Incident search, explanation steps, dialog focus containment and restoration, and Radar keyboard selection.
- Microtrends keyboard selection, zoom/reset, page scrolling over the map and explicit map dragging.
- Horizontal line-chart scrolling and Rogue Index detail activation; enabled and disabled Ask controls, without invoking a model.
- Conversation wrapping, the phone input dock and citation navigation using a clearly labelled local HTTP response fixture; the fixture forwards public archive/assets and replaces only Ask configuration/responses. This verifies the browser rendering path, not the model service.
- Contribution source validation and local issue preparation, without submitting a GitHub issue.

Screenshots: [phone homepage](screenshots/mobile-home.jpg), [contribution before](screenshots/mobile-contribute-before.jpg), [contribution after](screenshots/mobile-contribute.jpg), [mobile map](screenshots/mobile-trends.jpg), [mobile line chart](screenshots/mobile-index.jpg), [explanation dialog](screenshots/mobile-dialog.jpg), [conversation fixture](screenshots/mobile-chat-fixture.jpg), and [desktop homepage](screenshots/desktop-home.jpg). These show the local review environment; homepage captures use enabled Ask configuration, without invoking inference. Physical-device, screen-reader and live Bedrock inference checks remain separate follow-ups; browser viewport checks do not establish those results.

## Container

For a release from an already approved clean source commit, run commands from this repository. Commit and Git push require separate authorization:

```sh
SHA=$(git rev-parse HEAD)
REGISTRY=323022619236.dkr.ecr.us-west-1.amazonaws.com
docker buildx build --platform linux/amd64 --load \
  --label org.opencontainers.image.source=https://github.com/Project-Martian/Project-Martian \
  --label org.opencontainers.image.revision="$SHA" \
  -t "$REGISTRY/project-martian:$SHA" .
aws ecr get-login-password --profile martian --region us-west-1 \
  | docker login --username AWS --password-stdin "$REGISTRY"
docker push "$REGISTRY/project-martian:$SHA"
```

The ECR repository enforces immutable tags. Pin the pushed image digest in the separate Helm repository's `environments/project-martian/production.yaml`; its `docs/project-martian.md` owns install, DNS and removal commands. A GitHub push does not deploy automatically.

An explicitly approved release can instead use an uncommitted runtime snapshot. Copy only the Docker build inputs into a separate build directory, exclude credentials, virtual environments and bytecode, and retain a manifest of relative paths, modes and SHA-256 hashes. The snapshot's `source_sha256` hashes the file list in path order using sorted JSON keys and compact separators; timestamp and base-revision metadata are outside that hash. Label the image with that hash and the base revision plus `-dirty`. Use a unique immutable snapshot tag and pin its ECR digest in Helm. Never label such an image as a clean Git commit. The October 1 releases use this method; their provenance and verification are recorded in the Helm deployment guide. No Git commit or push was part of that deployment.

The container serves on port 8080 and runs as UID/GID 101. Public assets, compiled backend and taxonomy catalogs, migrations and import seeds are included; only public assets have static routes, and unknown paths return 404. Assets use revalidation because their filenames are not content hashes. API responses use `no-store`. Do not put AWS credentials in the image or browser. The independent chart defaults Ask off; production values explicitly enable it with the API image and dedicated workload role. The chart's pod-local TCP keepalive settings and the application's SDK keepalive setting must be deployed together for idle connections through AWS NAT. See the Helm deployment guide for release commands and current production checks.

## Radar operation

The default `MARTIAN_RADAR_MODE=sample` preserves labelled examples. Set `MARTIAN_RADAR_MODE=live` to use the new operational API; it remains empty while publication is disabled. Migration 003 creates separate collector, reviewer, intake and backup roles. Follow [Radar configuration and review](radar.md#configure-and-run) for source approval, role provisioning, separate worker startup, budgets and private intake. Do not run a worker with the owner or web credential. Existing incident publish/import/export commands do not transfer Radar operational rows.

Chart 0.8.4 includes Radar records, source settings and spending state in the encrypted database backup; private tip intake remains excluded. Source `save_history:true` preserves fetched candidates and moderation decisions beyond their collection window. The feed keeps a four-line saved preview with author, original link and last-check time when X checks expire; current badges/likes remain hidden until refreshed. Read the [deployment and restore sequence](../../martian-helm-charts/docs/project-martian.md#radar-deployment-and-activation) before upgrading an environment. Production runs live Radar through an hourly Tavily and verified-author X discovery CronJob; Reddit awaits provider approval. Public intake is disabled and the site has no tip/report/share controls. The worker uses source-credit and inference limits recorded in the deployment guide. The daily Timeline researcher and five-minute approval publisher keep their separate schedules. The public feed can be empty when no fetched post or article passes moderation; rejected posts are not replaced with examples. The [Radar acceptance runner](radar.md#requested-acceptance-checks) documents the isolated local validation command.
