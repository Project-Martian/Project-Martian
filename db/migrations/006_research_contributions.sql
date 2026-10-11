-- Research drafts are proposed in the issue body; legacy proposals remain comments.
ALTER TABLE contribution_publications ALTER COLUMN proposal_comment_id DROP NOT NULL;
ALTER TABLE contribution_publications ADD COLUMN review_protocol text NOT NULL DEFAULT 'comment-v1';
ALTER TABLE contribution_publications ADD COLUMN research_draft jsonb;
ALTER TABLE contribution_publications ADD CONSTRAINT contribution_review_protocol CHECK (
  (review_protocol = 'comment-v1' AND proposal_comment_id IS NOT NULL AND research_draft IS NULL)
  OR (review_protocol = 'research-v1' AND proposal_comment_id IS NULL AND research_draft IS NOT NULL
    AND COALESCE(research_draft->>'version', '') = 'incident-research-v1')
);
CREATE UNIQUE INDEX contribution_research_payload ON contribution_publications(proposal_hash)
  WHERE review_protocol = 'research-v1';
