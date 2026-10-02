import type { IncidentMapping } from './microtrends.js';
import type { ImpactAssessment } from './impact.js';

export interface Incident {
  id: string; d: string; scope: 'agents' | 'other-ai' | 'automation';
  t: string; org: string; when: string; set: string; kind: string;
  sum: string; tag: string; src: string; rca: string; u: string;
  cause: string; clabel: string; lesson: string; loss: string; impact: string; limits: string;
  th: [string, string, string][];
  srcs: [string, string, string, string][];
  impact_assessment?: ImpactAssessment;
  map?: IncidentMapping;
  [key: string]: unknown;
}
export interface Microtrend { p: [string, string][]; act: string; exp: string; cat: string }
export interface Signal {
  id: string; sample: boolean; s: string; n: string; h: string; t: string;
  st: string; rec?: string; txt: string; e: string; c: string;
}
export interface Cluster { sample: boolean; k: string; t: string; m: string; d: number[]; mix: number[] }
export interface Publication {
  repo: string;
  settings: { chart_start: string; chart_end: string; microtrends_as_of: string;
    methodology_version: 'legacy-setting-v1' | 'impact-v1';
    impact_review_mode?: 'draft' | 'reviewed';
    microtrends_version?: 'maker-model-attack-v1'; microtrends_review_mode?: 'draft' | 'reviewed' };
  records: Incident[];
  microtrends: Record<string, Microtrend>;
  radar: { signals: Signal[]; clusters: Cluster[] };
}
export interface Snapshot extends Publication { publication: { id: string; published_at: string; source_hash: string } }
