# Contributing

Report an incident through a GitHub issue with the public source URL, event date, affected product and a plain-language summary. Distinguish a demonstrated event from an allegation, paper, evaluation or uncertain report. Do not submit credentials, raw customer data or instructions for attacking live systems.

For dataset changes, review an exported publication using the [operator workflow](docs/usage.md#publishing-data). Preserve stable IDs, complete source citations, timeline events, company/model relationships and explicit Radar sample labels. `data/records.json` and `data/publication-seed.json` preserve the initial import and are not the live database. A Git change alone does not publish new records. Cite evidence for dates, impact and financial claims; submit corrections through review before an operator publishes them.

Run `npm run check`, `npm run build` and `git diff --check`. Open the desktop website against PostgreSQL and exercise the affected view. Do not add tests without a request. Publication review does not establish that every reported claim is independently verified.

For Rogue Index changes, use the [scoring and review workflow](docs/rogue-index.md). Supply the four inputs, a reason for each, source references and explicit uncertainty. Never type a computed score or invent reviewer approvals. Every assessment needs a human review, and Severe scores need two distinct reviewers. Use public reviewer handles and publication notes: assessment metadata and its published history are readable through the API.

For Microtrends changes, use the [mapping and review workflow](docs/microtrends.md). Supply the model maker, model/version, primary attack, operator, target and harness with source references. A named model needs a quoted source; never infer it from a product. Use the controlled catalogs and propose new vocabulary through a focused review. Build the generated map from the records, then obtain human approval before a reviewed publication. Preserve attribution disputes and leave unsupported identities explicitly unknown.
