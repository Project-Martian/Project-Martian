import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Incident, Publication } from './types.js';

export const IMPACT_VERSION = 'impact-v1';
export const IMPACT_REFERENCE = 300;
const dimension = z.number().int().min(0).max(3);
const landed = z.enum(['sandbox', 'company', 'world']);
const reason = z.string().trim().min(1).max(2000);
const valuesSchema = z.strictObject({damage: dimension, reach: dimension, reversal: dimension, landed});
export const impactSchema = valuesSchema.extend({
  version: z.literal(IMPACT_VERSION),
  proposed_by: reason, proposed_at: z.iso.datetime(),
  source_check: z.enum(['curated-record', 'source-read']),
  behavior: z.enum(['autonomous', 'human-directed', 'unclear', 'not-agent']),
  evidence: z.enum(['confirmed', 'reported', 'alleged']),
  estimated: z.array(z.enum(['damage', 'reach', 'reversal', 'landed'])),
  why: z.strictObject({damage: reason, reach: reason, reversal: reason, landed: reason, behavior: reason}),
  source_urls: z.array(z.url()).min(1),
  reviews: z.array(z.strictObject({
    reviewer: reason, reviewed_at: z.iso.datetime(), assessment_hash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approve', 'dispute']), values: valuesSchema, note: reason,
  })),
});
export type ImpactAssessment = z.infer<typeof impactSchema>;
export type ImpactValues = z.infer<typeof valuesSchema>;
const quarterUnits = {sandbox: 1, company: 2, world: 4};

export function impactScore(assessment: ImpactValues) {
  const units = (assessment.damage + assessment.reach + assessment.reversal) * quarterUnits[assessment.landed];
  const points = units * 100 / 36;
  const score = Math.round(points);
  const band = score >= 80 ? 'Severe' : score >= 50 ? 'Serious' : score >= 20 ? 'Notable' : 'Contained';
  return {units, points, score, band};
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}';
  return JSON.stringify(value);
}

// Bind reviews to both the assessment and the incident evidence they reviewed.
export function assessmentHash(record: Incident) {
  if (!record.impact_assessment) throw new Error('Missing impact assessment: ' + record.id);
  const {reviews: _reviews, ...assessment} = record.impact_assessment;
  // Annotation reviews are independent; each still binds to the original incident evidence.
  const {map: _map, context: _context, ...evidence} = record;
  return createHash('sha256').update(canonical({...evidence, impact_assessment: assessment})).digest('hex');
}

export function assessmentState(record: Incident) {
  const a = record.impact_assessment!;
  const hash = assessmentHash(record);
  const reviews = a.reviews.filter(review => review.assessment_hash === hash);
  const disputed = reviews.some(review => review.decision === 'dispute'
    || review.values.landed !== a.landed
    || (['damage', 'reach', 'reversal'] as const).some(key => Math.abs(review.values[key] - a[key]) > 1))
    || reviews.some(first => reviews.some(second =>
      (['damage', 'reach', 'reversal'] as const).some(key => Math.abs(first.values[key] - second.values[key]) > 1)));
  if (disputed) return 'disputed';
  const required = impactScore(a).band === 'Severe' ? 2 : 1;
  const approved = new Set(reviews.filter(review => review.decision === 'approve').map(review => review.reviewer.toLowerCase()));
  return approved.size >= required ? 'reviewed' : 'draft';
}

export function validateAssessments(data: Publication) {
  for (const record of data.records) {
    const a = record.impact_assessment;
    if (!a) {
      if (data.settings.methodology_version === IMPACT_VERSION) throw new Error('Missing impact assessment: ' + record.id);
      continue;
    }
    const urls = new Set([record.u, ...record.srcs.map(source => source[2])]);
    if (a.source_urls.some(url => !urls.has(url))) throw new Error('Assessment must cite this record’s sources: ' + record.id);
    if (new Set(a.estimated).size !== a.estimated.length) throw new Error('Duplicate estimated dimension: ' + record.id);
    if ((record.scope === 'agents') === (a.behavior === 'not-agent')) throw new Error('Assessment behavior conflicts with record scope: ' + record.id);
    if (a.reviews.some(review => review.assessment_hash !== assessmentHash(record))) throw new Error('Stale impact review: ' + record.id);
    if (new Set(a.reviews.map(review => review.reviewer.toLowerCase())).size !== a.reviews.length) throw new Error('One review per reviewer and assessment: ' + record.id);
    if (data.settings.impact_review_mode === 'reviewed' && assessmentState(record) !== 'reviewed') {
      throw new Error('Impact assessment needs review: ' + record.id);
    }
  }
}

const monthNumber = (month: string) => {const [y, m] = month.split('-').map(Number); return y * 12 + m - 1;};

export function impactIndex(data: Publication, months: [number, number][]) {
  if (data.settings.methodology_version !== IMPACT_VERSION) throw new Error('Impact methodology is not enabled');
  const incidents = data.records.map(record => {
    const a = record.impact_assessment!;
    if (!a) throw new Error('Missing impact assessment: ' + record.id);
    const state = assessmentState(record);
    const exclusion = record.scope !== 'agents' ? 'not-agent' : !record.d ? 'undated' : null;
    return {id: record.id, title: record.t, date: record.d, ...impactScore(a), landed: a.landed,
      evidence: a.evidence, behavior: a.behavior, estimated: a.estimated, review_status: state, exclusion};
  });
  const eligible = incidents.filter(incident => !incident.exclusion);
  const series = months.map(([year, month]) => {
    const ordinal = year * 12 + month;
    const inMonth = eligible.filter(incident => monthNumber(incident.date.slice(0, 7)) === ordinal);
    const window = eligible.filter(incident => {
      const n = monthNumber(incident.date.slice(0, 7)); return n >= ordinal - 2 && n <= ordinal;
    });
    const units = window.reduce((sum, incident) => sum + incident.units, 0);
    const points = units * 100 / 36;
    const worldPoints = window.filter(incident => incident.landed === 'world').reduce((sum, incident) => sum + incident.units, 0) * 100 / 36;
    return {month: `${year}-${String(month + 1).padStart(2, '0')}`, index: Math.min(100, Math.round(points / IMPACT_REFERENCE * 100)),
      points, capped: points > IMPACT_REFERENCE, monthly_points: inMonth.reduce((sum, incident) => sum + incident.units, 0) * 100 / 36,
      real_world_index: Math.min(100, Math.round(worldPoints / IMPACT_REFERENCE * 100)),
      incidents: inMonth, window_incident_ids: window.map(incident => incident.id)};
  });
  return {version: IMPACT_VERSION, reference_points: IMPACT_REFERENCE, window_months: 3,
    review_mode: data.settings.impact_review_mode!, include_human_directed: true,
    series, assessments: incidents, coverage: {total: incidents.length,
      reviewed: incidents.filter(incident => incident.review_status === 'reviewed').length,
      draft: incidents.filter(incident => incident.review_status === 'draft').length,
      disputed: incidents.filter(incident => incident.review_status === 'disputed').length,
      eligible: eligible.length, excluded: incidents.filter(incident => incident.exclusion).map(({id, exclusion}) => ({id, reason: exclusion}))}};
}
