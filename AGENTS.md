# Project Martian

`AGENTS.md` and `.agents/skills/` are canonical. `CLAUDE.md` and `.claude/skills` are relative symlinks; edit the originals.

This is an independent public incident publication with a bounded Bedrock Ask service. Preserve the desktop UI and the existing incident records. It owns its runtime and database independently, without an external product authentication or API dependency. AWS credentials belong only in the service's workload identity or local SDK credential chain, never browser assets.

Helm charts and environment values belong in the separate `martian-helm-charts` repository under `charts/project-martian` and `environments/project-martian`. Keep its chart and application separate from other products in the deployment repository. Container packaging belongs here.

Update the canonical docs when behavior or deployment boundaries change. Add focused regression coverage for meaningful behavior, security or data-integrity changes; reuse existing tooling and avoid tests for prose-only edits. Do not commit, push or deploy without the user's authorization. Preserve unrelated work and inspect the current branch before relying on an old deployment record.

Use `npm run check`, `npm run build` and `git diff --check` for application changes. Validate API behavior against the running Node/Postgres app with synthetic data, including relevant failure paths and persisted effects. Click through affected desktop journeys against that backend; static previews and the legacy Python tests do not qualify the current runtime. Report the exact checks and any missing runtime/AWS prerequisites. Interface checks that do not exercise Ask can use the documented `MARTIAN_ASK_ENABLED=false` mode.
