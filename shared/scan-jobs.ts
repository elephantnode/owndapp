import type { Candidate } from './types.js';

export type ScanFilter = 'all' | 'new' | 'registered';
/**
 * Paging and filters applied when reading a DB-backed scan. exclusions are the current ones, applied without a rescan.
 * limit 0 returns the summary and counts with no candidates.
 */
export interface ScanPageOptions { limit?: number; offset?: number; query?: string; filter?: ScanFilter; exclusions?: string[] }
export interface ScanSelectOptions { query?: string; filter?: ScanFilter; exclusions?: string[]; limit?: number }
/**
 * A candidate in a scan page. A very large project lists only the first components and evidence rows in a page;
 * componentTotal / evidenceTotal are set only then and give the full counts. ScanJobs.candidate returns everything.
 */
export interface ScanCandidate extends Candidate { componentTotal?: number; evidenceTotal?: number }
/**
 * Extra state on the summary of a DB-backed scan. phase is the step the scan is in or stopped at: reading folders,
 * grouping them into projects, or done. canResume / canRetry say whether resume() / retry() are accepted now.
 */
export interface ScanJobState { phase?: 'traverse' | 'group' | 'done'; canResume?: boolean; canRetry?: boolean }
