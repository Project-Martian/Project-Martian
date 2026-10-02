# Project Martian

An independent public incident publication with Trends, Microtrends, Rogue Index, Narrative, Comparison, Radar, Timeline and Bedrock Ask. Source: [Project-Martian/Project-Martian](https://github.com/Project-Martian/Project-Martian).

A Node.js application serves the existing HTML/CSS/JavaScript desktop UI and same-origin APIs. Its dedicated PostgreSQL database owns published records, source links, timelines, company/model relationships, Radar data and display settings. The frontend reads the API. Initial JSON files are import seeds, not live data stores.

Production uses one application pod and one PostgreSQL pod in its own `project-martian` EKS namespace, with persistent storage and off-cluster backups. It has no Martian Security API, database, authentication or customer-data dependency. The cluster and ingress controller are shared infrastructure.

See [architecture and data ownership](docs/architecture.md), [local setup and publishing](docs/usage.md), [Ask and guardrails](docs/ask.md), [contributing](CONTRIBUTING.md) and [publication principles](MANIFESTO.md). The separate [Helm deployment guide](../martian-helm-charts/docs/project-martian.md) owns cloud prerequisites, releases and restore operations.

Use Node.js 24 and PostgreSQL 18. After [database setup](docs/usage.md#local-database), run `npm ci`, `npm run build` and `npm start` with the documented database variables; open `http://127.0.0.1:8766`. Static-file previews cannot load the database-backed publication. Ask additionally requires the existing AWS login.

Automatic database failover, cluster NetworkPolicy enforcement and backup alert delivery are outside the approved current scope.

The architecture migration preserves the 44-record archive, current calculations, light desktop design and explicitly illustrative Radar samples. The proposed Rogue Index methodology and Microtrends improvements remain future work.
