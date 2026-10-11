-- Provider billing normally deduplicates resource reads per UTC day. Retain
-- hashed resource identities for estimates, never post text or credentials.
CREATE TABLE radar_private.spend_resources (
  day date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('posts','users')),
  resource_hash text NOT NULL CHECK (length(resource_hash)=64),
  request_id uuid NOT NULL REFERENCES radar_private.spend_requests(id),
  PRIMARY KEY(day,kind,resource_hash)
);
GRANT SELECT,INSERT ON radar_private.spend_resources TO project_martian_radar_worker;
GRANT SELECT ON radar_private.spend_resources TO project_martian_radar_reviewer,project_martian_radar_backup;
