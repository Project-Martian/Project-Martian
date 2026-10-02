# Sourced by the official PostgreSQL entrypoint on an empty local volume.
# The Helm chart carries the equivalent bootstrap for its existing Secret.
export PROJECT_MARTIAN_APP_PASSWORD="$(cat /run/database/app-password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password PROJECT_MARTIAN_APP_PASSWORD
SELECT format('CREATE ROLE project_martian_app LOGIN PASSWORD %L', :'app_password') \gexec
SQL
unset PROJECT_MARTIAN_APP_PASSWORD
