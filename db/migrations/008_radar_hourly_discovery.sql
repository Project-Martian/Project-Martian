-- Web evidence gets one missed-hour margin; social-provider checks remain one hour.
ALTER TABLE radar_private.posts DROP CONSTRAINT posts_check;
ALTER TABLE radar_private.posts ADD CONSTRAINT posts_display_freshness CHECK (
  display_until<=checked_at+CASE WHEN platform='wild' THEN interval '2 hours' ELSE interval '1 hour' END
);

-- Public source labels only; no search queries, extracted evidence or credentials.
CREATE OR REPLACE VIEW radar_public.sources AS
SELECT s.id,s.platform,s.enabled,s.last_success,s.last_error,s.publication_mode,s.last_complete,
  p.resume_after,p.manual_pause,s.config->>'kind' AS kind,
  CASE WHEN s.config->>'kind'='web-search' THEN 'Web discovery'
       WHEN s.config->>'kind'='rss' THEN s.config->>'publisher'
       ELSE s.platform END AS name
FROM radar_private.sources s LEFT JOIN radar_private.provider_state p ON p.provider=s.platform;
