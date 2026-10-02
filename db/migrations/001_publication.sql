CREATE TABLE publications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (length(actor) > 0),
  reason text NOT NULL CHECK (length(reason) > 0),
  source_hash text NOT NULL,
  settings jsonb NOT NULL,
  repo text NOT NULL
);

CREATE TABLE incidents (id text PRIMARY KEY);
CREATE TABLE incident_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents(id),
  publication_id bigint NOT NULL REFERENCES publications(id),
  scope text NOT NULL CHECK (scope IN ('agents', 'other-ai', 'automation')),
  sort_date date,
  title text NOT NULL,
  organization_display text NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  action text,
  exposure text,
  category text,
  UNIQUE (publication_id, incident_id)
);
CREATE INDEX incident_revisions_scope_date ON incident_revisions(publication_id, scope, sort_date DESC);

CREATE TABLE sources (url text PRIMARY KEY);
CREATE TABLE revision_sources (
  revision_id bigint NOT NULL REFERENCES incident_revisions(id),
  position integer NOT NULL CHECK (position >= 0),
  url text NOT NULL REFERENCES sources(url),
  label text NOT NULL,
  title text NOT NULL,
  date_label text NOT NULL,
  PRIMARY KEY (revision_id, position)
);
CREATE TABLE incident_events (
  revision_id bigint NOT NULL REFERENCES incident_revisions(id),
  position integer NOT NULL CHECK (position >= 0),
  date_label text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  PRIMARY KEY (revision_id, position)
);

CREATE TABLE organizations (name text PRIMARY KEY);
CREATE TABLE systems (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_name text NOT NULL REFERENCES organizations(name),
  name text NOT NULL,
  UNIQUE (organization_name, name)
);
CREATE TABLE revision_systems (
  revision_id bigint NOT NULL REFERENCES incident_revisions(id),
  position integer NOT NULL CHECK (position >= 0),
  system_id bigint NOT NULL REFERENCES systems(id),
  PRIMARY KEY (revision_id, position)
);

CREATE TABLE radar_signals (
  publication_id bigint NOT NULL REFERENCES publications(id),
  id text NOT NULL,
  is_sample boolean NOT NULL,
  content jsonb NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (publication_id, id)
);
CREATE TABLE radar_clusters (
  publication_id bigint NOT NULL REFERENCES publications(id),
  id text NOT NULL,
  is_sample boolean NOT NULL,
  content jsonb NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (publication_id, id)
);
CREATE TABLE import_history (
  name text PRIMARY KEY,
  source_hash text NOT NULL,
  publication_id bigint NOT NULL REFERENCES publications(id)
);

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO project_martian_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO project_martian_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO project_martian_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO project_martian_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO project_martian_app;
