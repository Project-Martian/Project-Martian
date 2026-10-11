import type { IncomingHttpHeaders } from 'node:http';
import type { Pool } from 'pg';
import { SourceError, getJsonResponse } from './network.js';

function resetAt(provider:'x'|'reddit',headers:IncomingHttpHeaders):Date|null {
  const dates:number[]=[];
  const retry=headers['retry-after'];
  if(typeof retry==='string')dates.push(/^\d+(\.\d+)?$/.test(retry)?Date.now()+Number(retry)*1000:Date.parse(retry));
  const reset=headers[provider==='x'?'x-rate-limit-reset':'x-ratelimit-reset'];
  if(typeof reset==='string'&&/^\d+(\.\d+)?$/.test(reset))dates.push(provider==='x'?Number(reset)*1000:Date.now()+Number(reset)*1000);
  const valid=dates.filter(n=>Number.isFinite(n)&&n>Date.now());
  return valid.length?new Date(Math.max(...valid)):null;
}
export async function checkRateLimit(pool:Pool,provider:'x'|'reddit') {
  const state=(await pool.query('SELECT manual_pause,resume_after FROM radar_private.provider_state WHERE provider=$1',[provider])).rows[0];
  if(!state)throw new SourceError('provider-control-missing');
  if(state.manual_pause||state.resume_after&&state.resume_after.getTime()>Date.now())throw new SourceError('provider-rate-paused');
}
export async function providerJson(pool:Pool,provider:'x'|'reddit',url:string,headers:Record<string,string>,body?:string) {
  await checkRateLimit(pool,provider);
  try{
    const response=await getJsonResponse(url,headers,body);
    const remaining=response.headers[provider==='x'?'x-rate-limit-remaining':'x-ratelimit-remaining'];
    if(typeof remaining==='string'&&Number(remaining)<=0){
      const at=resetAt(provider,response.headers);
      await pool.query('UPDATE radar_private.provider_state SET resume_after=$2,manual_pause=$3,updated_at=now() WHERE provider=$1',[provider,at,!at]);
    }
    return response.data;
  }catch(error){
    if(error instanceof SourceError&&error.code==='http-429'){
      const at=resetAt(provider,error.headers);
      await pool.query('UPDATE radar_private.provider_state SET resume_after=$2,manual_pause=$3,updated_at=now() WHERE provider=$1',[provider,at,!at]);
    }
    throw error;
  }
}
