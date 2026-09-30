# Project Martian

This is an independent static publication. Preserve the desktop UI and the existing incident records. It has no Martian Security runtime, database, authentication or API dependency.

Helm charts and environment values belong in the separate `martian-helm-charts` repository under `charts/project-martian` and `environments/project-martian`. Do not add this application to `charts/martian-platform` or merge the two application repositories. Container packaging belongs here.

Update the canonical docs when behavior or deployment boundaries change. Do not add tests without a user request, and do not commit or deploy without authorization.
