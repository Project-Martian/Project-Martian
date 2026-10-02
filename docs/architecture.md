# Architecture and data ownership

Project Martian is an independent public publication. One Node.js 24 / Fastify process serves the plain HTML/CSS/JavaScript frontend, read APIs and Bedrock Ask. One PostgreSQL 18 database stores its public evidence and publication history. Neither connects to Martian Security's customer API, Wiki, databases or credentials. Helm resources live in the separate `martian-helm-charts/charts/project-martian` chart.

## Publication flow

`db/migrations` owns the schema. The operator CLI applies checksum-checked migrations and imports `data/records.json` plus `data/publication-seed.json` once. The import is transactional and records its content hash; subsequent imports with identical seeds do nothing, and changed seeds are rejected. Application startup never imports or modifies data.

PostgreSQL is the runtime source of truth. A publication contains an actor, reason, timestamp, content hash and display settings. Each publication writes a complete set of incident revisions. Stable incident IDs link revisions; sources, ordered source citations, timeline events, organizations, systems and incident/system relationships have separate tables. Existing descriptive fields, including the text `impact`, remain preserved in revision JSON. Radar signals and clusters retain explicit sample flags. Source dates are preserved as reported labels; they are not independently established disclosure dates.

The operator exports a publication, edits and reviews it, then explicitly publishes a new version. A transaction and advisory lock prevent partial or interleaved publication. Old revisions remain available in SQL; the public API reads the latest committed publication in a read-only repeatable-read transaction. A running page retains its loaded snapshot until reloaded. Ask reads one current database snapshot per request and returns its publication ID. No per-process incident cache or static-data fallback is used.

The application role `project_martian_app` has SELECT access only. The separate `project_martian_owner` role is reserved for bootstrap, migrations and operator publication. There is no public write API, admin screen, automatic source ingestion, reviewer assignment or factual verification system. Publication history records operator changes; it does not prove that an incident claim is true. Future Rogue Index assessments can build on these stable identities and revisions.

## API and presentation

| Route | Data |
| --- | --- |
| `GET /api/archive` | One consistent publication: records, metadata, mappings, Radar and analytical series; frontend entry point |
| `GET /api/incidents` | Current publication and all records |
| `GET /api/incidents/:id` | One current record, or 404 |
| `GET /api/trends` | Rogue Index, Narrative, Comparison and sidebar series |
| `GET /api/microtrends` | Curated incident/system/action mappings and display date |
| `GET /api/radar` | Stored signals/clusters with sample flags |
| `GET /data/records.json` | Current records as JSON from the database, for compatibility |
| `GET /healthz` | Process health |
| `GET /readyz` | Database reachable and at least one publication present |
| `GET /api/config`, `POST /api/ask` | [Ask contract](ask.md) |

The browser renders, filters and navigates the returned snapshot. Shared analytical calculations run in `backend/analytics.ts`; Microtrends interaction and layout remain in `js/app.js`. HTML, CSS, logo assets and editorial interface text remain source-controlled. `js/records.js` is removed. The standalone HTML embeds assets but still loads `/api/archive` and requires the Node service.

The migration deliberately preserves `legacy-setting-v1`: setting weights 3/2/1, three-month rolling values normalized to the archive peak, Jan 2025–Sep 2026 chart range and the Sep 28, 2026 Microtrends display date. Narrative uses the existing URL-based source categories; Comparison retains its illustrative projection. Radar retains eight illustrative posts and three sample clusters, alongside recent incident rows derived from records. These are not live social monitoring, a calibrated risk measure or the proposed thesis implementation.

## Runtime boundaries

Production has one application Deployment replica and one PostgreSQL StatefulSet replica, with a retained 10 GiB encrypted gp3 volume. Migration and backup Jobs create temporary additional pods. The app requests 250m CPU/256 MiB, limited to 1 CPU/512 MiB; PostgreSQL requests 250m/512 MiB, limited to 1 CPU/1 GiB. Its application connection pool is five, and PostgreSQL permits 30 connections. This small single-instance setup has downtime during database failure or maintenance and no automatic database failover. For the approved current project scope, automatic failover, cluster NetworkPolicy enforcement and backup alert delivery are not required; they are not release blockers or planned work for this phase. Existing persistent storage and daily backups remain in place.

Only the application Service is exposed through the dedicated ALB. Database credentials are existing Kubernetes Secret files, never browser variables or Helm values. Migrations use the owner credential; the app and dump Job use the read-only credential. The backup uploader has a separate S3-only workload role. Daily logical backups leave the cluster for a dedicated encrypted private S3 bucket. Retained EBS storage is not a backup. The [deployment guide](../../martian-helm-charts/docs/project-martian.md) records actual backup/restore checks and the current CNI NetworkPolicy limitation.

Ask uses the AWS SDK for JavaScript with the dedicated Bedrock-only IRSA role, or the existing local AWS profile. It binds private in-process MCP tools to a single database snapshot. There is no public MCP endpoint, source browsing, arbitrary SQL or model-directed write capability. Questions and public evidence reach Bedrock. [Ask](ask.md) owns model limits and probabilistic review boundaries. Only `css`, `js`, `assets` and named HTML entry points are served as static files; backend source, bootstrap seeds and credentials are not public routes.

`backend/` is the active TypeScript backend; `package-lock.json` pins dependencies. The earlier `server/`, `requirements.txt` and existing Python tests are retained as historical implementation/reference files. They are excluded from the Node container, and their passing tests do not validate the new Node runtime.
