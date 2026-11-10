import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createPool, readSnapshot } from '../../dist/backend/database.js';
import { publish } from '../../dist/backend/publication.js';

// This command must fail when its real-PostgreSQL prerequisites are missing.
// Never run migration/publication fixtures against a shared or live database.
assert.match(process.env.PGDATABASE || '', /_test$/);
assert.ok(['127.0.0.1', 'localhost'].includes(process.env.PGHOST));
assert.ok(process.env.TEST_APP_PGPASSWORD, 'Set the disposable application-role password');
const run = promisify(execFile);
const command = (...args) => run(process.execPath, ['dist/backend/manage.js', ...args], {env: process.env});

async function server(appEnv) {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['dist/backend/app.js'], {env: {
    PGHOST: appEnv.PGHOST, PGPORT: appEnv.PGPORT, PGDATABASE: appEnv.PGDATABASE,
    PGUSER: appEnv.PGUSER, PGPASSWORD: appEnv.PGPASSWORD,
    HOST: '127.0.0.1', PORT: String(port), MARTIAN_ASK_ENABLED: 'true',
    MARTIAN_RADAR_MODE: 'sample', MARTIAN_RADAR_INTAKE_ENABLED: 'false',
    MARTIAN_ASK_ALLOWED_HOSTS: '127.0.0.1', AWS_EC2_METADATA_DISABLED: 'true',
    // Never inherit workload credentials, bearer tokens, profiles or remote
    // endpoints. A guard regression must fail locally before any inference.
    AWS_ACCESS_KEY_ID: 'local-test-only', AWS_SECRET_ACCESS_KEY: 'local-test-only',
    AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'http://127.0.0.1:9',
  }, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited: ${output}`);
      try { if ((await fetch(base + '/readyz')).status === 200) return {base, stop}; } catch {}
      await delay(100);
    }
    throw new Error(`Server did not become ready: ${output}`);
  } catch (error) { await stop(); throw error; }
}

test('migrated PostgreSQL and the real HTTP server preserve publication boundaries', {timeout: 60000}, async t => {
  const owner = await createPool();
  let reader;
  let http;
  try {
    await t.test('migrations and the explicit seed import are idempotent', async () => {
      await command('migrate');
      await command('migrate');
      await command('import', '--allow-draft');
      const before = (await owner.query('SELECT count(*)::int AS n FROM publications')).rows[0].n;
      await command('import', '--allow-draft');
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM publications')).rows[0].n, before);
    });
    const appEnv = {...process.env, PGUSER: 'project_martian_app', PGPASSWORD: process.env.TEST_APP_PGPASSWORD};
    delete appEnv.PGPASSWORD_FILE;
    // Use a separate pool with the actual read-only web role.
    const { Pool } = await import('pg');
    reader = new Pool({host: appEnv.PGHOST, port: Number(appEnv.PGPORT || 5432), database: appEnv.PGDATABASE,
      user: appEnv.PGUSER, password: appEnv.PGPASSWORD});
    await t.test('read-only web credentials cannot publish or read private Radar rows', async () => {
      const snapshot = await readSnapshot(reader);
      assert.ok(snapshot.records.length > 0);
      await assert.rejects(reader.query("INSERT INTO publications(actor,reason,source_hash,settings,repo) VALUES('test','test','test','{}','https://example.invalid')"), {code: '42501'});
      await assert.rejects(reader.query('SELECT * FROM radar_private.posts'), {code: '42501'});
    });
    await t.test('failed publication rolls back every row and successful publication is atomic', async () => {
      const snapshot = await readSnapshot(reader);
      const {publication, ...data} = snapshot;
      const broken = structuredClone(data);
      broken.records.push(broken.records[0]);
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await assert.rejects(publish(client, broken, 'local-test', 'Intentional duplicate rollback'), {code: '23505'});
        await client.query('ROLLBACK');
        assert.equal((await readSnapshot(reader)).publication.id, publication.id);
        data.records[0].t += ' [local test revision]';
        await client.query('BEGIN');
        const id = await publish(client, data, 'local-test', 'Atomic publication contract');
        assert.equal((await readSnapshot(reader)).publication.id, publication.id);
        await client.query('COMMIT');
        const current = await readSnapshot(reader);
        assert.equal(current.publication.id, id);
        assert.deepEqual(current.records, data.records);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
    http = await server(appEnv);
    await t.test('actual API serves persisted content and rejects unsafe Ask requests before inference', async () => {
      const get = async (path, options) => fetch(http.base + path, options);
      const archive = await get('/api/archive');
      assert.equal(archive.status, 200);
      assert.equal(archive.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await archive.json()).records, (await readSnapshot(reader)).records);
      assert.equal((await get('/api/incidents/unknown-synthetic-incident')).status, 404);
      // Fetch normalizes Host to the URL; send the literal header over HTTP.
      const invalidHost = await new Promise((resolve, reject) => {
        const request = httpRequest(http.base + '/api/archive', {headers: {host: 'untrusted.invalid'}}, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject); request.end();
      });
      assert.equal(invalidHost, 400);
      assert.equal((await get('/backend/app.ts')).status, 404);
      assert.equal((await get('/')).status, 200);
      const post = body => ({method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
      assert.equal((await get('/api/ask', post({question: ''}))).status, 400);
      assert.equal((await get('/api/ask', {...post({question: 'test'}), headers: {'content-type': 'application/json', origin: 'https://untrusted.invalid'}})).status, 403);
      assert.equal((await get('/api/ask', post({question: 'test', history: [{question: 'q', answer: 'a', record_ids: ['unknown-synthetic-incident']}]}))).status, 400);
      assert.equal((await get('/api/ask', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{'})).status, 400);
      assert.equal((await get('/api/ask', post({question: 'x'.repeat(270000)}))).status, 413);
    });
  } finally {
    await http?.stop();
    await reader?.end();
    await owner.end();
  }
});
