# Project Martian

An open record of AI agents going rogue. Plain HTML, CSS and JavaScript. No build step. Source: [Project-Martian/Project-Martian](https://github.com/Project-Martian/Project-Martian).

This publication is independent of Martian Security. It shares AWS cluster infrastructure but has its own application namespace, Helm release, ECR image, ACM certificate and public ALB. It reads only its bundled public records; it has no product API, customer-data or database connection.

See [architecture](docs/architecture.md), [usage and publishing](docs/usage.md), [contributing](CONTRIBUTING.md) and [publication principles](MANIFESTO.md). Helm packaging lives in the separate `martian-helm-charts` repository at `charts/project-martian`, outside `charts/martian-platform`.

## Run it

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

`project-martian-standalone.html` is the same site in one file, if you just want to send or open a single page.

## What's inside

```
index.html                     page markup (tabs: Ask, Trends, Timeline, Radar, About, Docs, Contribute)
css/refinements.css            type and spacing refinements (Outfit + Inter)
css/main.css                   main styles, light and dark tokens
js/theme-init.js               sets light/dark mode before first paint
js/records.js                  REPO link + RECORDS (the incident data the app reads)
js/app.js                      the app: tabs, Ask, Microtrends map, Rogue Index, Timeline, Radar, Joe it / Jill it, share
data/records.json              same 44 incidents as plain JSON, for tooling or contributors
assets/martian-mark.svg        logo mark
assets/logos/*.png             company logos used in filters (also embedded in app.js)
project-martian-standalone.html  everything in one file
```

## Editing the data

The app reads `js/records.js`. To add an incident, add an object to `RECORDS` there
(and mirror it in `data/records.json`). Fields: `id, d (YYYY-MM-DD), scope, set, when, org, kind,
t (title), sum, tag, src, rca, u (source URL), th`.

The Microtrends map uses a curated `MAP` in `js/app.js` keyed by record id
(`p: [[company, model/agent]], act, exp, cat`). Add an entry there for new records to show on the map.

`REPO` in `js/records.js` points to this repository. Keep the same URL in the standalone file.

## The Ask tab

On the public website, Ask matches questions to the bundled incident records locally. The existing
`window.claude.use("sample")` integration is available only when the page runs as a Claude artifact.
No hosted model backend or API credential is configured. The local topic check and record search
work without Claude; a future hosted model integration would be a separate change.

## Fonts

Loaded from Google Fonts (Outfit, Inter). Offline, it falls back to system fonts.
