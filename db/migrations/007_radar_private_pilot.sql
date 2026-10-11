-- Existing enabled sources retain their display policy. New sources start private.
ALTER TABLE radar_private.sources ADD COLUMN publication_mode text NOT NULL DEFAULT 'private'
  CHECK (publication_mode IN ('private','public'));
UPDATE radar_private.sources SET publication_mode='public' WHERE enabled;
ALTER TABLE radar_private.sources ADD COLUMN page_size integer NOT NULL DEFAULT 10 CHECK (page_size BETWEEN 10 AND 100);
ALTER TABLE radar_private.sources ADD COLUMN refresh_limit integer NOT NULL DEFAULT 50 CHECK (refresh_limit BETWEEN 1 AND 100);
ALTER TABLE radar_private.sources ADD COLUMN last_complete timestamptz;

CREATE TABLE radar_private.provider_state (
  provider text PRIMARY KEY CHECK (provider IN ('x','reddit')),
  resume_after timestamptz,
  manual_pause boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO radar_private.provider_state(provider) VALUES ('x'),('reddit');

CREATE TABLE radar_private.spend_budgets (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('x','bedrock')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  limit_microusd bigint NOT NULL CHECK (limit_microusd BETWEEN 1 AND 1000000000),
  pricing jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- No raw provider content or credential is stored in this ledger.
-- An unfinished request keeps its reservation across crashes and restarts.
CREATE TABLE radar_private.spend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id text NOT NULL REFERENCES radar_private.spend_budgets(id),
  operation text NOT NULL,
  reserved_microusd bigint NOT NULL CHECK (reserved_microusd>=0),
  estimated_microusd bigint CHECK (estimated_microusd>=0),
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX radar_spend_budget ON radar_private.spend_requests(budget_id);

CREATE OR REPLACE VIEW radar_private.displayable_posts AS
SELECT p.* FROM radar_private.posts p JOIN radar_private.sources s ON s.id=p.source_id
WHERE s.enabled AND s.publication_mode='public' AND p.decision='published' AND cardinality(p.flags)=0
  AND p.display_until>now() AND p.retain_until>now()
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.content->'context_ids','[]'::jsonb)) edge(id)
    JOIN radar_private.posts context ON context.platform=p.platform AND context.external_id=edge.id
    JOIN radar_private.sources cs ON cs.id=context.source_id
    WHERE context.decision='removed' OR context.display_until<=now() OR context.retain_until<=now()
      OR NOT cs.enabled OR cs.publication_mode<>'public'
  );
CREATE OR REPLACE VIEW radar_public.sources AS
SELECT s.id,s.platform,s.enabled,s.last_success,s.last_error,s.publication_mode,s.last_complete,
  p.resume_after,p.manual_pause
FROM radar_private.sources s LEFT JOIN radar_private.provider_state p ON p.provider=s.platform;

CREATE OR REPLACE VIEW radar_public.posts WITH (security_barrier=true) AS
SELECT p.id,p.platform,p.content->>'url' AS url,p.content->>'text' AS text,
  p.content->'author'->>'name' AS author_name,p.content->'author'->>'handle' AS author_handle,
  p.content->'author'->>'url' AS author_url,p.content->'author'->>'avatar' AS author_avatar,
  p.content->'entities' AS entities,p.content->'engagement' AS engagement,
  p.posted_at,p.display_until,p.published_at,p.cluster_id,p.is_duplicate,
  p.classification->>'kind' AS kind,p.classification->>'evidence' AS evidence,
  p.classification->>'company' AS company,p.classification->>'model' AS model,
  p.classification->>'harness' AS harness,p.primary_reviewed,
  md5(p.platform||':'||(p.content->'author'->>'id')) AS author_key,
  CASE WHEN EXISTS (SELECT 1 FROM public.incident_revisions r WHERE r.incident_id=COALESCE(p.record_id,c.record_id)
    AND r.publication_id=(SELECT max(id) FROM public.publications)) THEN COALESCE(p.record_id,c.record_id) END AS record_id,
  COALESCE((p.content->>'edited')::boolean,false) AS edited
FROM radar_private.displayable_posts p LEFT JOIN radar_private.clusters c ON c.id=p.cluster_id
WHERE (SELECT public_enabled FROM radar_private.control);

GRANT SELECT ON radar_private.provider_state,radar_private.spend_budgets,radar_private.spend_requests
  TO project_martian_radar_worker,project_martian_radar_reviewer,project_martian_radar_backup;
GRANT UPDATE ON radar_private.provider_state TO project_martian_radar_worker;
GRANT INSERT ON radar_private.spend_requests TO project_martian_radar_worker;
GRANT UPDATE(estimated_microusd,usage,settled_at) ON radar_private.spend_requests TO project_martian_radar_worker;
GRANT UPDATE(last_complete) ON radar_private.sources TO project_martian_radar_worker;
