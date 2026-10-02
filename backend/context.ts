import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Incident, Publication } from './types.js';
import { assessmentState } from './impact.js';

export const CONTEXT_VERSION = 'disclosure-comparison-v1';
const text = z.string().trim().min(1).max(2000);
const date = z.iso.date();
const url = z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol));
const urls = z.array(url).min(1);
export const publisherLabels = {vendor: 'Lab & vendor', research: 'Independent research', government: 'Government',
  media: 'News', individual: 'Individual & blog', other: 'Other', unknown: 'Unknown chronology', tied: 'Same-day sources'};
export const contextLabels = {training: 'Training', evaluation: 'Evaluation', research: 'Research use', deployment: 'Deployed use', unknown: 'Unknown context'};
export const landingLabels = {sandbox: 'Sandbox', company: 'Operating company', world: 'External users & systems', unknown: 'Unknown landing'};
export const contextSchema = z.strictObject({
  version: z.literal(CONTEXT_VERSION), proposed_by: text, proposed_at: z.iso.datetime(),
  occurrence: z.strictObject({start: date.nullable(), end: date.nullable(), precision: z.enum(['day', 'month', 'range', 'unknown']),
    note: text, source_urls: urls}),
  operating_context: z.strictObject({kind: z.enum(['training', 'evaluation', 'research', 'deployment', 'unknown']), note: text, source_urls: urls}),
  record_unit: z.enum(['single', 'grouped', 'campaign', 'unclear']), unit_note: text,
  sources: z.array(z.strictObject({url, publisher: text,
    publisher_type: z.enum(['vendor', 'research', 'government', 'media', 'individual', 'other']),
    role: z.enum(['provider', 'affected-party', 'evaluator', 'investigator', 'journalist', 'unknown']),
    kind: z.enum(['primary', 'original-reporting', 'secondary', 'syndicated']), origin: text,
    published_on: date.nullable(), updated_on: date.nullable(), checked_at: z.iso.datetime(),
    check: z.enum(['source-read', 'unavailable']), date_note: text,
  })).min(1),
  disclosure: z.strictObject({source_urls: z.array(url), note: text}),
  developments: z.array(z.strictObject({date: date.nullable(), kind: z.enum(['initial-report', 'response', 'follow-up', 'correction', 'unresolved']),
    text, source_urls: urls, limits: text})).max(30),
  reviews: z.array(z.strictObject({reviewer: text, reviewed_at: z.iso.datetime(), context_hash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approve', 'dispute']), note: text})),
});
export type IncidentContext = z.infer<typeof contextSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}';
  return JSON.stringify(value);
}
export function contextHash(record: Incident) {
  if (!record.context) throw new Error('Missing context: ' + record.id);
  const {context, map: _map, impact_assessment: _impact, ...evidence} = record;
  const {reviews: _reviews, ...values} = context;
  return createHash('sha256').update(canonical({...evidence, context: values})).digest('hex');
}
export function contextState(record: Incident) {
  const reviews = record.context!.reviews.filter(r => r.context_hash === contextHash(record));
  return reviews.some(r => r.decision === 'dispute') ? 'disputed' : reviews.some(r => r.decision === 'approve') ? 'reviewed' : 'draft';
}
export function validateContexts(data: Publication) {
  const enabled = data.settings.context_version === CONTEXT_VERSION;
  if (enabled && (!data.settings.context_review_mode || !data.settings.context_as_of || data.settings.methodology_version !== 'impact-v1'))
    throw new Error('Context requires impact-v1, an explicit review mode and an as-of date');
  if (!enabled && (data.settings.context_review_mode || data.settings.context_as_of || data.records.some(r => r.context)))
    throw new Error('Context data requires an explicit methodology version');
  for (const r of data.records) {
    const c = r.context;
    if (!c) {if (enabled && r.scope === 'agents') throw new Error('Missing agent context: ' + r.id); continue;}
    const sources = new Map(c.sources.map(s => [s.url, s]));
    if (sources.size !== c.sources.length) throw new Error('Duplicate context source: ' + r.id);
    const references = [...c.occurrence.source_urls, ...c.operating_context.source_urls, ...c.disclosure.source_urls, ...c.developments.flatMap(d => d.source_urls)];
    if (references.some(u => !sources.has(u))) throw new Error('Context references an unknown source: ' + r.id);
    if (new Set(c.disclosure.source_urls).size !== c.disclosure.source_urls.length) throw new Error('Duplicate disclosure source: ' + r.id);
    const o = c.occurrence;
    if (o.precision === 'unknown' ? o.start !== null || o.end !== null : !o.start || !o.end || o.start > o.end)
      throw new Error('Occurrence dates must match precision: ' + r.id);
    if (o.precision === 'day' && o.start !== o.end) throw new Error('Day precision requires one date: ' + r.id);
    if (o.precision === 'month' && (o.start!.slice(0, 7) !== o.end!.slice(0, 7) || !o.start!.endsWith('-01')
      || new Date(Date.parse(o.end!) + 86400000).getUTCDate() !== 1)) throw new Error('Month precision requires calendar-month bounds: ' + r.id);
    const asOf = data.settings.context_as_of!;
    if (c.proposed_at.slice(0, 10) > asOf) throw new Error('Context proposal is after the audit date: ' + r.id);
    if (o.end && o.end > asOf) throw new Error('Occurrence is after the audit date: ' + r.id);
    for (const s of c.sources) {
      if (s.checked_at.slice(0, 10) > asOf || (s.published_on && s.published_on > s.checked_at.slice(0, 10))
        || (s.updated_on && s.updated_on > s.checked_at.slice(0, 10))) throw new Error('Source dates are after the audit: ' + r.id);
    }
    if (o.precision !== 'unknown' && !o.source_urls.some(u => sources.get(u)!.check === 'source-read'))
      throw new Error('Known occurrence needs a checked source: ' + r.id);
    if (c.operating_context.kind !== 'unknown' && !c.operating_context.source_urls.some(u => sources.get(u)!.check === 'source-read'))
      throw new Error('Known operating context needs a checked source: ' + r.id);
    if (c.developments.some(d => d.source_urls.some(u => sources.get(u)!.check !== 'source-read')))
      throw new Error('Account developments require checked sources: ' + r.id);
    const dated = c.sources.filter(s => s.check === 'source-read' && s.published_on).sort((a, b) => a.published_on!.localeCompare(b.published_on!));
    const first = c.disclosure.source_urls.map(u => sources.get(u)!);
    if (first.some(s => s.check !== 'source-read' || !s.published_on || s.published_on !== dated[0]?.published_on))
      throw new Error('Disclosure must use the earliest checked publication date, never an update date: ' + r.id);
    if (first.length && dated.filter(s => s.published_on === dated[0].published_on).some(s => !c.disclosure.source_urls.includes(s.url)))
      throw new Error('Same-day disclosure sources must retain the tie: ' + r.id);
    if (c.developments.some(d => d.date && !d.source_urls.some(u => {
      const s = sources.get(u)!; return s.check === 'source-read' && (s.published_on === d.date || s.updated_on === d.date);
    }))) throw new Error('Development date needs a checked source publication/update: ' + r.id);
    if (c.reviews.some(review => review.context_hash !== contextHash(r))) throw new Error('Stale context review: ' + r.id);
    if (new Set(c.reviews.map(review => review.reviewer.toLowerCase())).size !== c.reviews.length) throw new Error('Duplicate context reviewer: ' + r.id);
    if (data.settings.context_review_mode === 'reviewed' && contextState(r) !== 'reviewed') throw new Error('Context needs review: ' + r.id);
  }
}
export function disclosureSummary(record: Incident) {
  const c = record.context!;
  const first = c.sources.filter(s => c.disclosure.source_urls.includes(s.url));
  const types = new Set(first.map(s => s.publisher_type));
  const category = !first.length ? 'unknown' : types.size > 1 ? 'tied' : first[0].publisher_type;
  return {date: first.length ? first[0].published_on : null, category, sources: first, note: c.disclosure.note};
}
export function narrativeAnalytics(data: Publication) {
  if (data.settings.context_version !== CONTEXT_VERSION) return null;
  const records = data.records.filter(r => r.scope === 'agents').map(r => ({id: r.id, title: r.t,
    disclosure: disclosureSummary(r), occurrence: r.context!.occurrence, operating_context: r.context!.operating_context,
    record_unit: r.context!.record_unit, unit_note: r.context!.unit_note, sources: r.context!.sources,
    developments: r.context!.developments, review_status: contextState(r)}));
  const breakdown = Object.entries(publisherLabels).map(([key, label]) => {
    const ids = records.filter(r => r.disclosure.category === key).map(r => r.id);
    return {key, label, count: ids.length, percent: records.length ? ids.length / records.length * 100 : 0, record_ids: ids};
  });
  return {version: CONTEXT_VERSION, as_of: data.settings.context_as_of!, review_mode: data.settings.context_review_mode!,
    unit: 'archive-records', records, breakdown, coverage: {total: records.length,
      dated_disclosures: records.filter(r => r.disclosure.date).length, unknown_chronology: records.filter(r => !r.disclosure.date).length,
      source_urls: new Set(records.flatMap(r => r.sources.map(s => s.url))).size,
      reviewed: records.filter(r => r.review_status === 'reviewed').length,
      developments: records.filter(r => r.developments.length).length}};
}
export const comparisonQuery = z.strictObject({context: z.enum(['all', 'training', 'evaluation', 'research', 'deployment', 'unknown']).default('all'),
  evidence: z.enum(['all', 'confirmed', 'reported', 'alleged']).default('all'), basis: z.enum(['occurrence', 'disclosure']).default('occurrence')});
export function comparisonAnalytics(data: Publication, query: unknown = {}) {
  if (data.settings.context_version !== CONTEXT_VERSION) return null;
  const filters = comparisonQuery.parse(query);
  const records = data.records.filter(r => r.scope === 'agents').filter(r => filters.context === 'all' || r.context!.operating_context.kind === filters.context)
    .filter(r => filters.evidence === 'all' || r.impact_assessment!.evidence === filters.evidence).map(r => {
      const o = r.context!.occurrence, a = r.impact_assessment!;
      // A range spanning months cannot be placed in one occurrence month without inventing precision.
      const month = filters.basis === 'disclosure' ? disclosureSummary(r).date?.slice(0, 7) || null
        : o.start && o.end && o.start.slice(0, 7) === o.end.slice(0, 7) ? o.start.slice(0, 7) : null;
      const exclusion = !month ? 'unknown-month' : month < data.settings.chart_start || month > data.settings.chart_end ? 'outside-window' : null;
      return {id: r.id, title: r.t, month, occurrence: o, record_unit: r.context!.record_unit, context: r.context!.operating_context.kind,
        landed: a.estimated.includes('landed') ? 'unknown' : a.landed, evidence: a.evidence,
        context_review: contextState(r), impact_review: assessmentState(r), exclusion};
    });
  const eligible = records.filter(r => !r.exclusion);
  const months: string[] = [];
  for (let t = new Date(data.settings.chart_start + '-01T00:00:00Z'); t.toISOString().slice(0, 7) <= data.settings.chart_end; t.setUTCMonth(t.getUTCMonth() + 1))
    months.push(t.toISOString().slice(0, 7));
  const series = Object.entries(landingLabels).map(([key, label]) => {
    const rows = eligible.filter(r => r.landed === key);
    const recent = rows.filter(r => months.slice(-6).includes(r.month!)).length;
    const previous = rows.filter(r => months.slice(-12, -6).includes(r.month!)).length;
    return {key, label, total: rows.length, recent, previous, change: recent - previous,
      months: months.map(month => ({month, record_ids: rows.filter(r => r.month === month).map(r => r.id),
        cumulative_ids: rows.filter(r => r.month! <= month).map(r => r.id)}))};
  });
  return {version: CONTEXT_VERSION, unit: 'archive-records', filters, as_of: data.settings.context_as_of!,
    review_mode: data.settings.context_review_mode!, impact_review_mode: data.settings.impact_review_mode!,
    start: data.settings.chart_start, end: data.settings.chart_end, context_labels: contextLabels, landing_labels: landingLabels,
    months, series, records, coverage: {total: records.length, included: eligible.length,
      unknown_month: records.filter(r => r.exclusion === 'unknown-month').length,
      outside_window: records.filter(r => r.exclusion === 'outside-window').length,
      grouped: eligible.filter(r => r.record_unit !== 'single').length,
      reviewed: eligible.filter(r => r.context_review === 'reviewed' && r.impact_review === 'reviewed').length}};
}
