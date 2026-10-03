-- A reply/quote must not outlive source context that Radar knows has expired.
-- This is a read-time gate, independent of worker cleanup or model completion.
CREATE INDEX radar_posts_context ON radar_private.posts USING gin ((content->'context_ids'));
CREATE OR REPLACE VIEW radar_private.displayable_posts AS
SELECT p.* FROM radar_private.posts p JOIN radar_private.sources s ON s.id=p.source_id
WHERE s.enabled AND p.decision='published' AND cardinality(p.flags)=0
  AND p.display_until > now() AND p.retain_until > now()
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.content->'context_ids','[]'::jsonb)) edge(id)
    JOIN radar_private.posts context ON context.platform=p.platform AND context.external_id=edge.id
    JOIN radar_private.sources cs ON cs.id=context.source_id
    WHERE true
      AND (context.decision='removed' OR context.display_until<=now() OR context.retain_until<=now() OR NOT cs.enabled)
  );
