import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createPool, readSnapshot } from './database.js';
import { publish, validatePublication, publicationHash } from './publication.js';

const {positionals,values}=parseArgs({allowPositionals:true,options:{actor:{type:'string'},reason:{type:'string'},'allow-draft':{type:'boolean'}}});
const [command,file]=positionals;
const pool=await createPool();
try {
  if (command==='export') {
    const {publication,...data}=await readSnapshot(pool);
    process.stdout.write(JSON.stringify(data,null,2)+'\n');
  } else if (command==='migrate') {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(725109)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const directory=new URL('../../db/migrations/',import.meta.url);
      for (const name of (await readdir(directory)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort()) {
        const sql=await readFile(new URL(name,directory),'utf8');
        const hash=createHash('sha256').update(sql).digest('hex');
        const existing=await client.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
        if (existing.rows.length) {
          if (existing.rows[0].sha256!==hash) throw new Error('Applied migration was modified: '+name);
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);
        console.log('Applied migration',name);
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  } else if (command==='import' || command==='publish') {
    const data=command==='import'
      ? validatePublication({...JSON.parse(await readFile(new URL('../../data/publication-seed.json',import.meta.url),'utf8')),
          records:JSON.parse(await readFile(new URL('../../data/records.json',import.meta.url),'utf8'))})
      : validatePublication(JSON.parse(await readFile(file || '', 'utf8')));
    if((data.settings.impact_review_mode==='draft'||data.settings.microtrends_review_mode==='draft'||data.settings.context_review_mode==='draft')&&!values['allow-draft']) {
      throw new Error('Draft publication requires --allow-draft; use only for an explicitly labelled review preview');
    }
    const actor=values.actor || (command==='import' ? 'legacy-archive-import' : '');
    const reason=values.reason || (command==='import' ? 'Preserve existing published records, chart methodology and labelled Radar samples' : '');
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(725109)');
      const imported=command==='import' ? await client.query('SELECT source_hash FROM import_history WHERE name=$1',['legacy-archive-v1']) : null;
      if (imported?.rows.length) {
        if (imported.rows[0].source_hash!==publicationHash(data)) throw new Error('Initial import already exists with different inputs; use an explicit reviewed publication');
        console.log('Initial archive already imported; no changes');
      } else {
        if (command==='import' && (await client.query('SELECT 1 FROM publications LIMIT 1')).rows.length) throw new Error('Refusing initial import into an existing publication');
        const id=await publish(client,data,actor,reason);
        if (command==='import') await client.query('INSERT INTO import_history VALUES($1,$2,$3)',['legacy-archive-v1',publicationHash(data),id]);
        console.log(JSON.stringify({publication_id:id,records:data.records.length,source_hash:publicationHash(data)}));
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  } else {throw new Error('Use migrate, import, export, or publish FILE --actor NAME --reason TEXT');}
} catch(error) {
  // Do not print database parameters or record contents on a failed operation.
  console.error(error instanceof Error ? error.message : 'Database operation failed');
  process.exitCode=1;
} finally {await pool.end();}
