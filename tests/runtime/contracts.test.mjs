import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePublication, publicationHash } from '../../dist/backend/publication.js';
import { askSchema, checkFilter } from '../../dist/backend/ask-models.js';
import { archiveSession } from '../../dist/backend/mcp-records.js';

const load = async name => JSON.parse(await readFile(new URL('../../data/' + name, import.meta.url), 'utf8'));
const seed = validatePublication({ ...await load('publication-seed.json'), records: await load('records.json') });

test('publication rejects duplicate identities and broken source references', () => {
  const duplicate = structuredClone(seed);
  duplicate.records.push(duplicate.records[0]);
  assert.throws(() => validatePublication(duplicate), /Duplicate incident IDs/);
  const broken = structuredClone(seed);
  broken.microtrends['unknown-synthetic-incident'] = {p: [['Fixture', 'Fixture']], act: '', exp: '', cat: ''};
  assert.throws(() => validatePublication(broken), /unknown incident/);
});

test('publication dates and calendar bounds are validated before persistence', () => {
  const impossible = structuredClone(seed);
  impossible.records[0].d = '2026-02-30';
  assert.throws(() => validatePublication(impossible));
  const reversed = structuredClone(seed);
  reversed.settings.chart_end = '2000-01';
  assert.throws(() => validatePublication(reversed), /Invalid display calendar/);
});

test('publication hash is stable across object key order and changes with content', () => {
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  assert.equal(publicationHash(seed), publicationHash(reorder(seed)));
  const changed = structuredClone(seed);
  changed.records[0].sum += ' Synthetic revision.';
  assert.notEqual(publicationHash(seed), publicationHash(changed));
});

test('Ask rejects oversized conversations and invalid calendar filters', () => {
  assert.equal(askSchema.safeParse({question: 'x'.repeat(901)}).success, false);
  assert.equal(askSchema.safeParse({question: 'test', history: Array(7).fill({question: 'q', answer: 'a', record_ids: []})}).success, false);
  assert.equal(askSchema.safeParse({question: 'test', history: [{question: 'q', answer: 'a', record_ids: Array(257).fill('fixture')}]}).success, false);
  assert.throws(() => checkFilter({scope: 'all', start_date: '2026-02-30', end_date: ''}));
  assert.throws(() => checkFilter({scope: 'all', start_date: '2026-11-01', end_date: '2026-10-01'}));
});

test('MCP archive evidence must come from this request catalog', async () => {
  const session = await archiveSession({...seed, publication: {id: 'fixture', published_at: '2026-11-10T00:00:00Z', source_hash: publicationHash(seed)}});
  try {
    const call = (name, args) => session.client.callTool({name, arguments: args});
    assert.equal((await call('get_incident_details', {record_ids: [seed.records[0].id]})).isError, true);
    const catalog = await call('list_incidents', {scope: 'all', start_date: '', end_date: ''});
    assert.equal(catalog.structuredContent.complete, true);
    assert.equal(catalog.structuredContent.count, seed.records.length);
    const detail = await call('get_incident_details', {record_ids: [seed.records[0].id]});
    assert.equal(detail.structuredContent.records[0].id, seed.records[0].id);
    assert.equal((await call('get_incident_details', {record_ids: [seed.records[0].id, seed.records[0].id]})).isError, true);
    assert.equal((await call('get_incident_details', {record_ids: ['unknown-synthetic-incident']})).isError, true);
  } finally { await session.close(); }
});
