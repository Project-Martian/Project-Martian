import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Incident, Publication } from './types.js';
import { readSnapshotClient } from './database.js';
import { recordSchema, publish, validatePublication } from './publication.js';
import { assessmentState, impactScore } from './impact.js';
import { buildMicrotrends, mappingState } from './microtrends.js';
import { contextState } from './context.js';

export const CONTRIBUTION_REPO = 'Project-Martian/Project-Martian';
export const PROPOSAL_MARKER = '<!-- project-martian:incident:v1 -->';
export const proposalSchema = z.strictObject({
  version: z.literal('incident-contribution-v1'), issue: z.number().int().positive(),
  operation: z.enum(['add', 'correct']), base_record_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  record: recordSchema,
});
export type Proposal = z.infer<typeof proposalSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export const contributionHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function parseProposal(body: string) {
  const match = body.trim().match(/^<!-- project-martian:incident:v1 -->\s*```json\s*\n([\s\S]+)\n```\s*$/);
  if (!match) throw new Error('Proposal must contain the marker and exactly one JSON block');
  return proposalSchema.parse(JSON.parse(match[1]));
}

export function prepareContribution(data: Publication, proposal: Proposal) {
  if (data.repo !== 'https://github.com/' + CONTRIBUTION_REPO) throw new Error('Publication repository does not match contribution repository');
  const record = proposal.record as Incident;
  const existing = data.records.find(r=>r.id===record.id);
  if (proposal.operation === 'add') {
    if (record.id !== `github-issue-${proposal.issue}` || existing || proposal.base_record_hash !== null)
      throw new Error('New incidents require an unused github-issue-N ID and null base_record_hash');
  } else if (!existing || proposal.base_record_hash !== contributionHash(existing)) {
    throw new Error('Correction is stale or its incident is missing; review the current record again');
  }
  if (!record.impact_assessment || assessmentState(record) !== 'reviewed'
    || !record.map || mappingState(record) !== 'reviewed'
    || ((record.scope === 'agents' || record.context) && (!record.context || contextState(record) !== 'reviewed')))
    throw new Error('Incoming impact, mapping and applicable context need current human reviews');
  const records = existing ? data.records.map(r=>r.id===record.id?record:r) : [...data.records,record];
  // Rebuild only the incident's derived map. Never modify unrelated editorial fields or settings.
  return validatePublication({...data, records, microtrends: {...data.microtrends,...buildMicrotrends([record])}});
}
export function requiredApprovals(proposal: Proposal) {
  return proposal.record.impact_assessment && impactScore(proposal.record.impact_assessment).band === 'Severe' ? 2 : 1;
}
export interface ApprovedContribution {
  proposal: Proposal; proposal_comment_id: number; approved_by: string[];
}
// Caller holds the publication advisory lock and commits/rolls back the entire operation.
export async function publishContribution(client: PoolClient, approved: ApprovedContribution) {
  const p=approved.proposal, hash=contributionHash(p);
  const receipt=await client.query('SELECT incident_id, publication_id::text, proposal_hash FROM contribution_publications WHERE repository=$1 AND issue_number=$2', [CONTRIBUTION_REPO,p.issue]);
  if (receipt.rows.length) return {status:'already-published',...receipt.rows[0]};
  const {publication: _publication,...data}=await readSnapshotClient(client);
  const next=prepareContribution(data,p);
  if (new Set(approved.approved_by.map(name=>name.toLowerCase())).size < requiredApprovals(p)) throw new Error('Not enough distinct maintainer approvals');
  const id=await publish(client,next,`github:${approved.approved_by.join(',')}`,`Verified contribution https://github.com/${CONTRIBUTION_REPO}/issues/${p.issue}; proposal ${hash}`);
  await client.query(`INSERT INTO contribution_publications(repository,issue_number,incident_id,operation,proposal_hash,proposal_comment_id,approved_by,publication_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[CONTRIBUTION_REPO,p.issue,p.record.id,p.operation,hash,approved.proposal_comment_id,JSON.stringify(approved.approved_by),id]);
  return {status:'published',incident_id:p.record.id,publication_id:id,proposal_hash:hash};
}
