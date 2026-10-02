# Project Martian

An independent public incident publication with Trends, Microtrends, Rogue Index, Narrative, Comparison, Radar, Timeline and Bedrock Ask. Source: [Project-Martian/Project-Martian](https://github.com/Project-Martian/Project-Martian).

A Node.js application serves the existing HTML/CSS/JavaScript desktop UI and same-origin APIs. Its dedicated PostgreSQL database owns published records, source links, timelines, company/model relationships, Radar data and display settings. The frontend reads the API. Initial JSON files are import seeds, not live data stores.

Production uses one application pod and one PostgreSQL pod in its own `project-martian` EKS namespace, with persistent storage and off-cluster backups. It has no Martian Security API, database, authentication or customer-data dependency. The cluster and ingress controller are shared infrastructure.

See [architecture and data ownership](docs/architecture.md), [local setup and publishing](docs/usage.md), [Rogue Index scoring and review](docs/rogue-index.md), [Microtrends mapping and review](docs/microtrends.md), [Narrative and Comparison](docs/narrative-comparison.md), [Ask and guardrails](docs/ask.md), [contributing](CONTRIBUTING.md) and [publication principles](MANIFESTO.md). The separate [Helm deployment guide](../martian-helm-charts/docs/project-martian.md) owns cloud prerequisites, releases and restore operations.

Use Node.js 24 and PostgreSQL 18. After [database setup](docs/usage.md#local-database), run `npm ci`, `npm run build` and `npm start` with the documented database variables; open `http://127.0.0.1:8766`. Static-file previews cannot load the database-backed publication. Ask additionally requires the existing AWS login.

Automatic database failover, cluster NetworkPolicy enforcement and backup alert delivery are outside the approved current scope.

Rogue Index v1 implements incident impact scoring and a fixed-reference monthly index with the existing desktop chart. Microtrends derives maker/model/attack paths from source-linked record mappings, controlled catalogs and review history. The initial 44 assessments and 44 mappings are unreviewed drafts. An explicitly authorized draft release keeps that status visible; deployment approval does not count as human evidence review. See the Helm deployment guide for the verified live release.

Narrative and Comparison implement audited disclosure sources, three account-development stories, and monthly or cumulative record counts by landing. Source chronology and operating context cover the 23 agent records; human review is pending. See the Helm deployment guide for the verified release and owner-only publication procedure.
