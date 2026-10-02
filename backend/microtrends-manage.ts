import { readFile, writeFile, rename } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { buildMicrotrends, mappingHash, mappingSchema, mappingState, microtrendsMetadata, MICRO_VERSION } from './microtrends.js';
import { publicationHash, validatePublication } from './publication.js';

const {positionals, values} = parseArgs({allowPositionals:true, options:{
  record:{type:'string'}, reviewer:{type:'string'}, decision:{type:'string'}, note:{type:'string'},
}});
const [command, file, mappingsFile, output] = positionals;
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
try {
  const input = await read(file);
  if (command === 'build') {
    input.records = input.records.map((record: {map: unknown}) => ({...record, map:mappingSchema.parse(record.map)}));
    input.microtrends = buildMicrotrends(input.records);
  }
  const data = validatePublication(input);
  if (command === 'prepare') {
    const draft = z.strictObject({version:z.literal(MICRO_VERSION), based_on_source_hash:z.string(),
      mappings:z.record(z.string(),mappingSchema)}).parse(await read(mappingsFile));
    if (draft.based_on_source_hash !== publicationHash(data)) throw new Error('Mappings target a different publication; re-review the changed evidence');
    if (Object.keys(draft.mappings).length !== data.records.length || data.records.some(record => !draft.mappings[record.id])) throw new Error('Draft must cover every record exactly once');
    data.settings.microtrends_version = MICRO_VERSION;
    data.settings.microtrends_review_mode = 'draft';
    for (const record of data.records) record.map = draft.mappings[record.id];
    data.microtrends = buildMicrotrends(data.records);
    validatePublication(data);
    await writeFile(output, JSON.stringify(data,null,2)+'\n', {flag:'wx',mode:0o600});
    console.log('Prepared draft publication:', output);
  } else if (command === 'report') {
    if (!data.settings.microtrends_version) throw new Error('Prepare a mapping publication first');
    process.stdout.write(JSON.stringify({...microtrendsMetadata(data), mappings:data.records.map(record => ({
      id:record.id, mapping_hash:mappingHash(record), status:mappingState(record), map:record.map,
    }))},null,2)+'\n');
  } else if (command === 'review') {
    const record = data.records.find(record => record.id === values.record);
    if (!record?.map) throw new Error('Specify a mapped --record');
    if (!values.reviewer?.trim() || !values.note?.trim()) throw new Error('Review requires --reviewer and --note');
    if (!['approve','dispute'].includes(values.decision || '')) throw new Error('Review requires --decision approve or dispute');
    const map = record.map;
    record.map = mappingSchema.parse({...map, reviews:[
      ...map.reviews.filter(review => review.reviewer.toLowerCase() !== values.reviewer!.trim().toLowerCase()),
      {reviewer:values.reviewer, reviewed_at:new Date().toISOString(), mapping_hash:mappingHash(record), decision:values.decision, note:values.note},
    ]});
    validatePublication(data);
    const temporary = file + '.review-' + process.pid;
    await writeFile(temporary,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
    await rename(temporary,file);
    console.log(JSON.stringify({id:record.id,status:mappingState(record)}));
  } else if (command === 'build') {
    if (!data.settings.microtrends_version) throw new Error('Prepare a mapping publication first');
    process.stdout.write(JSON.stringify(data,null,2)+'\n');
  } else throw new Error('Use prepare EXPORT MAPPINGS OUTPUT, report FILE, build FILE, or review FILE --record ID --reviewer NAME --decision approve|dispute --note TEXT');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Mapping operation failed');
  process.exitCode = 1;
}
