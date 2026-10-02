-- A receipt and publication commit together. Repeated polling cannot publish an issue twice.
CREATE TABLE contribution_publications (
  repository text NOT NULL,
  issue_number integer NOT NULL CHECK (issue_number > 0),
  incident_id text NOT NULL REFERENCES incidents(id),
  operation text NOT NULL CHECK (operation IN ('add', 'correct')),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[a-f0-9]{64}$'),
  proposal_comment_id bigint NOT NULL,
  approved_by jsonb NOT NULL CHECK (jsonb_typeof(approved_by) = 'array'),
  publication_id bigint NOT NULL REFERENCES publications(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository, issue_number)
);
CREATE UNIQUE INDEX contribution_initial_incident ON contribution_publications(incident_id) WHERE operation = 'add';
GRANT SELECT ON contribution_publications TO project_martian_app;
