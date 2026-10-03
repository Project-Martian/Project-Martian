import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import type { Snapshot, Incident, Microtrend } from './types.js';
import { impactScore } from './impact.js';

export async function createPool(options: {max?:number;prefix?:string} = {}) {
  const env=(name:string)=>process.env[(options.prefix||'')+name];
  const password = env('PGPASSWORD_FILE')
    ? (await readFile(env('PGPASSWORD_FILE')!, 'utf8')).trim()
    : env('PGPASSWORD');
  if (!env('PGHOST') || !env('PGDATABASE') || !env('PGUSER') || !password) {
    throw new Error('PGHOST, PGDATABASE, PGUSER and PGPASSWORD_FILE (or PGPASSWORD) are required');
  }
  const pool = new Pool({
    host: env('PGHOST'), port: Number(env('PGPORT') || 5432),
    database: env('PGDATABASE'), user: env('PGUSER'), password,
    max: options.max||5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15000, application_name: 'project-martian',
    keepAlive: true, keepAliveInitialDelayMillis: 45000,
  });
  pool.on('error', () => process.stderr.write('Idle database connection failed\n'));
  return pool;
}

export async function readSnapshot(pool: Pool): Promise<Snapshot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = await readSnapshotClient(client);
    await client.query('COMMIT');
    return snapshot;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Caller owns the transaction, allowing publication workers to read under the publication lock.
export async function readSnapshotClient(client: PoolClient): Promise<Snapshot> {
  const result = await client.query('SELECT id::text, created_at, source_hash, settings, repo FROM publications ORDER BY id DESC LIMIT 1');
  if (!result.rows.length) throw new Error('No published archive; run the explicit initial import');
  const publication = result.rows[0];
  const records = await readRecords(client, publication.id);
  const micro = await client.query(`SELECT r.incident_id, r.action, r.exposure, r.category,
    jsonb_agg(jsonb_build_array(s.organization_name, s.name) ORDER BY rs.position) AS pairs
    FROM incident_revisions r JOIN revision_systems rs ON rs.revision_id=r.id
    JOIN systems s ON s.id=rs.system_id WHERE r.publication_id=$1
    GROUP BY r.id`, [publication.id]);
  const microtrends: Record<string, Microtrend> = {};
  for (const row of micro.rows) microtrends[row.incident_id] = { p: row.pairs, act: row.action, exp: row.exposure, cat: row.category };
  const signals = await client.query('SELECT content || jsonb_build_object(\'id\',id,\'sample\',is_sample) AS value FROM radar_signals WHERE publication_id=$1 ORDER BY position', [publication.id]);
  const clusters = await client.query('SELECT content || jsonb_build_object(\'k\',id,\'sample\',is_sample) AS value FROM radar_clusters WHERE publication_id=$1 ORDER BY position', [publication.id]);
  return {
    publication: { id: publication.id, published_at: publication.created_at.toISOString(), source_hash: publication.source_hash },
    repo: publication.repo, settings: publication.settings, records, microtrends,
    radar: { signals: signals.rows.map(r => r.value), clusters: clusters.rows.map(r => r.value) },
  };
}

async function readRecords(client: PoolClient, publicationId: string): Promise<Incident[]> {
  const result = await client.query(`SELECT r.incident_id AS id, r.scope, to_char(r.sort_date,'YYYY-MM-DD') AS d,
    r.title, r.organization_display, r.content,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(s.label,s.title,s.url,s.date_label) ORDER BY s.position)
      FROM revision_sources s WHERE s.revision_id=r.id),'[]'::jsonb) AS srcs,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(e.date_label,e.title,e.description) ORDER BY e.position)
      FROM incident_events e WHERE e.revision_id=r.id),'[]'::jsonb) AS th
    FROM incident_revisions r WHERE r.publication_id=$1 ORDER BY r.sort_date DESC NULLS LAST,r.id`, [publicationId]);
  return result.rows.map(row => ({ ...row.content, id: row.id, scope: row.scope, d: row.d || '',
    t: row.title, org: row.organization_display, srcs: row.srcs, th: row.th }));
}

export async function readImpactHistory(pool: Pool, incidentId: string) {
  const result = await pool.query(`SELECT p.id::text AS publication_id, p.created_at, p.actor, p.reason,
    r.content->'impact_assessment' AS assessment
    FROM incident_revisions r JOIN publications p ON p.id=r.publication_id
    WHERE r.incident_id=$1 ORDER BY p.id`, [incidentId]);
  if (!result.rows.length) return null;
  let previous: string | undefined;
  return result.rows.flatMap(row => {
    const serialized = JSON.stringify(row.assessment);
    if (serialized === previous) return [];
    previous = serialized;
    return [{publication_id: row.publication_id, changed_at: row.created_at.toISOString(),
      actor: row.actor, reason: row.reason, assessment: row.assessment,
      impact: row.assessment ? impactScore(row.assessment) : null}];
  });
}

export async function readMappingHistory(pool: Pool, incidentId: string) {
  const result = await pool.query(`SELECT p.id::text AS publication_id, p.created_at, p.actor, p.reason,
    r.content->'map' AS mapping,
    jsonb_build_object('act',r.action,'exp',r.exposure,'cat',r.category,'p',
      (SELECT jsonb_agg(jsonb_build_array(s.organization_name,s.name) ORDER BY rs.position)
       FROM revision_systems rs JOIN systems s ON s.id=rs.system_id WHERE rs.revision_id=r.id)) AS legacy_mapping
    FROM incident_revisions r JOIN publications p ON p.id=r.publication_id
    WHERE r.incident_id=$1 ORDER BY p.id`, [incidentId]);
  if (!result.rows.length) return null;
  let previous: string | undefined;
  return result.rows.flatMap(row => {
    const serialized = JSON.stringify(row.mapping || row.legacy_mapping);
    if (serialized === previous) return [];
    previous = serialized;
    return [{publication_id: row.publication_id, changed_at: row.created_at.toISOString(),
      actor: row.actor, reason: row.reason, mapping: row.mapping, legacy_mapping: row.mapping ? null : row.legacy_mapping}];
  });
}

export async function readContextHistory(pool: Pool, incidentId: string) {
  const result = await pool.query(`SELECT p.id::text AS publication_id, p.created_at, p.actor, p.reason,
    r.content->'context' AS context FROM incident_revisions r JOIN publications p ON p.id=r.publication_id
    WHERE r.incident_id=$1 ORDER BY p.id`, [incidentId]);
  if (!result.rows.length) return null;
  let previous: string | undefined;
  return result.rows.flatMap(row => {
    const serialized = JSON.stringify(row.context);
    if (serialized === previous) return [];
    previous = serialized;
    return [{publication_id: row.publication_id, changed_at: row.created_at.toISOString(), actor: row.actor, reason: row.reason, context: row.context}];
  });
}

export async function readContributions(pool: Pool, publicationId: string) {
  const result=await pool.query(`SELECT issue_number,incident_id,operation,publication_id::text,published_at
    FROM contribution_publications WHERE publication_id<=$1 ORDER BY issue_number`,[publicationId]);
  return result.rows.map(row=>({...row,published_at:row.published_at.toISOString()}));
}
