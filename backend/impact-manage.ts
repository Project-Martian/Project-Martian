import { readFile, writeFile, rename } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { analytics } from './analytics.js';
import { assessmentHash, assessmentState, impactSchema, impactScore } from './impact.js';
import { publicationHash, validatePublication } from './publication.js';

const {positionals, values} = parseArgs({allowPositionals: true, options: {
  record: {type: 'string'}, reviewer: {type: 'string'}, decision: {type: 'string'}, note: {type: 'string'},
  damage: {type: 'string'}, reach: {type: 'string'}, reversal: {type: 'string'}, landed: {type: 'string'},
}});
const [command, file, assessmentsFile, output] = positionals;
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
try {
  const data = validatePublication(await read(file));
  if (command === 'prepare') {
    const draft = z.strictObject({version: z.literal('impact-v1'), based_on_source_hash: z.string(),
      assessments: z.record(z.string(), impactSchema)}).parse(await read(assessmentsFile));
    if (draft.based_on_source_hash !== publicationHash(data)) throw new Error('Draft assessments target a different publication; re-review the changed evidence');
    if (Object.keys(draft.assessments).length !== data.records.length
      || data.records.some(record => !draft.assessments[record.id])) throw new Error('Draft must cover every record exactly once');
    data.settings.methodology_version = 'impact-v1';
    data.settings.impact_review_mode = 'draft';
    for (const record of data.records) record.impact_assessment = draft.assessments[record.id];
    validatePublication(data);
    await writeFile(output, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    console.log('Prepared draft publication:', output);
  } else if (command === 'report') {
    const impact = analytics(data).impact;
    if (!impact) throw new Error('Prepare an impact-v1 publication first');
    process.stdout.write(JSON.stringify({...impact, assessments: impact.assessments.map(assessment => {
      const record = data.records.find(record => record.id === assessment.id)!;
      return {...assessment, assessment_hash: assessmentHash(record), assessment: record.impact_assessment};
    })}, null, 2) + '\n');
  } else if (command === 'review') {
    if (data.settings.methodology_version !== 'impact-v1') throw new Error('Prepare an impact-v1 publication first');
    const record = data.records.find(record => record.id === values.record);
    if (!record?.impact_assessment) throw new Error('Specify a known --record');
    const a = record.impact_assessment;
    const reviewer = values.reviewer?.trim();
    if (!reviewer || !values.note?.trim()) throw new Error('Review requires --reviewer and --note');
    if (!['approve', 'dispute'].includes(values.decision || '')) throw new Error('Review requires --decision approve or dispute');
    const review = {
      reviewer, reviewed_at: new Date().toISOString(), assessment_hash: assessmentHash(record),
      decision: values.decision, note: values.note,
      values: {damage: values.damage === undefined ? a.damage : Number(values.damage),
        reach: values.reach === undefined ? a.reach : Number(values.reach),
        reversal: values.reversal === undefined ? a.reversal : Number(values.reversal),
        landed: values.landed === undefined ? a.landed : values.landed},
    };
    record.impact_assessment = impactSchema.parse({...a, reviews: [
      ...a.reviews.filter(review => review.reviewer.toLowerCase() !== reviewer.toLowerCase()), review,
    ]});
    validatePublication(data);
    // Replace a reviewed input atomically. Published database revisions remain immutable.
    const temporary = file + '.review-' + process.pid;
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    await rename(temporary, file);
    console.log(JSON.stringify({id: record.id, ...impactScore(record.impact_assessment), status: assessmentState(record)}));
  } else {
    throw new Error('Use prepare EXPORT ASSESSMENTS OUTPUT, report FILE, or review FILE --record ID --reviewer NAME --decision approve|dispute --note TEXT');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Impact operation failed');
  process.exitCode = 1;
}
