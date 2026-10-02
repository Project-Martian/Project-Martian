import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPool } from './database.js';
import { ContributionGitHub } from './contribution-github.js';
import { CONTRIBUTION_REPO, PROPOSAL_MARKER, proposalSchema, contributionHash, prepareContribution, publishContribution } from './contributions.js';
import { validatePublication } from './publication.js';

const {positionals:[command,file,publicationFile],values}=parseArgs({allowPositionals:true,options:{issue:{type:'string'},record:{type:'string'}}});
try {
  if(command==='propose') {
    const base=validatePublication(JSON.parse(await readFile(file,'utf8')));
    const reviewed=validatePublication(JSON.parse(await readFile(publicationFile,'utf8')));
    const record=reviewed.records.find(r=>r.id===values.record);
    if(!record)throw new Error('Specify the reviewed --record ID');
    const prior=base.records.find(r=>r.id===record.id);
    const proposal=proposalSchema.parse({version:'incident-contribution-v1',issue:Number(values.issue),
      operation:prior?'correct':'add',base_record_hash:prior?contributionHash(prior):null,record});
    prepareContribution(base,proposal);
    process.stdout.write(JSON.stringify(proposal,null,2)+'\n');
  } else if(command==='check') {
    const proposal=proposalSchema.parse(JSON.parse(await readFile(file,'utf8')));
    const data=validatePublication(JSON.parse(await readFile(publicationFile,'utf8')));
    prepareContribution(data,proposal);
    console.log(JSON.stringify({issue:proposal.issue,incident_id:proposal.record.id,proposal_hash:contributionHash(proposal),valid:true}));
  } else if(command==='format') {
    const proposal=proposalSchema.parse(JSON.parse(await readFile(file,'utf8')));
    process.stdout.write(PROPOSAL_MARKER+'\n```json\n'+JSON.stringify(proposal,null,2)+'\n```\n');
    process.stderr.write('Approval command: /approve-incident '+contributionHash(proposal)+'\n');
  } else if(command==='sync') {
    const tokenFile=process.env.MARTIAN_GITHUB_TOKEN_FILE;
    if(!tokenFile)throw new Error('MARTIAN_GITHUB_TOKEN_FILE is required');
    const github=new ContributionGitHub((await readFile(tokenFile,'utf8')).trim());
    const pool=await createPool();
    try {
      const numbers=values.issue?[Number(values.issue)]:(await github.closedIssues()).map(issue=>issue.number);
      let failures=0;
      for(const number of numbers) {
        if(!Number.isSafeInteger(number)||number<=0)throw new Error('Invalid issue number');
        const existing=await pool.query('SELECT publication_id::text FROM contribution_publications WHERE repository=$1 AND issue_number=$2',[CONTRIBUTION_REPO,number]);
        if(existing.rows.length){console.log(JSON.stringify({issue:number,status:'already-published',...existing.rows[0]}));continue;}
        try {
          const approved=await github.approved(number);
          if(!approved){console.log(JSON.stringify({issue:number,status:'not-approved-for-publication'}));continue;}
          const client=await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(725109)');
            const result=await publishContribution(client,approved);
            await client.query('COMMIT');
            console.log(JSON.stringify({issue:number,...result}));
          } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
        } catch(error){failures++;console.error(JSON.stringify({issue:number,status:'blocked',reason:error instanceof Error?error.message:'Publication failed'}));}
      }
      if(failures)process.exitCode=1;
    }finally{await pool.end();}
  } else throw new Error('Use propose BASE_JSON REVIEWED_JSON --issue NUMBER --record ID, check PROPOSAL_JSON PUBLICATION_JSON, format PROPOSAL_JSON, or sync [--issue NUMBER]');
}catch(error){console.error(error instanceof Error?error.message:'Contribution operation failed');process.exitCode=1;}
