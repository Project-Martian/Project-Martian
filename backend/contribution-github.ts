import { z } from 'zod';
import { CONTRIBUTION_REPO, PROPOSAL_MARKER, parseProposal, contributionHash, requiredApprovals, type ApprovedContribution } from './contributions.js';
import { RESEARCH_MARKER, parseResearchIssue, reviewedResearchRecord, type AuthenticatedReview } from './research-contribution.js';
import { impactScore } from './impact.js';
const user = z.object({login:z.string().regex(/^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i),type:z.string()});
const issueSchema = z.object({number:z.number().int().positive(),state:z.enum(['open','closed']),state_reason:z.string().nullable(),
  title:z.string(),body:z.string().nullable(),updated_at:z.iso.datetime(),closed_at:z.iso.datetime().nullable(),closed_by:user.nullable().optional(),pull_request:z.unknown().optional()});
const commentSchema = z.object({id:z.number().int().positive(),body:z.string(),user,created_at:z.iso.datetime(),updated_at:z.iso.datetime()});
export class ContributionGitHub {
  constructor(private token:string) {if(!token.trim())throw new Error('GitHub token is required');}
  async get(path:string):Promise<unknown> {
    const response=await fetch(`https://api.github.com/repos/${CONTRIBUTION_REPO}${path}`,{
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.token}`,'X-GitHub-Api-Version':'2022-11-28'},
      signal:AbortSignal.timeout(15000),redirect:'error',
    });
    if(!response.ok)throw new Error(`GitHub read failed (${response.status})`);
    return response.json();
  }
  async list(path:string):Promise<unknown[]> {
    const all:unknown[]=[];
    for(let page=1;page<=100;page++) {
      const batch=z.array(z.unknown()).parse(await this.get(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`));
      all.push(...batch);if(batch.length<100)return all;
    }
    throw new Error('GitHub pagination limit exceeded; no truncated review is accepted');
  }
  async maintainer(login:string) {
    const result=z.object({permission:z.string()}).parse(await this.get(`/collaborators/${encodeURIComponent(login)}/permission`));
    return ['admin','maintain','write'].includes(result.permission);
  }
  async closedIssues() {
    return (await this.list('/issues?state=closed&sort=updated&direction=desc')).map(value=>issueSchema.parse(value)).filter(issue=>!issue.pull_request&&issue.state_reason==='completed');
  }
  async allIssues() {
    return (await this.list('/issues?state=all&sort=updated&direction=desc')).map(value=>issueSchema.parse(value)).filter(issue=>!issue.pull_request);
  }
  async publicationIssues() {
    return (await this.allIssues()).filter(issue=>issue.body?.includes(RESEARCH_MARKER)||issue.state_reason==='completed');
  }
  // Only the private researcher calls this. The publisher retains a read-only token.
  async createResearchIssue(title:string, body:string) {
    if(body.length>60000)throw new Error('Research issue exceeds the review body limit');
    const response=await fetch(`https://api.github.com/repos/${CONTRIBUTION_REPO}/issues`,{
      method:'POST',headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${this.token}`,
        'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
      body:JSON.stringify({title,body}),redirect:'error',signal:AbortSignal.timeout(15000),
    });
    if(!response.ok)throw new Error(`GitHub issue creation failed (${response.status}); inspect GitHub before rerunning`);
    return z.object({number:z.number().int().positive(),html_url:z.url()}).parse(await response.json());
  }
  async approved(number:number):Promise<ApprovedContribution|null> {
    if(!Number.isSafeInteger(number)||number<=0)throw new Error('Invalid issue number');
    const issue=issueSchema.parse(await this.get(`/issues/${number}`));
    if(issue.body?.includes(RESEARCH_MARKER))return this.approvedResearch(issue);
    if(issue.pull_request||issue.state!=='closed'||issue.state_reason!=='completed'||!issue.closed_at||!issue.closed_by)return null;
    const comments=(await this.list(`/issues/${number}/comments`)).map(value=>commentSchema.parse(value))
      .sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id-b.id);
    const proposals=comments.filter(c=>c.body.trim().startsWith(PROPOSAL_MARKER));
    if(!proposals.length)return null;
    if(proposals.length!==1)throw new Error('Keep exactly one current proposal comment on the issue');
    const candidate=proposals[0], proposal=parseProposal(candidate.body), hash=contributionHash(proposal);
    if(proposal.issue!==number)throw new Error('Proposal issue number does not match');
    if(candidate.updated_at>issue.closed_at)throw new Error('Proposal changed after completion; reopen and review again');
    if(issue.closed_by.type!=='User'||!await this.maintainer(issue.closed_by.login))throw new Error('Issue completion requires a repository maintainer');
    const latestDecisions=new Map<string,{login:string;approved:boolean}>();
    for(const c of comments) {
      const match=c.body.trim().match(/^\/(approve|revoke)-incident ([a-f0-9]{64})$/);
      if(!match||match[2]!==hash||c.user.type!=='User')continue;
      if(!await this.maintainer(c.user.login))continue;
      if(c.created_at>issue.closed_at)throw new Error('Review decision changed after completion; reopen and complete the issue again');
      if(c.updated_at!==c.created_at)throw new Error('Approval decisions must be new, unedited comments');
      if(c.created_at<candidate.updated_at)continue;
      latestDecisions.set(c.user.login.toLowerCase(),{login:c.user.login,approved:match[1]==='approve'});
    }
    const approved_by=[...latestDecisions.values()].filter(d=>d.approved).map(d=>d.login);
    if(approved_by.length<requiredApprovals(proposal))throw new Error('Proposal needs more current maintainer approvals');
    // All declared annotation reviewers must authenticate their approval of this exact payload.
    const reviewers=[...(proposal.record.impact_assessment?.reviews||[]),...(proposal.record.map?.reviews||[]),...(proposal.record.context?.reviews||[])];
    if(reviewers.some(r=>!approved_by.some(login=>login.toLowerCase()===r.reviewer.toLowerCase())))
      throw new Error('Every declared reviewer must approve this payload with their GitHub account');
    const latest=issueSchema.parse(await this.get(`/issues/${number}`));
    if(latest.state!=='closed'||latest.state_reason!=='completed'||latest.closed_at!==issue.closed_at||latest.updated_at!==issue.updated_at)
      throw new Error('Issue completion changed during review; no publication');
    return {proposal,proposal_comment_id:candidate.id,approved_by};
  }
  private async approvedResearch(issue:z.infer<typeof issueSchema>):Promise<ApprovedContribution|null> {
    if(issue.pull_request||(issue.state==='closed'&&issue.state_reason!=='completed'))return null;
    const draft=parseResearchIssue(issue.body!), hash=contributionHash(draft);
    const comments=(await this.list(`/issues/${issue.number}/comments`)).map(value=>commentSchema.parse(value))
      .sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id-b.id);
    if(comments.some(c=>c.body.includes(PROPOSAL_MARKER)))throw new Error('An issue must use one proposal protocol');
    const decisions=new Map<string,AuthenticatedReview|null>();
    for(const c of comments) {
      const match=c.body.trim().match(/^\/(approve|revoke)-incident ([a-f0-9]{64})$/);
      if(!match||match[2]!==hash||c.user.type!=='User'||!await this.maintainer(c.user.login))continue;
      if(c.updated_at!==c.created_at)throw new Error('Approval decisions must be new, unedited comments');
      decisions.set(c.user.login.toLowerCase(),match[1]==='approve'?{login:c.user.login,comment_id:c.id,created_at:c.created_at}:null);
    }
    const reviews=[...decisions.values()].filter((r):r is AuthenticatedReview=>r!==null);
    const required=impactScore(draft.record.impact_assessment).band==='Severe'?2:1;
    if(reviews.length<required)return null;
    const latestComments=(await this.list(`/issues/${issue.number}/comments`)).map(value=>commentSchema.parse(value));
    const latest=issueSchema.parse(await this.get(`/issues/${issue.number}`));
    if(latest.body!==issue.body||latest.state!==issue.state||latest.state_reason!==issue.state_reason||latest.updated_at!==issue.updated_at
      ||contributionHash(latestComments.sort((a,b)=>a.id-b.id))!==contributionHash([...comments].sort((a,b)=>a.id-b.id)))
      throw new Error('Research issue or review changed during verification');
    return {proposal:{version:'incident-contribution-v1',issue:issue.number,operation:'add',base_record_hash:null,
      record:reviewedResearchRecord(draft,issue.number,reviews)},proposal_comment_id:null,approved_by:reviews.map(r=>r.login),research:draft};
  }
}
