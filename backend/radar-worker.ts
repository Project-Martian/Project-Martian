import { writeFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from './database.js';
import { sourceSchema, type Source } from './radar/schema.js';
import { discover } from './radar/discovery.js';
import { collect, refresh } from './radar/sources.js';
import { purge } from './radar/repository.js';
import { vet, cluster } from './radar/pipeline.js';
import { SourceError } from './radar/network.js';
import { BudgetError } from './radar/budget.js';

const heartbeat='/tmp/project-martian-radar-heartbeat';
if(process.argv.includes('--health')){
  try{const s=await stat(heartbeat);if(Date.now()-s.mtimeMs>180000)process.exitCode=1;}catch{process.exitCode=1;}
}else{
  const pool=await createPool({max:2});
  const lock=await pool.connect();
  let stop=false;const controller=new AbortController();
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stop=true;controller.abort();});
  try{
    if(!(await lock.query('SELECT pg_try_advisory_lock(725110) AS acquired')).rows[0].acquired)throw new Error('worker-already-running');
    do{
      await purge(pool);
      let sourceFailed=false;
      const configured=(await pool.query('SELECT * FROM radar_private.sources WHERE enabled ORDER BY id')).rows;
      for(const row of configured){
        if(stop)break;
        const source:Source={...sourceSchema.parse({id:row.id,platform:row.platform,enabled:row.enabled,approved_by:row.approved_by,
          retention_hours:row.retention_hours,requests_per_day:row.requests_per_day,publication_mode:row.publication_mode,
          page_size:row.page_size,refresh_limit:row.refresh_limit,config:row.config}),cursor:row.cursor,last_attempt:row.last_attempt};
        try{
          if(!source.last_attempt||process.argv.includes('--once')||Date.now()-source.last_attempt.getTime()>=3600000){
            await pool.query('UPDATE radar_private.sources SET last_attempt=now() WHERE id=$1',[source.id]);
            if(source.config.kind==='web-search')await discover(pool,source);
            else {await refresh(pool,source);await collect(pool,source);}
          }
        }catch(error){
          sourceFailed=true;
          const code=error instanceof SourceError?error.code:error instanceof BudgetError?error.message:
            error instanceof Error&&error.message==='daily-budget-exhausted'?'daily-budget-exhausted':'source-processing-error';
          await pool.query('UPDATE radar_private.sources SET last_error=$2 WHERE id=$1',[source.id,code]);
          console.warn('Radar source failed:',source.id,code);
        }
        await writeFile(heartbeat,String(Date.now()));
      }
      const progress=()=>writeFile(heartbeat,String(Date.now()));
      let status=sourceFailed?'source-error':'running';
      try{await vet(pool,progress);await cluster(pool,progress);}catch(error){
        status=error instanceof BudgetError?error.message:error instanceof Error&&error.message==='daily-budget-exhausted'?'daily-budget-exhausted':'pipeline-error';
        console.warn('Radar processing incomplete:',status);
      }
      await pool.query(`INSERT INTO radar_private.heartbeat VALUES('worker',now(),$1) ON CONFLICT(name) DO UPDATE SET checked_at=now(),status=EXCLUDED.status`,[status]);
      await writeFile(heartbeat,String(Date.now()));
      console.log(JSON.stringify({event:'radar-cycle-complete',status,at:new Date().toISOString()}));
      if(process.argv.includes('--once')&&status!=='running')process.exitCode=1;
      if(!stop&&!process.argv.includes('--once'))try{await delay(15000,undefined,{signal:controller.signal});}catch{}
    }while(!stop&&!process.argv.includes('--once'));
  }catch{console.error('Radar worker stopped; inspect configuration and database access');process.exitCode=1;}
  finally{await lock.query('SELECT pg_advisory_unlock(725110)').catch(()=>{});lock.release();await pool.end();}
}
