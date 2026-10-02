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

## Publishing data

PostgreSQL owns current data. The JSON seed files are only the original import, and application deployment never overwrites later publications. Export from the application role, review the complete document, then publish using the owner role:

```sh
node dist/backend/manage.js export > /path/to/reviewed-publication.json
# Edit and review records, source metadata, mappings, settings and Radar sample flags.
PGUSER=project_martian_owner PGPASSWORD_FILE="$MARTIAN_DB_SECRETS/owner-password" \
  node dist/backend/manage.js publish /path/to/reviewed-publication.json \
  --actor YOUR_OPERATOR_NAME --reason 'Reviewed correction with source references'
```

Use `node … export`, not `npm run db:export > file`, because npm's script banner would corrupt the JSON. Every publish requires an actor and reason and creates a complete immutable revision in one transaction. Prior publications are preserved. Removed IDs disappear from the current view but remain in historical SQL rows. Reload the website to read the new snapshot. There is no web editor or automatic publication pipeline yet.

Production publication uses a short-lived operator Job with the same pinned application image, owner-password Secret, database environment, `projectmartian.ai/database-client: "true"` label, and no Bedrock identity. Supply the reviewed JSON through an explicitly managed input volume. Never mount the owner credential in the web application or publish through `/api/ask`. A Git push alone changes neither the live database nor the deployed image.

The CLI validates identifiers, dates, source URLs, references and display-calendar bounds. Impact publications additionally require a complete assessment for every record and explicit review mode. Reviewed mode requires a current approval (two distinct reviewers for Severe); stale approvals and unresolved disputes are rejected. An explicitly authorized draft publication requires `--allow-draft` and visibly labels the chart; deployment authorization never creates evidence-review approvals. These are structural and declared-review checks, not fact checking or authentication of reviewer identities. See [Rogue Index preparation and review](rogue-index.md#prepare-and-review).

Microtrends publications additionally validate catalog membership, maker/model/version pairs, named-model quotations, cited source URLs, scope/attack-family compatibility and exact generated-map consistency. Reviewed mode requires current declared approval for every mapping; drafts require the same `--allow-draft` flag. Use the [mapping preparation, build and review workflow](microtrends.md#prepare-review-and-publish) after editing record maps.

## Verification

```sh
npm run check
npm run build
npm audit --omit=dev
git diff --check
```

Run the app against the local database and check the archive, trends, mappings, Radar, Timeline and Ask flows. Compare record content and calculations before a data migration. Exercise migration/import idempotency and read-only application permissions. No new test infrastructure is introduced by this migration.

The 16 existing Python tests can still be run with `.venv/bin/python -m unittest discover -s tests`; they check the historical Python implementation only. Its October 1 live-language/browser evidence is preserved in the [previous deployment checkpoint](../../martian-helm-charts/docs/project-martian.md#bedrock-ask-deployment-and-idle-connection-correction--october-1-2026), not proof of the Node port. Current runtime and restore checks belong in the October 2 deployment checkpoint.

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
