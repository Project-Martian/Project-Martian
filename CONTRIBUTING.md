# Contributing

Report an incident through a GitHub issue with the public source URL, event date, affected product and a plain-language summary. Distinguish a demonstrated event from an allegation, paper, evaluation or uncertain report. Do not submit credentials, raw customer data or instructions for attacking live systems.

For dataset changes, update `js/records.js` and `data/records.json` together; preserve unique IDs and the fields listed in the README. Add a curated `MAP` entry in `js/app.js` if the record should appear in Trends, and update the standalone HTML's embedded copy. Cite evidence for dates, impact and financial claims. Submit corrections and source clarifications through a pull request.

Check JavaScript syntax with `node --check js/app.js`, `node --check js/records.js` and `node --check js/theme-init.js`; check JSON with `python3 -m json.tool data/records.json > /dev/null`. Open the desktop site locally and exercise the affected view. Publication review does not establish that every reported claim is independently verified.
