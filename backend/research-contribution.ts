import { z } from 'zod';
import type { Incident, Publication } from './types.js';
import { recordSchema, validatePublication } from './publication.js';
import { impactSchema, assessmentHash, impactScore } from './impact.js';
import { mappingSchema, mappingHash, buildMicrotrends } from './microtrends.js';
import { contextSchema, contextHash } from './context.js';
import { contributionHash, CONTRIBUTION_REPO } from './contributions.js';
import { canonicalUrl } from './radar/rules.js';

const emptyReviews = z.array(z.never()).max(0);
export const researchRecordSchema = recordSchema.strict().extend({
  id: z.literal('research-draft'), scope: z.literal('agents'),
  impact_assessment: impactSchema.extend({reviews: emptyReviews}),
  map: mappingSchema.extend({reviews: emptyReviews}),
  context: contextSchema.extend({reviews: emptyReviews}),
});
export const researchDraftSchema = z.strictObject({
  version: z.literal('incident-research-v1'), generated_at: z.iso.datetime(),
  novelty_reason: z.string().trim().min(1).max(1500),
  evidence: z.array(z.strictObject({url:z.url(), quote:z.string().trim().min(1).max(280)})).min(1).max(8),
  record: researchRecordSchema,
});
export type ResearchDraft = z.infer<typeof researchDraftSchema>;
export const RESEARCH_MARKER = '<!-- project-martian:research:v1 -->';
const END_MARKER = '<!-- /project-martian:research:v1 -->';
const plain = (s:string) => s.replace(/[\r\n]+/g,' ').replace(/[<>`]/g,'').replace(/@/g,'＠');
export const sourceKeys = (record:Incident) => [...new Set([record.u,...record.srcs.map(s=>s[2])].map(canonicalUrl))];
export function duplicateRecord(data:Publication, record:Incident) {
  const urls=new Set(sourceKeys(record)), title=record.t.normalize('NFKC').toLowerCase().replace(/\W/g,'');
  return data.records.find(r=>sourceKeys(r).some(url=>urls.has(url)) || r.t.normalize('NFKC').toLowerCase().replace(/\W/g,'')===title);
}
// A new source audit advances the coverage date, but never extends the chart calendar.
export function researchPublication(data:Publication, record:Incident):Publication {
  const audit=record.context!;
  const dates=[data.settings.context_as_of!,audit.proposed_at.slice(0,10),...audit.sources.map(s=>s.checked_at.slice(0,10))];
  const asOf=dates.sort().at(-1)!;
  if(asOf>new Date().toISOString().slice(0,10))throw new Error('Research audit cannot be in the future');
  return {...data,settings:{...data.settings,context_as_of:asOf}};
}
export function validateResearchDraft(data:Publication, value:unknown):ResearchDraft {
  const draft=researchDraftSchema.parse(value), record=draft.record as Incident;
  if(new Date(draft.generated_at).getTime()>Date.now())throw new Error('Research draft cannot be dated in the future');
  if(data.settings.methodology_version!=='impact-v1'||!data.settings.microtrends_version||!data.settings.context_version)
    throw new Error('Research requires the impact, mapping and context publication versions');
  if(duplicateRecord(data,record))throw new Error('Research matches a published source or title; review it as a correction');
  const urls=new Set([record.u,...record.srcs.map(s=>s[2])]);
  if(record.context!.sources.some(s=>!urls.has(s.url))||draft.evidence.some(s=>!urls.has(s.url)))
    throw new Error('Research evidence must use the record sources');
  const next=researchPublication(data,record);
  // Validate drafts without inventing reviews or modifying the live review settings.
  validatePublication({...next,settings:{...next.settings,impact_review_mode:'draft',microtrends_review_mode:'draft',context_review_mode:'draft'},
    records:[...data.records,record],microtrends:{...data.microtrends,...buildMicrotrends([record])}});
  if(JSON.stringify(draft).length>45000)throw new Error('Research draft is too large for GitHub review');
  return draft;
}
export function researchIssueBody(draft:ResearchDraft) {
  const r=draft.record, hash=contributionHash(draft), score=impactScore(r.impact_assessment);
  return `## Research contribution — human review required

### Public source URL
${r.u}

### Event and report dates
Occurrence: ${plain(r.when)}
Source publication: ${r.context.sources.find(s=>s.url===r.u)?.published_on || 'unknown'}

### What happened and what remains uncertain
Affected product / organization: ${plain(r.org)}

${plain(r.sum)}

Impact and uncertainty: ${plain(r.impact)} ${plain(r.limits)}

### Correlation review
${plain(draft.novelty_reason)}

### Sources
${r.srcs.map(s=>`- ${plain(s[0])}: ${s[2]}`).join('\n')}

### Proposed assessment
${score.band} (${score.score}/100). Damage ${r.impact_assessment.damage}; reach ${r.impact_assessment.reach}; reversal ${r.impact_assessment.reversal}; landing ${r.impact_assessment.landed}.

### Approve publication
Review the sources and the full proposed record below, including impact, mapping and chronology. A repository maintainer approves this exact content by posting a new, unedited comment:

\`/approve-incident ${hash}\`

${score.band==='Severe'?'Two distinct maintainers must approve this Severe assessment.':'One maintainer approval is required.'} Approval publishes automatically on the next publisher run; closing the issue is not required. To reject, close as not planned. To withdraw approval before publication, post \`/revoke-incident ${hash}\`. No model creates human approvals.

<details><summary>Full proposed record and source excerpts</summary>

${RESEARCH_MARKER}
\`\`\`json
${JSON.stringify(draft,null,2)}
\`\`\`
${END_MARKER}

</details>`;
}
export function parseResearchIssue(body:string) {
  body=body.replace(/\r\n/g,'\n');
  if(body.split(RESEARCH_MARKER).length!==2||body.split(END_MARKER).length!==2)throw new Error('Expected one research draft');
  const block=body.split(RESEARCH_MARKER)[1].split(END_MARKER)[0].trim();
  const match=block.match(/^```json\n([\s\S]+)\n```$/);
  if(!match)throw new Error('Invalid research draft block');
  const draft=researchDraftSchema.parse(JSON.parse(match[1]));
  if(body.trim()!==researchIssueBody(draft))throw new Error('Research issue text and payload differ; regenerate the review body');
  return draft;
}
export interface AuthenticatedReview {login:string; comment_id:number; created_at:string}
export function reviewedResearchRecord(draft:ResearchDraft, issue:number, reviews:AuthenticatedReview[]):Incident {
  const record=structuredClone(draft.record) as Incident;
  record.id=`github-issue-${issue}`;
  const a=record.impact_assessment!, m=record.map!, c=record.context!;
  const hashes={impact:assessmentHash(record),mapping:mappingHash(record),context:contextHash(record)};
  for(const review of reviews) {
    const shared={reviewer:review.login,reviewed_at:review.created_at,decision:'approve' as const,
      note:`Approved the complete research draft ${contributionHash(draft)} at https://github.com/${CONTRIBUTION_REPO}/issues/${issue}#issuecomment-${review.comment_id}`};
    a.reviews.push({...shared,assessment_hash:hashes.impact,values:{damage:a.damage,reach:a.reach,reversal:a.reversal,landed:a.landed}});
    m.reviews.push({...shared,mapping_hash:hashes.mapping});
    c.reviews.push({...shared,context_hash:hashes.context});
  }
  return record;
}
