import { readFile, writeFile, rename } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CONTEXT_VERSION, contextHash, contextSchema, contextState, narrativeAnalytics, comparisonAnalytics } from './context.js';
import { publicationHash, validatePublication } from './publication.js';

const {positionals, values} = parseArgs({allowPositionals: true, options: {
  record: {type: 'string'}, reviewer: {type: 'string'}, decision: {type: 'string'}, note: {type: 'string'},
}});
const [command, file, auditFile, output] = positionals;
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
try {
  const data = validatePublication(await read(file));
  if (command === 'prepare') {
    const audit = z.strictObject({version: z.literal(CONTEXT_VERSION), based_on_source_hash: z.string(), as_of: z.iso.date(),
      contexts: z.record(z.string(), contextSchema)}).parse(await read(auditFile));
    if (audit.based_on_source_hash !== publicationHash(data)) throw new Error('Context audit targets a different publication; review changed evidence');
    const agents = data.records.filter(r => r.scope === 'agents');
    if (agents.length !== Object.keys(audit.contexts).length || agents.some(r => !audit.contexts[r.id])) throw new Error('Audit must cover each agent record exactly once');
    data.settings.context_version = CONTEXT_VERSION;
    data.settings.context_review_mode = 'draft';
    data.settings.context_as_of = audit.as_of;
    for (const r of agents) r.context = audit.contexts[r.id];
    validatePublication(data);
    await writeFile(output, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    console.log('Prepared context draft:', output);
  } else if (command === 'report') {
    if (data.settings.context_version !== CONTEXT_VERSION) throw new Error('Prepare the context publication first');
    console.log(JSON.stringify({narrative: narrativeAnalytics(data), comparison: comparisonAnalytics(data),
      hashes: Object.fromEntries(data.records.filter(r => r.context).map(r => [r.id, contextHash(r)]))}, null, 2));
  } else if (command === 'review') {
    const r = data.records.find(r => r.id === values.record);
    if (!r?.context) throw new Error('Specify a record with context');
    const reviewer = values.reviewer?.trim();
    if (!reviewer || !values.note?.trim() || !['approve', 'dispute'].includes(values.decision || ''))
      throw new Error('Review requires reviewer, note and decision approve|dispute');
    r.context = contextSchema.parse({...r.context, reviews: [
      ...r.context.reviews.filter(v => v.reviewer.toLowerCase() !== reviewer.toLowerCase()),
      {reviewer, note: values.note, decision: values.decision, reviewed_at: new Date().toISOString(), context_hash: contextHash(r)},
    ]});
    validatePublication(data);
    const temporary = file + '.review-' + process.pid;
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    await rename(temporary, file);
    console.log(JSON.stringify({id: r.id, status: contextState(r)}));
  } else throw new Error('Use prepare EXPORT AUDIT OUTPUT, report FILE, or review FILE --record ID --reviewer NAME --decision approve|dispute --note TEXT');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Context operation failed');
  process.exitCode = 1;
}
