import type { QueueItem, ResponseStatus } from './types.js';

// Least handled first: one open advisory keeps the whole project open.
const order: ResponseStatus[] = ['open', 'fixing', 'investigating', 'awaiting-recheck', 'not-applicable', 'resolved'];

/**
 * One response status for a project's known vulnerabilities, taken from its least handled advisory. items are one
 * project's queue items; an advisory listed twice counts once. current is everything not yet resolved, not-applicable
 * included. No items means none, not resolved: nothing found is not proof of a fix. A terminal or empty result from a
 * partial or stale check is review, since the check may have missed advisories.
 */
export function projectResponseSummary(items: QueueItem[], context?: { status?: string; stale?: boolean }) {
  const unique = new Map<string, QueueItem>();
  for (const item of items) if (!unique.has(item.advisory.id)) unique.set(item.advisory.id, item);
  const counts = Object.fromEntries(order.map(s => [s, 0])) as Record<ResponseStatus, number>;
  for (const item of unique.values()) counts[item.status]++;
  const derived: ResponseStatus | 'none' = order.find(s => counts[s] > 0) ?? 'none';
  const uncertain = !!context?.stale || (context?.status !== undefined && context.status !== 'complete');
  const status: ResponseStatus | 'none' | 'review' = uncertain && (derived === 'none' || derived === 'not-applicable' || derived === 'resolved') ? 'review' : derived;
  return { status, counts, current: [...unique.values()].filter(i => i.status !== 'resolved'), total: unique.size };
}
