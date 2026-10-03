-- Radar is operational data, independent of immutable incident publications.
-- Never inherit the public schema's blanket web-reader default privileges.
CREATE SCHEMA radar_private;
CREATE SCHEMA radar_public;
REVOKE ALL ON SCHEMA radar_private, radar_public FROM PUBLIC;
CREATE ROLE project_martian_radar_worker NOLOGIN;
CREATE ROLE project_martian_radar_reviewer NOLOGIN;
CREATE ROLE project_martian_radar_intake NOLOGIN;
CREATE ROLE project_martian_radar_backup NOLOGIN;

CREATE TABLE radar_private.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  public_enabled boolean NOT NULL DEFAULT false,
  intake_enabled boolean NOT NULL DEFAULT false,
  model_calls_per_day integer NOT NULL DEFAULT 200 CHECK (model_calls_per_day BETWEEN 1 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO radar_private.control DEFAULT VALUES;

CREATE TABLE radar_private.sources (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  platform text NOT NULL CHECK (platform IN ('x','reddit','wild')),
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL,
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 120),
  retention_hours integer NOT NULL CHECK (retention_hours BETWEEN 1 AND 720),
  requests_per_day integer NOT NULL CHECK (requests_per_day BETWEEN 1 AND 10000),
  cursor jsonb NOT NULL DEFAULT '{}',
  last_attempt timestamptz,
  last_success timestamptz,
  last_error text CHECK (length(last_error) <= 80)
);
CREATE TABLE radar_private.clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text CHECK (length(title) <= 180),
  title_members uuid[] NOT NULL DEFAULT '{}',
  title_size integer NOT NULL DEFAULT 0,
  centroid real[],
  embedding_model text,
  record_id text REFERENCES public.incidents(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE radar_private.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES radar_private.sources(id),
  platform text NOT NULL CHECK (platform IN ('x','reddit','wild')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 2048),
  content jsonb NOT NULL CHECK (octet_length(content::text) <= 100000),
  content_hash text NOT NULL,
  normalized_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  via text[] NOT NULL,
  posted_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL,
  display_until timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','dropped','held','published','processing-error','removed')),
  flags text[] NOT NULL DEFAULT '{}',
  cleared_flags text[] NOT NULL DEFAULT '{}',
  rules_override boolean NOT NULL DEFAULT false,
  rules jsonb,
  classification jsonb,
  embedding real[],
  embedding_model text,
  duplicate_of uuid REFERENCES radar_private.posts(id) ON DELETE SET NULL,
  is_duplicate boolean NOT NULL DEFAULT false,
  cluster_id uuid REFERENCES radar_private.clusters(id),
  record_id text REFERENCES public.incidents(id),
  primary_reviewed boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  UNIQUE (platform, external_id),
  CHECK (display_until <= checked_at + interval '1 hour'),
  CHECK (retain_until > posted_at)
);
CREATE INDEX radar_posts_pending ON radar_private.posts(decision, ingested_at);
CREATE INDEX radar_posts_cluster ON radar_private.posts(cluster_id, posted_at);
CREATE INDEX radar_posts_normalized ON radar_private.posts(normalized_hash);
CREATE INDEX radar_posts_expiry ON radar_private.posts(retain_until);
CREATE TABLE radar_private.decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id uuid REFERENCES radar_private.posts(id) ON DELETE CASCADE,
  revision integer,
  actor text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1500),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE radar_private.intake (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('submission','report')),
  content jsonb NOT NULL CHECK (octet_length(content::text) <= 20000),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);
CREATE TABLE radar_private.usage (
  bucket text NOT NULL,
  day date NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY(bucket, day)
);
CREATE TABLE radar_private.heartbeat (
  name text PRIMARY KEY,
  checked_at timestamptz NOT NULL,
  status text NOT NULL
);
CREATE TABLE radar_private.intake_limits (
  key text NOT NULL,
  hour timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY(key, hour)
);

-- Both worker calculations and public reads use exactly the same availability gate.
CREATE VIEW radar_private.displayable_posts AS
SELECT p.* FROM radar_private.posts p JOIN radar_private.sources s ON s.id=p.source_id
WHERE s.enabled AND p.decision='published' AND cardinality(p.flags)=0
  AND p.display_until > now() AND p.retain_until > now();

CREATE VIEW radar_public.posts WITH (security_barrier=true) AS
SELECT p.id, p.platform, p.content->>'url' AS url, p.content->>'text' AS text,
  p.content->'author'->>'name' AS author_name, p.content->'author'->>'handle' AS author_handle,
  p.content->'author'->>'url' AS author_url, p.content->'author'->>'avatar' AS author_avatar,
  p.content->'entities' AS entities, p.content->'engagement' AS engagement,
  p.posted_at, p.display_until, p.published_at, p.cluster_id, p.is_duplicate,
  p.classification->>'kind' AS kind, p.classification->>'evidence' AS evidence,
  p.classification->>'company' AS company, p.classification->>'model' AS model,
  p.classification->>'harness' AS harness, p.primary_reviewed,
  md5(p.platform || ':' || (p.content->'author'->>'id')) AS author_key,
  CASE WHEN EXISTS (SELECT 1 FROM public.incident_revisions r WHERE r.incident_id=COALESCE(p.record_id,c.record_id)
    AND r.publication_id=(SELECT max(id) FROM public.publications)) THEN COALESCE(p.record_id,c.record_id) END AS record_id
FROM radar_private.displayable_posts p LEFT JOIN radar_private.clusters c ON c.id=p.cluster_id
WHERE (SELECT public_enabled FROM radar_private.control);

-- A title depending on expired/removed evidence is never exposed.
CREATE VIEW radar_public.clusters WITH (security_barrier=true) AS
SELECT c.id,c.title,CASE WHEN EXISTS (SELECT 1 FROM public.incident_revisions r WHERE r.incident_id=c.record_id
  AND r.publication_id=(SELECT max(id) FROM public.publications)) THEN c.record_id END AS record_id FROM radar_private.clusters c
WHERE (SELECT public_enabled FROM radar_private.control) AND c.title IS NOT NULL
  AND cardinality(c.title_members)>0
  AND NOT EXISTS (SELECT 1 FROM unnest(c.title_members) m(id)
    WHERE NOT EXISTS (SELECT 1 FROM radar_public.posts p WHERE p.id=m.id AND NOT p.is_duplicate));
CREATE VIEW radar_public.status AS
SELECT public_enabled,intake_enabled,updated_at FROM radar_private.control;
CREATE VIEW radar_public.sources AS
SELECT id,platform,enabled,last_success,last_error FROM radar_private.sources;

-- A narrow insertion function keeps intake credentials from reading or publishing.
CREATE FUNCTION radar_public.receive_intake(kind text, payload jsonb, client_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt uuid; used integer; intake_hour timestamptz := date_trunc('hour',now());
BEGIN
  IF NOT (SELECT intake_enabled FROM radar_private.control) THEN RAISE EXCEPTION 'intake disabled' USING ERRCODE='55000'; END IF;
  IF kind NOT IN ('submission','report') OR octet_length(payload::text)>20000 OR client_key !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'invalid intake' USING ERRCODE='22023'; END IF;
  INSERT INTO radar_private.intake_limits VALUES ('global',intake_hour,1)
    ON CONFLICT(key,hour) DO UPDATE SET count=radar_private.intake_limits.count+1 RETURNING count INTO used;
  IF used>200 THEN RAISE EXCEPTION 'intake limited' USING ERRCODE='P0001'; END IF;
  INSERT INTO radar_private.intake_limits VALUES (client_key,intake_hour,1)
    ON CONFLICT(key,hour) DO UPDATE SET count=radar_private.intake_limits.count+1 RETURNING count INTO used;
  IF used>10 THEN RAISE EXCEPTION 'intake limited' USING ERRCODE='P0001'; END IF;
  INSERT INTO radar_private.intake(kind,content) VALUES(kind,payload) RETURNING id INTO receipt;
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION radar_public.receive_intake(text,jsonb,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA radar_public TO project_martian_app,project_martian_radar_intake;
GRANT SELECT ON radar_public.posts,radar_public.clusters,radar_public.sources,radar_public.status TO project_martian_app;
GRANT EXECUTE ON FUNCTION radar_public.receive_intake(text,jsonb,text) TO project_martian_radar_intake;
GRANT USAGE ON SCHEMA radar_private TO project_martian_radar_worker,project_martian_radar_reviewer;
GRANT SELECT ON ALL TABLES IN SCHEMA radar_private TO project_martian_radar_worker,project_martian_radar_reviewer;
GRANT INSERT,UPDATE,DELETE ON radar_private.posts,radar_private.clusters,radar_private.decisions,
  radar_private.usage,radar_private.heartbeat,radar_private.intake_limits TO project_martian_radar_worker;
GRANT UPDATE(cursor,last_attempt,last_success,last_error) ON radar_private.sources TO project_martian_radar_worker;
GRANT DELETE ON radar_private.intake TO project_martian_radar_worker;
GRANT UPDATE,DELETE ON radar_private.posts,radar_private.clusters,radar_private.intake TO project_martian_radar_reviewer;
GRANT INSERT ON radar_private.decisions TO project_martian_radar_reviewer;
GRANT DELETE ON radar_private.decisions TO project_martian_radar_reviewer;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA radar_private TO project_martian_radar_worker,project_martian_radar_reviewer;
GRANT USAGE ON SCHEMA public TO project_martian_radar_worker,project_martian_radar_reviewer;
GRANT SELECT ON public.incidents,public.incident_revisions,public.publications,public.revision_sources
  TO project_martian_radar_worker,project_martian_radar_reviewer;

-- A separate dump credential can lock/read tables for pg_dump. The backup command
-- excludes all private Radar rows; never give this credential to the web process.
GRANT USAGE ON SCHEMA public,radar_private,radar_public TO project_martian_radar_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public,radar_private,radar_public TO project_martian_radar_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public,radar_private TO project_martian_radar_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO project_martian_radar_backup;
