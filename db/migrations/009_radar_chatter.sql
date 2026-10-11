-- Verified X authors are required independently of the relevance decision.
CREATE OR REPLACE VIEW radar_private.displayable_posts AS
SELECT p.* FROM radar_private.posts p JOIN radar_private.sources s ON s.id=p.source_id
WHERE s.enabled AND s.publication_mode='public' AND p.decision='published' AND cardinality(p.flags)=0
  AND (p.platform<>'x' OR p.content->'author'->>'verified'='true')
  AND p.display_until>now() AND p.retain_until>now()
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.content->'context_ids','[]'::jsonb)) edge(id)
    JOIN radar_private.posts context ON context.platform=p.platform AND context.external_id=edge.id
    JOIN radar_private.sources cs ON cs.id=context.source_id
    WHERE context.decision='removed' OR context.display_until<=now() OR context.retain_until<=now()
      OR NOT cs.enabled OR cs.publication_mode<>'public'
  );
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
  COALESCE((p.content->>'edited')::boolean,false) AS edited,
  COALESCE((p.content->'author'->>'verified')::boolean,false) AS author_verified
FROM radar_private.displayable_posts p LEFT JOIN radar_private.clusters c ON c.id=p.cluster_id
WHERE (SELECT public_enabled FROM radar_private.control);

