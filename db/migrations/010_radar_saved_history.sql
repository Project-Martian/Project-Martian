-- Saving a record is separate from permission to display current source content.
-- Opt-in per source; existing pilots keep their original retention policy.
ALTER TABLE radar_private.sources ADD COLUMN save_history boolean NOT NULL DEFAULT false;
ALTER TABLE radar_private.posts ADD COLUMN saved boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW radar_public.posts WITH (security_barrier=true) AS
SELECT p.id,p.platform,p.content->>'url' AS url,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.content->>'text' END AS text,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.content->'author'->>'name' ELSE 'Saved X post' END AS author_name,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.content->'author'->>'handle' END AS author_handle,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.content->'author'->>'url' END AS author_url,
  CASE WHEN live.id IS NOT NULL THEN p.content->'author'->>'avatar' END AS author_avatar,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.content->'entities' ELSE '[]'::jsonb END AS entities,
  CASE WHEN live.id IS NOT NULL THEN p.content->'engagement' ELSE 'null'::jsonb END AS engagement,
  p.posted_at,p.display_until,p.published_at,p.cluster_id,p.is_duplicate,
  p.classification->>'kind' AS kind,p.classification->>'evidence' AS evidence,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.classification->>'company' END AS company,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.classification->>'model' END AS model,
  CASE WHEN live.id IS NOT NULL OR p.platform='wild' THEN p.classification->>'harness' END AS harness,p.primary_reviewed,
  md5(p.platform||':'||(p.content->'author'->>'id')) AS author_key,
  CASE WHEN EXISTS (SELECT 1 FROM public.incident_revisions r WHERE r.incident_id=COALESCE(p.record_id,c.record_id)
    AND r.publication_id=(SELECT max(id) FROM public.publications)) THEN COALESCE(p.record_id,c.record_id) END AS record_id,
  COALESCE((p.content->>'edited')::boolean,false) AS edited,
  live.id IS NOT NULL AND COALESCE((p.content->'author'->>'verified')::boolean,false) AS author_verified,
  p.saved,p.checked_at,live.id IS NOT NULL AS source_current
FROM radar_private.posts p
JOIN radar_private.sources s ON s.id=p.source_id
LEFT JOIN radar_private.displayable_posts live ON live.id=p.id
LEFT JOIN radar_private.clusters c ON c.id=p.cluster_id
WHERE (SELECT public_enabled FROM radar_private.control)
  AND s.enabled AND s.publication_mode='public'
  AND p.decision='published' AND cardinality(p.flags)=0 AND p.content_hash<>''
  AND (p.platform<>'x' OR p.content->'author'->>'verified'='true')
  AND (live.id IS NOT NULL OR (p.saved AND p.platform IN ('x','wild')))
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.content->'context_ids','[]'::jsonb)) edge(id)
    JOIN radar_private.posts context ON context.platform=p.platform AND context.external_id=edge.id
    JOIN radar_private.sources cs ON cs.id=context.source_id
    WHERE context.decision='removed' OR NOT cs.enabled OR cs.publication_mode<>'public'
  );
