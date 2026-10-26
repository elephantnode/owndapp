import type { Exposure, Lifecycle, Priority, Severity, QueueItem } from './types.js';

// Exposure and lifecycle alone do not establish that vulnerable code cannot execute.
export function priorityOf(severity: Severity, _exposure?: Exposure, _lifecycle?: Lifecycle): Priority {
  if (severity === 'malicious' || severity === 'critical' || severity === 'high') return 'high';
  if (severity === 'unknown') return 'review';
  return severity === 'low' ? 'low' : 'medium';
}
export const priorityReasons: Record<Severity, string> = {
  malicious: '悪意のあるパッケージが検出されました。利用の停止と影響確認を優先してください。',
  critical: '緊急の脆弱性が報告されています。公開状況だけでは優先度を下げません。',
  high: '重大度が高い脆弱性が報告されています。公開状況だけでは優先度を下げません。',
  moderate: '重大度が中の脆弱性です。更新と影響の確認を進めてください。',
  low: '重大度が低の脆弱性です。計画的に対応してください。',
  unknown: '重大度を判定できません。情報不足を低リスクとして扱わず、詳細を確認してください。',
};
export const priorityRank: Record<Priority, number> = { high: 4, review: 3, medium: 2, low: 1 };
export const severityRank: Record<Severity, number> = { malicious: 5, critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };
export const compareQueueItems = (a: QueueItem, b: QueueItem) => priorityRank[b.priority] - priorityRank[a.priority] || severityRank[b.advisory.severity] - severityRank[a.advisory.severity] || a.advisory.id.localeCompare(b.advisory.id);
