# Contributing

Report an incident through a GitHub issue with the public source URL, event date, affected product and a plain-language summary. Distinguish a demonstrated event from an allegation, paper, evaluation or uncertain report. Do not submit credentials, raw customer data or instructions for attacking live systems.

For dataset changes, review an exported publication using the [operator workflow](docs/usage.md#publishing-data). Preserve stable IDs, complete source citations, timeline events, company/model relationships and explicit Radar sample labels. `data/records.json` and `data/publication-seed.json` preserve the initial import and are not the live database. A Git change alone does not publish new records. Cite evidence for dates, impact and financial claims; submit corrections through review before an operator publishes them.

Run `npm run check`, `npm run build` and `git diff --check`. Open the desktop website against PostgreSQL and exercise the affected view. Do not add tests without a request. Publication review does not establish that every reported claim is independently verified.
