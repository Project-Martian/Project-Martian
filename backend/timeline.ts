import type { Incident, Publication } from './types.js';
import { assessmentState, impactScore } from './impact.js';
import { mappingState } from './microtrends.js';
import { contextState, disclosureSummary } from './context.js';

export function timelineRecord(record: Incident) {
  const context = record.context;
  const sources = new Map<string, {url: string; label: string; title: string; date_label: string; audit: NonNullable<Incident['context']>['sources'][number] | null}>();
  for (const [label, title, url, date_label] of record.srcs) sources.set(url, {url, label, title, date_label, audit: null});
  if (!sources.has(record.u)) sources.set(record.u, {url: record.u, label: record.src, title: record.t, date_label: record.when, audit: null});
  for (const source of context?.sources || []) {
    const citation = sources.get(source.url);
    sources.set(source.url, {url: source.url, label: citation?.label || source.publisher,
      title: citation?.title || source.publisher, date_label: citation?.date_label || '', audit: source});
  }
  const makers = [...new Set(record.map?.links.map(link => link.company) || [])].sort();
  const occurrence = context?.occurrence;
  const disclosure = context ? disclosureSummary(record) : null;
  const a = record.impact_assessment;
  return {id: record.id, makers, sources: [...sources.values()],
    dates: {
      archive: {start: record.d || null, end: record.d || null, label: record.when || 'Archive date unknown', precision: 'archive'},
      occurrence: {start: occurrence?.start || null, end: occurrence?.end || null,
        precision: occurrence?.precision || 'unknown', note: occurrence?.note || 'This record has no occurrence-date assessment.'},
      disclosure: {start: disclosure?.date || null, end: disclosure?.date || null,
        precision: disclosure?.date ? 'day' : 'unknown', note: disclosure?.note || 'This record has no checked disclosure chronology.'},
    },
    impact: a ? {...impactScore(a), review_status: assessmentState(record), evidence: a.evidence,
      landed: a.estimated.includes('landed') ? 'unknown' : a.landed, estimated: a.estimated} : null,
    mapping_review: record.map ? mappingState(record) : null,
    context_review: context ? contextState(record) : null,
    search_text: [record.id, record.t, record.sum, record.org, record.tag, record.set, record.cause,
      record.impact, record.limits, record.lesson, ...makers,
      ...(record.map?.links.map(link => `${link.model} ${link.version || ''}`) || []),
      record.map?.ran_by, record.map?.hit, record.map?.harness,
      ...[...sources.values()].flatMap(source => [source.label, source.title, source.url]),
    ].filter(Boolean).join(' ').toLowerCase(),
  };
}

export function timelineData(data: Publication, contributions: {issue_number:number;incident_id:string;operation:string;publication_id:string;published_at:string}[] = []) {
  const records = data.records.map(record=>({...timelineRecord(record), contributions:contributions.filter(c=>c.incident_id===record.id)}));
  return {version: 'timeline-v1', records,
    makers: [...new Set(records.flatMap(record => record.makers))].sort(),
    coverage: {records: records.length, sources: new Set(records.flatMap(record => record.sources.map(source => source.url))).size},
  };
}
