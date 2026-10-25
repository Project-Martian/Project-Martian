import type { Publication, Snapshot } from './types.js';

// Derive display bounds from the immutable publication, never today's clock.
// Stored settings and evidence/review dates remain unchanged on export.
export function displayCalendar(data: Publication & Partial<Pick<Snapshot, 'publication'>>) {
  const dates = [data.settings.microtrends_as_of, data.settings.context_as_of || '',
    data.publication?.published_at.slice(0, 10) || '', ...data.records.map(record => record.d)];
  const asOf = dates.reduce((latest, date) => date > latest ? date : latest, '');
  const end = asOf.slice(0, 7) > data.settings.chart_end ? asOf.slice(0, 7) : data.settings.chart_end;
  const [startYear, startMonth] = data.settings.chart_start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  if ((endYear - startYear) * 12 + endMonth - startMonth + 1 > 600)
    throw new Error('Display interval exceeds 600 months');
  return {chart_start: data.settings.chart_start, chart_end: end, microtrends_as_of: asOf};
}
