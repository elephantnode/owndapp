import { compareVersions } from '../shared/semver';
import { ecosystemLabels, exposureLabels, lifecycleLabels, priorityLabels, responseLabels, type Dependency, type Project, type QueueItem, type Severity } from '../shared/types';
import { priorityRank, severityRank, priorityOf, priorityReasons, compareQueueItems } from '../shared/priority';

const severityText: Record<Severity, string> = { malicious: '悪意のあるパッケージ', critical: '緊急', high: '高', moderate: '中', low: '低', unknown: '重大度不明' };

// Where a direct dependency is declared, and how to find what pulls in an indirect one, by the lockfile it was read from.
function manifestOf(d: Dependency) {
  if (d.ecosystem === 'crates.io') return 'Cargo.toml（workspaceの定義を含む）';
  if (d.ecosystem === 'Packagist') return 'composer.json';
  if (d.ecosystem === 'PyPI') return /requirements[^/]*\.txt$/i.test(d.file) ? d.file.split('/').pop()! : /Pipfile\.lock$/.test(d.file) ? 'Pipfile' : 'pyproject.toml';
  return 'package.json';
}
function whyCommand(d: Dependency) {
  if (d.ecosystem === 'crates.io') return `cargo tree --locked --offline --workspace --invert ${d.name}@${d.version}`;
  if (d.ecosystem === 'Packagist') return `composer why ${d.name}`;
  if (d.ecosystem === 'PyPI') return /uv\.lock$/.test(d.file) ? `uv tree --invert --package ${d.name}` : /poetry\.lock$/.test(d.file) ? `poetry show --why ${d.name}` : 'pipenv graph --reverse';
  return /yarn\.lock$/.test(d.file) ? `yarn why ${d.name}` : /pnpm-lock\.yaml$/.test(d.file) ? `pnpm why ${d.name}` : `npm ls ${d.name}`;
}
// npm keeps "name@version" as the heading; other ecosystems name themselves, since the same name may exist in several.
const packageKey = (d: Dependency) => `${d.ecosystem && d.ecosystem !== 'npm' ? `${ecosystemLabels[d.ecosystem]}: ` : ''}${d.name}@${d.version}`;

/**
 * A fix memo for one project, to hand to Claude Code or a person: what to update, to which version, and how to verify.
 * It covers only open work (not resolved, not not-applicable) and states what was not checked.
 */
export function buildMemo(project: Project, items: QueueItem[], checkedAt: string | null, context?: { stale?: boolean; status?: string; detailsFailed?: number; attemptedAt?: string }) {
  const open = items.filter(i => i.status !== 'resolved' && i.status !== 'not-applicable');
  // One section per package version, since one update usually fixes several advisories.
  const byPackage = new Map<string, QueueItem[]>();
  for (const item of open) {
    for (const dependency of item.dependencies) {
      const key = packageKey(dependency);
      const advisory = item.advisoryVariants?.find(v => packageKey(v.dependency) === key)?.advisory ?? item.advisory;
      const variant = { ...item, advisory, priority: priorityOf(advisory.severity), priorityReason: priorityReasons[advisory.severity] };
      byPackage.set(key, [...(byPackage.get(key) ?? []), variant]);
    }
  }
  const sections = [...byPackage].map(([key, list]) => {
    const dependency = list[0].dependencies.find(d => packageKey(d) === key)!;
    const fixes = [...new Set(list.map(i => i.advisory.fixed).filter((v): v is string => !!v))].sort((a, b) => compareVersions(dependency.ecosystem, a, b));
    const worst = Math.max(...list.map(i => severityRank[i.advisory.severity]));
    const priority = Math.max(...list.map(i => priorityRank[i.priority]));
    return { key, dependency, list, fixes, worst, priority };
  }).sort((a, b) => b.priority - a.priority || b.worst - a.worst || a.key.localeCompare(b.key));

  const lines = [
    `# 脆弱性の対策メモ: ${project.name}`,
    '',
    `- 場所: \`${project.path}\``,
    `- 公開状況: ${exposureLabels[project.exposure ?? 'unknown']} / 管理状態: ${lifecycleLabels[project.lifecycle]}`,
    `- 照会: ${checkedAt ? checkedAt.slice(0, 10) : '未照会'}（OSV。lockに記録された版で判定）`,
    `- 対応が必要なもの: ${open.length}件（${[...new Set(open.map(i => i.advisory.id))].length}種類のアドバイザリ、${sections.length}個のパッケージの版）`,
    '',
  ];
  if (context?.attemptedAt && context.attemptedAt !== checkedAt) lines.push(`最終照会試行: ${context.attemptedAt}（取得失敗のため、上記は前回の観測日時）`, '');
  if ((context?.status ?? project.vulnerabilities?.status) === 'partial') lines.push('注意: 一部の照会または詳細取得に失敗しています。検出がない項目も安全とは判定できません。', '');
  if (context?.stale ?? project.vulnerabilities?.stale) lines.push('注意: 依存の記録が照会時から変わっています。再照会してください。', '');
  if (!sections.length) lines.push('対応が必要な既知の脆弱性はありません（対象外・解消確認を除く）。', '');
  for (const s of sections) {
    const where = [s.dependency.direct ? '直接依存' : '間接依存', s.dependency.scope === 'dev' ? '開発用' : s.dependency.scope === 'prod' ? '本番' : null,
      s.dependency.file ? `\`${s.dependency.file}\`` : null, s.dependency.component ? `\`${s.dependency.component}\`` : null].filter(Boolean).join('・');
    lines.push(`## ${s.key}（${where}）`, '');
    for (const item of s.list.sort(compareQueueItems)) {
      lines.push(`- ${item.advisory.id}（${severityText[item.advisory.severity]}・優先度${priorityLabels[item.priority]}・${responseLabels[item.status]}）${item.advisory.summary}` +
        (item.advisory.fixed ? ` → 修正版 ${item.advisory.fixed}` : ' → 修正版の情報なし'));
    }
    for (const item of s.list) {
      if (item.priorityReason) lines.push(`  - 判定理由: ${item.priorityReason}`);
      if (item.advisory.severitySource) lines.push(`  - 重大度の出典: ${item.advisory.severitySource}${item.advisory.severityScore != null ? ` / CVSS値: ${item.advisory.severityScore}` : ''}`);
      if (item.advisory.severityReason) lines.push(`  - 取り込み: ${item.advisory.severityReason}`);
      if (item.retained || item.advisory.severityRetained) lines.push('  - 前回の情報を保持しています。再照会で確認してください。');
      if (item.advisory.severityConflict) lines.push('  - 重大度の情報に差異があります。高い判定を採用しています。');
      if (!item.advisory.detailsAvailable) lines.push('  - 詳細情報を取得できていません。解消確認はできません。');
    }
    const target = s.fixes.at(-1);
    lines.push('', s.dependency.direct
      ? `対応案: ${manifestOf(s.dependency)} の \`${s.dependency.name}\` を ${target ? `${target} 以上（上のすべての修正版を満たす版）` : '修正済みの版'}に更新する。${s.dependency.requested ? `今の宣言は \`${s.dependency.requested}\`。` : ''}`
      : `対応案: 間接依存のため、この版を引き込んでいる親パッケージの更新が必要な可能性がある（経路は未記録。\`${whyCommand(s.dependency)}\` で確認）。${target ? `${target} 以上になればよい。` : ''}`, '');
  }
  lines.push(
    '## 進め方',
    '',
    '- 対象プロジェクトの依存ルールを確認する。owndapp の `docs/dependency-policy.md` と同じく、lockの更新・脆弱性の検査・取得と署名の検証・ビルドを分けて行う。',
    '- `npm audit fix --force` やライフサイクルスクリプト（Composer の scripts なども含む）の一括有効化で済ませない。メジャー更新は互換性を確認する。',
    '- 更新後はテスト・ビルド・動作確認を行い、owndapp で依存を読み直して脆弱性を再照会し、解消を確認する。',
    '- このメモは既知の脆弱性（OSV登録済み）だけが対象。実際に悪用できるか、未公開の問題がないかは判定していない。',
  );
  return lines.join('\n');
}
