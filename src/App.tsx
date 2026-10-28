import { OpenAppSettings } from './OpenAppSettings';
import { PlatformContext, unavailablePlatform, usePlatform } from './PlatformContext';
import { DependencyCoverage } from './DependencyCoverage';
import { ProjectResponsePanel } from './ProjectResponsePanel';
import { HomeView } from './HomeView';
import { UsageGuide } from './UsageGuide';
import { FolderPathDialog } from './FolderPathDialog';
import type { ScanCandidate } from '../shared/scan-jobs';
import { GuardPanel } from './GuardPanel';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { House, Archive, ArrowLeft, ArrowRight, Check, ChevronDown, ChevronLeft, ClipboardCheck, Copy, ChevronRight, CircleAlert, ClipboardList, EyeOff, FileCode2, Folder, FolderMinus, GitBranch, Globe, FolderOpen, FolderSearch, FolderTree, FolderX, Layers, ListChecks, Package, PackageSearch, RefreshCw, LayoutList, Plus, Search, Settings, ShieldAlert, ShieldCheck, ShieldQuestion, SquareCode, SquareTerminal, Tag, X } from 'lucide-react';
import { connect, request } from './api';
import { appRoleLabels, ecosystemLabels, exposureLabels, lifecycleLabels, priorityLabels, responseLabels, type AppRole, type Exposure, type GitObservation, type GitStatus, type QueueItem, type ResponseStatus, type Candidate, type Dependency, type DependencySnapshot, type DependencyStatus, type Ecosystem, type Severity, type VulnerabilityCheck, type VulnerabilityFinding, type VulnerabilitySummary, type Lifecycle, type OpenApps, type Project, type ProjectEdit, type Scan } from '../shared/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { allPaths, buildTree, withinPath, type TreeNode } from './catalog-tree';
import { buildMemo } from './memo';
import { priorityRank, severityRank, compareQueueItems } from '../shared/priority';
import { groupFindings, severityCounts, type FindingGroup } from './findings';
import { groupIssues, hasIssue, issueKinds, needsTriage, type IssueKind } from './attention';

type View = 'home' | 'attention' | 'catalog' | 'dependencies' | 'discover' | 'archive' | 'settings';
const navItems = [
  { id: 'home', label: 'ホーム', icon: House },
  { id: 'discover', label: 'アプリを追加', icon: FolderSearch },
  { id: 'catalog', label: '登録したアプリ', icon: LayoutList },
  { id: 'attention', label: '脆弱性と対応', icon: ClipboardCheck },
  { id: 'dependencies', label: '依存検索', icon: PackageSearch },
  { id: 'settings', label: '設定・使い方', icon: Settings },
] as const;
const projectTabs = [
  { id: 'catalog', label: '利用中', icon: LayoutList },
  { id: 'archive', label: 'アーカイブ', icon: Archive },
] as const;
const views: View[] = ['home', 'attention', 'catalog', 'dependencies', 'discover', 'archive', 'settings'];
const inProjects = (view: View) => projectTabs.some(tab => tab.id === view);
const appIcons: Record<AppRole, typeof SquareCode> = { editor: SquareCode, terminal: SquareTerminal };
const noApps: OpenApps = { editor: null, terminal: null };
const dependencyStatusLabels: Record<DependencyStatus, string> = { complete: '読み取り済み', partial: '一部を読み取れません', failed: '読み取れません', 'no-lock': 'lockなし' };
const readResultLabels: Record<DependencyStatus | 'missing' | 'error', string> = { ...dependencyStatusLabels, complete: '完了', partial: '一部失敗', missing: 'フォルダなし', error: 'エラー' };
const gitStatusLabels: Record<GitStatus, string> = { ok: '読み取り済み', 'no-git': 'Gitなし', unreadable: '読み取れません', invalid: '形式エラー' };
const gitReadResultLabels: Record<GitStatus | 'missing' | 'error', string> = { ...gitStatusLabels, ok: '完了', missing: 'フォルダなし', error: 'エラー' };
function gitSummary(project: Pick<Project, 'gitStatus' | 'gitRemoteCount' | 'gitBranch' | 'gitDetached'>): string {
  if (!project.gitStatus) return '未読';
  if (project.gitStatus === 'no-git') return 'Gitなし';
  if (project.gitStatus === 'unreadable' || project.gitStatus === 'invalid') return gitStatusLabels[project.gitStatus];
  const head = project.gitDetached ? 'detached' : project.gitBranch || 'ブランチ不明';
  const remotes = project.gitRemoteCount === 0 ? 'リモートなし'
    : project.gitRemoteCount === 1 ? 'リモートあり'
    : `リモート${project.gitRemoteCount}件`;
  return `${head} · ${remotes}`;
}
function GitLine({ project }: { project: Pick<Project, 'gitStatus' | 'gitRemoteCount' | 'gitBranch' | 'gitDetached'> }) {
  const unread = !project.gitStatus;
  const warn = project.gitStatus === 'unreadable' || project.gitStatus === 'invalid';
  return <div className={cn('flex items-center gap-1.5 text-caption', unread || warn ? 'text-dim' : 'text-muted-foreground')}>
    <GitBranch size={14} className="shrink-0" />{gitSummary(project)}
  </div>;
}
/** Catalog filter keys for Git. unread is absent status; no-remote / has-remote split ok reads. */
const gitFilterLabels = {
  unread: '未読', 'no-git': 'Gitなし', 'no-remote': 'リモートなし', 'has-remote': 'リモートあり', unreadable: '読み取れません', invalid: '形式エラー',
} as const;
type GitFilter = keyof typeof gitFilterLabels;
function matchesGitFilter(project: Pick<Project, 'gitStatus' | 'gitRemoteCount'>, filter: GitFilter) {
  if (filter === 'unread') return !project.gitStatus;
  if (filter === 'no-remote') return project.gitStatus === 'ok' && project.gitRemoteCount === 0;
  if (filter === 'has-remote') return project.gitStatus === 'ok' && (project.gitRemoteCount ?? 0) > 0;
  return project.gitStatus === filter;
}
type ReadResult = { id: string; name: string; status: DependencyStatus | 'missing' | 'error' };
type GitReadResult = { id: string; name: string; status: GitStatus | 'missing' | 'error' };
// Reads lockfiles of the given projects. The summary counts each outcome, e.g. "完了2件・lockなし1件".
async function readDependencies(ids: string[]) {
  const { results } = await request<{ results: ReadResult[] }>('/dependencies/read', { ids });
  const counts = new Map<string, number>();
  results.forEach(r => counts.set(readResultLabels[r.status], (counts.get(readResultLabels[r.status]) || 0) + 1));
  return { results, summary: [...counts].map(([label, count]) => `${label}${count}件`).join('・') };
}
async function readGitInfo(ids: string[]) {
  const { results } = await request<{ results: GitReadResult[] }>('/git/read', { ids });
  const counts = new Map<string, number>();
  results.forEach(r => counts.set(gitReadResultLabels[r.status], (counts.get(gitReadResultLabels[r.status]) || 0) + 1));
  return { results, summary: [...counts].map(([label, count]) => `${label}${count}件`).join('・') };
}
const scopeLabels: Record<Dependency['scope'], string> = { prod: '本番', dev: '開発', optional: '任意', peer: 'peer', unknown: '区分不明' };
// registry is the ecosystem's public registry, named per ecosystem in sourceLabel.
const publicRegistries: Record<Ecosystem, string> = { npm: 'npm公開', Packagist: 'Packagist', PyPI: 'PyPI', 'crates.io': 'crates.io', Go: 'Goモジュール', RubyGems: 'RubyGems.org', Maven: 'Maven' };
const sourceLabel = (d: Pick<Dependency, 'ecosystem' | 'source'>) => d.source === 'registry' ? publicRegistries[d.ecosystem ?? 'npm'] : sourceLabels[d.source];
const sourceLabels: Record<Dependency['source'], string> = { registry: '公開レジストリ', 'other-registry': '別のレジストリ', 'registry-unrecorded': 'レジストリ（lockに記録なし）', url: 'URL', git: 'Git', file: 'ローカル', unknown: '取得元不明' };
const fileStatusLabels: Record<DependencySnapshot['files'][number]['status'], string> = { ok: '読み取り済み', mismatch: '宣言と不一致', unpinned: '版の固定なしを含む', 'direct-only': '直接依存のみ', 'no-lock': 'lockなし', invalid: '形式エラー', unsupported: '未対応の形式', 'too-large': 'サイズ上限超過', unreadable: '読み取り不可' };
const severityLabels: Record<Severity, string> = { malicious: '悪意のあるパッケージ', critical: '緊急', high: '高', moderate: '中', low: '低', unknown: '重大度不明' };
const severityTone = (severity: Severity | null) => severity === 'malicious' || severity === 'critical' || severity === 'high' ? 'text-error' : severity === 'moderate' ? 'text-warning' : 'text-dim';
const notSentLabels: Record<string, string> = { git: 'Git', url: 'URL', file: 'ローカル', unknown: '取得元不明', 'no-version': '版不明', 'rust-source-unverified': 'Rustの公開取得元を確認できない依存' };
// One line for the catalog row: known vulnerabilities found, none found as of a date, or a stale/partial check.
function VulnerabilityLine({ summary }: { summary: VulnerabilitySummary }) {
  return summary.count ? <>
    <div className={cn('flex items-center gap-1.5', severityTone(summary.highest))}><ShieldAlert size={14} className="shrink-0" />既知の脆弱性 {summary.count}件{summary.highest && summary.highest !== 'unknown' ? `（最大: ${severityLabels[summary.highest]}）` : ''}</div>
    <CheckFreshness summary={summary} />
  </> : <>
    <div className="flex items-center gap-1.5 text-muted-foreground"><ShieldCheck size={14} className="shrink-0" />既知の脆弱性は見つかっていません</div>
    <CheckFreshness summary={summary} />
  </>;
}
// Stale means the dependencies now differ from what was checked. A partial check is its own state: some versions could not be queried.
const staleText = '依存内容が変わったため再照会が必要';
function CheckFreshness({ summary }: { summary: VulnerabilitySummary }) {
  return <span className={cn('mt-1 block text-micro', summary.stale || summary.status === 'partial' ? 'text-warning' : 'text-muted-foreground')}>{summary.stale ? staleText : summary.status === 'partial' ? '一部を照会できていません' : `${date(summary.checkedAt)}時点`}</span>;
}
// What the project needs next, most urgent first: a missing folder, exclusion, known vulnerabilities, then triage.
function ProjectStatus({ project }: { project: Project }) {
  return project.missing ? <>
    <div className="flex items-center gap-1.5 text-error"><FolderX size={14} className="shrink-0" />フォルダが見つかりません</div>
    <span className="mt-1 block text-micro text-muted-foreground">移動・削除された可能性があります</span>
  </> : project.excluded ? <>
    <div className="flex items-center gap-1.5 text-warning"><EyeOff size={14} className="shrink-0" />除外設定のフォルダにあります</div>
    <span className="mt-1 block text-micro text-muted-foreground">カタログから外せます</span>
  </> : project.vulnerabilities && (project.vulnerabilities.count || project.vulnerabilities.stale) ? <VulnerabilityLine summary={project.vulnerabilities} /> : project.dependencyStatus === 'failed' || project.dependencyStatus === 'partial' ? <>
    <div className="flex items-center gap-1.5 text-warning"><ShieldQuestion size={14} className="shrink-0" />{project.dependencyUnsupported && project.dependencyStatus === 'failed' ? '依存解析は未対応' : project.dependencyStatus === 'partial' ? '依存の一部が未確認' : '依存を読み取れません'}</div>
    <span className="mt-1 block text-micro text-muted-foreground">詳細で読み取れない形式・ファイルを確認できます</span>
  </> : project.dependencyStatus === 'no-lock' ? <>
    <div className="flex items-center gap-1.5 text-warning"><ShieldQuestion size={14} className="shrink-0" />依存を判定できません</div>
    <span className="mt-1 block text-micro text-muted-foreground">lockなし・検査未対応の形式。詳細で理由を確認できます</span>
  </> : <>
    <div className={cn('flex items-center gap-1.5', needsAttention(project) ? 'text-warning' : 'text-muted-foreground')}><CircleAlert size={14} className="shrink-0" />{project.lifecycle === 'untriaged' ? '用途・状態を整理' : !project.purpose ? '用途が未入力' : project.vulnerabilities ? '既知の脆弱性は見つかっていません' : '脆弱性は未照会'}</div>
    <span className="mt-1 block text-micro text-muted-foreground">{project.evidence.some(e => e.detail.includes('失敗')) ? '構成の一部を読み取れません' : project.vulnerabilities ? `${date(project.vulnerabilities.checkedAt)}時点` : project.dependencyStatus ? '依存は読み取り済み' : '依存・脆弱性は未確認'}</span>
  </>;
}

type RegisteredApp = { role: AppRole; app: { name: string } };
function ProjectActions({ project, apps, open, reveal }: { project: Project; apps: RegisteredApp[]; open: (project: Project, role: AppRole) => void; reveal: (project: Project) => void }) {
  const capabilities = usePlatform();
  return <div className="flex items-center justify-end gap-1">
    {apps.map(({ role, app }) => { const Icon = appIcons[role]; return <Button key={role} variant="ghost" size="icon" className="max-md:size-8" aria-label={`${project.name}を${app.name}で開く`} title={project.missing ? 'フォルダが見つかりません' : `${app.name}で開く`} disabled={project.missing} onClick={() => open(project, role)}><Icon size={17} /></Button>; })}
    {capabilities.revealFolder && <Button variant="ghost" size="icon" className="max-md:size-8" aria-label={`${project.name}をFinderで表示`} title={project.missing ? 'フォルダが見つかりません' : 'Finderで表示'} disabled={project.missing} onClick={() => reveal(project)}><FolderOpen size={17} /></Button>}
    <Button asChild variant="ghost" size="icon" className="max-md:size-8"><a aria-label={`${project.name}の詳細`} href={`#project/${project.id}`}><ChevronRight size={17} /></a></Button>
  </div>;
}

type QueueData = { items: QueueItem[]; projects: Record<string, { checkedAt: string; stale: boolean; status?: string; detailsFailed?: number; attemptedAt?: string }> };
// As sent: advisories once, items by advisory id, dependencies without source (not used here).
type QueueWire = { advisories: Record<string, QueueItem['advisory']>; projects: QueueData['projects'];
  items: (Omit<QueueItem, 'advisory' | 'dependencies'> & { advisoryId: string; advisoryKey?: string; dependencies: Omit<QueueItem['dependencies'][number], 'source'>[] })[] };
const decodeQueue = (d: QueueWire): QueueData => ({ projects: d.projects, items: d.items.map(({ advisoryId, advisoryKey, ...item }) => ({ ...item, advisory: d.advisories[advisoryKey ?? advisoryId],
  dependencies: item.dependencies.map(dep => ({ ...dep, ecosystem: dep.ecosystem ?? 'npm', source: 'unknown' as const })) })) });
// The stored statuses stay as they are. On screen they read as four stages, with not-applicable under その他.
type Stage = 'open' | 'working' | 'awaiting' | 'done' | 'other';
const stageOf: Record<ResponseStatus, Stage> = { open: 'open', investigating: 'working', fixing: 'working', 'awaiting-recheck': 'awaiting', resolved: 'done', 'not-applicable': 'other' };
const stageLabels: Record<Stage, string> = { open: '未対応', working: '対応中', awaiting: '確認待ち', done: '完了', other: 'その他' };
const statusDisplay: Record<ResponseStatus, string> = { open: '未対応', investigating: '対応中（調査中）', fixing: '対応中', 'awaiting-recheck': '確認待ち', resolved: '完了', 'not-applicable': '対象外' };
const unfinished: Stage[] = ['open', 'working', 'awaiting'];
const statusGroups: Record<string, { label: string; stages: Stage[] }> = {
  active: { label: '未完了（未対応・対応中・確認待ち）', stages: unfinished },
  open: { label: '未対応', stages: ['open'] },
  working: { label: '対応中（調査中を含む）', stages: ['working'] },
  awaiting: { label: '確認待ち', stages: ['awaiting'] },
  done: { label: '完了', stages: ['done'] },
  other: { label: 'その他（対象外）', stages: ['other'] },
  all: { label: 'すべて', stages: ['open', 'working', 'awaiting', 'done', 'other'] },
};
const statusTone: Record<ResponseStatus, string> = { open: 'text-warning', investigating: 'text-brand', fixing: 'text-brand', 'awaiting-recheck': 'text-dim', 'not-applicable': 'text-muted-foreground', resolved: 'text-success' };
const priorityTone = { high: 'text-error', review: 'text-warning', medium: 'text-warning', low: 'text-muted-foreground' } as const;
const itemKey = (item: QueueItem) => `${item.projectId}\u0000${item.advisory.id}`;

// Known vulnerabilities as work: by project or by advisory, most urgent first, with response status and a fix memo per project.
// The main part of 対応する. A check always goes through the confirmation that shows what leaves this Mac.
function QueueView({ projects, reloadProjects, notify, check, apps, open: openIn, openSettings, hasUnchecked }: { projects: Project[]; reloadProjects: () => Promise<unknown>; notify: (message: string) => void;
  check: (ids: string[]) => void; apps: RegisteredApp[]; open: (project: Project, role: AppRole) => void; openSettings: () => void; hasUnchecked: boolean }) {
  const editor = apps.find(a => a.role === 'editor');
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState('');
  const [group, setGroup] = useState('active'); const [priority, setPriority] = useState(''); const [exposure, setExposure] = useState(''); const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'project' | 'advisory'>('project');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(30);
  const [changing, setChanging] = useState(false);
  const [memo, setMemo] = useState<Project | null>(null);
  const load = () => request<QueueWire>('/queue').then(d => { setData(decodeQueue(d)); setError(''); }, e => setError(e.message));
  // Priorities follow exposure and lifecycle, so the queue is read again whenever projects change.
  useEffect(() => { void load(); }, [projects]);
  useEffect(() => { setSelected(new Set()); setLimit(30); }, [group, priority, exposure, query, mode]);
  const byId = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const items = useMemo(() => (data?.items ?? []).filter(item => {
    const project = byId.get(item.projectId);
    if (!project || !statusGroups[group].stages.includes(stageOf[item.status])) return false;
    if (priority && item.priority !== priority) return false;
    if (exposure && (project.exposure ?? 'unknown') !== exposure) return false;
    const text = [project.name, project.path, item.advisory.id, item.advisory.summary, ...item.advisory.aliases, ...item.dependencies.map(d => d.name)].join(' ').toLowerCase();
    return text.includes(query.trim().toLowerCase());
  }), [data, byId, group, priority, exposure, query]);
  const groups = useMemo(() => {
    const map = new Map<string, QueueItem[]>();
    for (const item of items) { const key = mode === 'project' ? item.projectId : item.advisory.id; map.set(key, [...(map.get(key) ?? []), item]); }
    const score = (list: QueueItem[]) => [Math.max(...list.map(i => priorityRank[i.priority])), Math.max(...list.map(i => severityRank[i.advisory.severity])), list.filter(i => i.priority === 'high').length, list.length];
    for (const list of map.values()) list.sort(compareQueueItems);
    return [...map].sort(([ka, a], [kb, b]) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return ka.localeCompare(kb); });
  }, [items, mode]);
  const counts = useMemo(() => { const c = new Map<Stage, number>(); for (const item of data?.items ?? []) c.set(stageOf[item.status], (c.get(stageOf[item.status]) ?? 0) + 1); return c; }, [data]);
  const investigating = (data?.items ?? []).filter(i => i.status === 'investigating').length;
  // Projects with unfinished items: checking them again is how an item reaches 完了.
  const recheckIds = useMemo(() => [...new Set((data?.items ?? []).filter(i => unfinished.includes(stageOf[i.status]) && byId.has(i.projectId)).map(i => i.projectId))], [data, byId]);
  const choose = (list: QueueItem[], on: boolean) => setSelected(prev => { const next = new Set(prev); list.filter(i => i.status !== 'resolved').forEach(i => on ? next.add(itemKey(i)) : next.delete(itemKey(i))); return next; });
  const toggle = (key: string) => setExpanded(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  async function changeExposure(project: Project, value: Exposure) {
    setError('');
    try { await request('/projects/exposure', { ids: [project.id], exposure: value }); await reloadProjects(); notify(`${project.name}の公開状況を「${exposureLabels[value]}」にしました`); }
    catch (e) { setError((e as Error).message); }
  }
  const selectedItems = (data?.items ?? []).filter(i => selected.has(itemKey(i)));
  const row = (item: QueueItem, label: ReactNode) => <li key={itemKey(item)} data-state={selected.has(itemKey(item)) ? 'selected' : undefined}
    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b py-2.5 pr-2 pl-10 data-[state=selected]:bg-brand-subtle max-md:pl-3">
    <Checkbox className="mt-0.5" aria-label={`${byId.get(item.projectId)?.name}の${item.advisory.id}を選択`} disabled={item.status === 'resolved'} checked={selected.has(itemKey(item))} onCheckedChange={() => choose([item], !selected.has(itemKey(item)))} />
    <div className={cn('min-w-0 text-caption', wrap)}>
      {label}
      <p className="mt-0.5 text-muted-foreground">{item.dependencies.map(d => `${d.name}@${d.version ?? '?'}（${d.direct ? '直接' : '間接'}）`).join('、')} → {item.advisory.fixed ? <>修正版 <code className="text-foreground">{item.advisory.fixed}</code></> : item.advisoryVariants && new Set(item.advisoryVariants.map(v => v.advisory.fixed)).size > 1 ? '版ごとに修正版を確認（対策メモを参照）' : '修正版の情報なし'}</p>
      {item.needsReview && <p className="mt-0.5 text-warning">{item.retained ? '前回の検出を保持・再照会が必要' : item.advisory.severityConflict ? '重大度の情報に差異あり・高い判定を採用' : '重大度・詳細情報の確認が必要'}</p>}
      {item.priorityReason && <p className="mt-0.5 text-muted-foreground">{item.priorityReason}</p>}
      {item.note && <p className="mt-0.5 text-dim">メモ: {item.note}{item.reviewBy ? `（${item.reviewBy}に見直し）` : ''}</p>}
    </div>
    <div className="text-right text-caption whitespace-nowrap"><span className={cn('font-medium', statusTone[item.status])}>{statusDisplay[item.status]}</span>
      <span className={cn('block text-micro', priorityTone[item.priority])}>優先度 {priorityLabels[item.priority]}</span></div>
  </li>;
  const advisoryLabel = (item: QueueItem) => <p><span className={cn('font-semibold', severityTone(item.advisory.severity))}>{severityLabels[item.advisory.severity]}</span>
    <a className="ml-2 font-mono text-foreground" href={`https://osv.dev/vulnerability/${encodeURIComponent(item.advisory.id)}`} target="_blank" rel="noreferrer">{item.advisory.id}</a>
    {item.advisory.summary && <span className="ml-2 text-dim">{item.advisory.summary}</span>}</p>;
  return <section aria-labelledby="queue-title" className="mb-12 max-md:mb-10">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><h2 id="queue-title" className="text-base font-semibold">既知の脆弱性への対応</h2>
        <p className="mt-1 max-w-[720px] text-caption text-muted-foreground">優先度の高いものから、対応状況を記録して進めます。完了は再チェックで検出されなくなったときに付きます。</p></div>
      <div className="flex flex-wrap gap-2">
        {recheckIds.length > 0 && <Button size="sm" title="未完了のものがあるアプリを、もう一度OSVに照会します。送る内容は照会の前に確認できます" onClick={() => check(recheckIds)}><ShieldAlert size={15} />{recheckIds.length}件を再チェック</Button>}
        {!editor && data && data.items.length > 0 && <Button size="sm" variant="ghost" className="text-dim" onClick={openSettings}><SquareCode size={15} />エディタを設定</Button>}
      </div>
    </div>
    {error && <Alert variant="destructive" className="mb-6"><CircleAlert size={18} /><AlertDescription>{error}</AlertDescription></Alert>}
    {!data ? <p className="border-y py-6 text-caption text-muted-foreground">読み込んでいます</p> : !data.items.length ? <div className="flex items-start gap-3 border-y py-6">
      <ShieldQuestion size={22} className="shrink-0 text-muted-foreground" />
      <div><p className="text-sm font-semibold">対応する既知の脆弱性はまだありません</p>
        <p className="mt-1 text-caption text-muted-foreground">チェックで見つかったものがここに並びます。チェックしていないアプリは含みません。{hasUnchecked ? '下の「まだ確認していないもの」からチェックできます。' : ''}</p></div></div> : <>
      <div className="mb-6 flex flex-wrap gap-x-6 gap-y-2 border-y py-4 text-xs tabular-nums">
        {(Object.keys(stageLabels) as Stage[]).map(stage => <span key={stage}><span className={stage === 'open' ? 'text-warning' : stage === 'working' ? 'text-brand' : stage === 'done' ? 'text-success' : 'text-muted-foreground'}>{stageLabels[stage]}</span> <strong className="font-semibold">{counts.get(stage) ?? 0}件</strong>
          {stage === 'working' && investigating > 0 && <span className="ml-1 text-muted-foreground">（調査中{investigating}）</span>}{stage === 'other' && <span className="ml-1 text-muted-foreground">（対象外）</span>}</span>)}
        <span className="text-muted-foreground max-md:basis-full">チェック済み{Object.keys(data.projects).length}件のアプリ。チェックしていないものは含みません。</span>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3 max-md:gap-2">
        <NativeSelect size="sm" aria-label="対応状況で絞り込み" value={group} onChange={e => setGroup(e.target.value)}>{Object.entries(statusGroups).map(([key, g]) => <NativeSelectOption key={key} value={key}>{g.label}</NativeSelectOption>)}</NativeSelect>
        <NativeSelect size="sm" aria-label="優先度で絞り込み" value={priority} onChange={e => setPriority(e.target.value)}><NativeSelectOption value="">すべての優先度</NativeSelectOption>{Object.entries(priorityLabels).map(([key, label]) => <NativeSelectOption key={key} value={key}>優先度 {label}</NativeSelectOption>)}</NativeSelect>
        <NativeSelect size="sm" aria-label="公開状況で絞り込み" value={exposure} onChange={e => setExposure(e.target.value)}><NativeSelectOption value="">すべての公開状況</NativeSelectOption>{Object.entries(exposureLabels).map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}</NativeSelect>
        <SearchBox label="対応項目を検索" className="w-[260px] max-md:w-full"><Search size={16} className="shrink-0" /><Input className={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="アプリ・パッケージ・ID" /></SearchBox>
        <div role="group" aria-label="まとめ方" className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-pressed={mode === 'project'} className="aria-pressed:border-border aria-pressed:bg-accent" onClick={() => setMode('project')}>アプリごと</Button>
          <Button variant="ghost" size="sm" aria-pressed={mode === 'advisory'} className="aria-pressed:border-border aria-pressed:bg-accent" onClick={() => setMode('advisory')}>アドバイザリごと</Button>
        </div>
      </div>
      <p className="mb-3 text-caption text-muted-foreground tabular-nums">{items.length.toLocaleString()}件（{groups.length}{mode === 'project' ? 'アプリ' : '種類のアドバイザリ'}）。緊急・高は優先度「高」、重大度不明は「要確認」です。公開状況や管理状態だけでは引き下げません。</p>
      {selected.size > 0 && <div className="mb-3 flex flex-wrap items-center gap-3 bg-brand-subtle px-4 py-3 text-xs"><span className="tabular-nums">{selected.size}件を選択中</span>
        <Button size="sm" onClick={() => setChanging(true)}><ListChecks size={16} />対応状況を変更</Button><Button size="sm" onClick={() => setSelected(new Set())}>選択解除</Button></div>}
      {groups.length ? <ul aria-label={mode === 'project' ? 'アプリごとの脆弱性' : 'アドバイザリごとの影響'} className="m-0 list-none border-t p-0">{groups.slice(0, limit).map(([key, list]) => {
        const open = expanded.has(key) || !!query.trim();
        const selectable = list.filter(i => i.status !== 'resolved');
        const picked = selectable.filter(i => selected.has(itemKey(i))).length;
        const tally = (['high', 'review', 'medium', 'low'] as const).map(p => [p, list.filter(i => i.priority === p).length] as const).filter(([, n]) => n);
        const project = mode === 'project' ? byId.get(key)! : null;
        const first = list[0];
        return <li key={key}>
          <div className="flex flex-wrap items-center gap-2 border-b bg-raised px-2 py-2">
            <Checkbox aria-label={`${project ? project.name : first.advisory.id}の${selectable.length}件を選択`} disabled={!selectable.length}
              checked={selectable.length && picked === selectable.length ? true : picked ? 'indeterminate' : false} onCheckedChange={checked => choose(list, checked === true)} />
            <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-expanded={open} disabled={!!query.trim()}
              aria-label={`${project ? project.name : first.advisory.id}を${open ? '閉じる' : '開く'}`} onClick={() => toggle(key)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</Button>
            <div className={cn('min-w-[min(220px,60%)] flex-1', wrap)}>
              {project ? <><a className="block text-sm font-semibold text-foreground no-underline" href={`#project/${project.id}`}>{project.name}</a>
                <code className="mt-0.5 block text-caption text-muted-foreground">{project.path}</code></> : advisoryLabel(first)}
              <span className="mt-0.5 flex flex-wrap gap-x-3 text-micro tabular-nums">
                {tally.map(([p, n]) => <span key={p} className={priorityTone[p]}>優先度{priorityLabels[p]} {n}</span>)}
                {project ? <span className="text-muted-foreground">{list.length}件</span> : <span className="text-muted-foreground">{new Set(list.map(i => i.projectId)).size}アプリ · {[...new Set(list.flatMap(i => i.dependencies.map(d => d.name)))].join('、')}</span>}
                {project && data.projects[project.id]?.status === 'partial' && <span className="text-warning">一部の照会・詳細取得に失敗</span>}
                {project && data.projects[project.id]?.stale && <span className="text-warning">{staleText}</span>}
              </span>
            </div>
            {project && <>
              <NativeSelect size="sm" aria-label={`${project.name}の公開状況`} value={project.exposure ?? 'unknown'} onChange={e => void changeExposure(project, e.target.value as Exposure)}>
                {Object.entries(exposureLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect>
              <span className="max-lg:hidden"><LifecycleLabel lifecycle={project.lifecycle} /></span>
              {editor && <Button size="sm" aria-label={`${project.name}を${editor.app.name}で開く`} title={project.missing ? 'フォルダが見つかりません' : `${editor.app.name}で開く`} disabled={project.missing} onClick={() => openIn(project, 'editor')}><SquareCode size={14} />{editor.app.name}で開く</Button>}
              <Button size="sm" aria-label={`${project.name}を再チェック`} title="このアプリをもう一度OSVに照会します。送る内容は照会の前に確認できます" onClick={() => check([project.id])}><ShieldAlert size={14} />再チェック</Button>
              <Button size="sm" onClick={() => setMemo(project)}><Copy size={14} />対策メモ</Button>
            </>}
          </div>
          {open && <ul className="m-0 list-none p-0">{list.map(item => row(item, mode === 'project' ? advisoryLabel(item)
            : <p><a className="font-semibold text-foreground" href={`#project/${item.projectId}`}>{byId.get(item.projectId)?.name}</a>
              <span className="ml-2 text-muted-foreground">{exposureLabels[byId.get(item.projectId)?.exposure ?? 'unknown']} · {lifecycleLabels[byId.get(item.projectId)!.lifecycle]}</span></p>))}</ul>}
        </li>;
      })}</ul> : <Empty><Search size={28} /><h2 className={emptyTitle}>条件に一致するものがありません</h2><p className={emptyText}>対応状況・優先度・公開状況の絞り込みを確認してください。</p></Empty>}
      {groups.length > limit && <Button variant="ghost" size="sm" className="mt-3" onClick={() => setLimit(l => l + 50)}>さらに表示（残り{groups.length - limit}）</Button>}
    </>}
    {changing && <ResponseDialog items={selectedItems} close={() => setChanging(false)} done={async (count, status) => {
      setChanging(false); setSelected(new Set()); await load(); notify(`${count}件の対応状況を「${statusDisplay[status]}」にしました`);
    }} />}
    {memo && data && <MemoDialog text={buildMemo(memo, data.items.filter(i => i.projectId === memo.id), data.projects[memo.id]?.checkedAt ?? null, data.projects[memo.id])} close={() => setMemo(null)} />}
  </section>;
}

// Sets the response for many items at once, in chunks the API accepts. Resolved cannot be chosen: only a check confirms it.
function ResponseDialog({ items, close, done, prefill = false }: { items: QueueItem[]; prefill?: boolean; close: () => void; done: (count: number, status: ResponseStatus) => Promise<void> }) {
  const [status, setStatus] = useState<ResponseStatus | ''>(prefill ? items[0].status : ''); const [note, setNote] = useState(prefill ? items[0].note : ''); const [reviewBy, setReviewBy] = useState(prefill ? items[0].reviewBy ?? '' : '');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0);
  const id = useId();
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!status) { setError('対応状況を選んでください'); return; }
    if (status === 'not-applicable' && !note.trim()) { setError('対象外にする根拠を入力してください'); return; }
    setBusy(true);
    try {
      for (let start = 0; start < items.length; start += 800) {
        await request('/queue/status', { items: items.slice(start, start + 800).map(i => ({ projectId: i.projectId, advisoryId: i.advisory.id })), status, note, reviewBy: status === 'not-applicable' && reviewBy ? reviewBy : null });
        setProgress(Math.min(start + 800, items.length));
      }
      await done(items.length, status);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{prefill ? '対応状況を変更' : '対応状況をまとめて変更'}</DialogTitle><DialogDescription>{prefill ? items[0].advisory.id : `選択中の${items.length.toLocaleString()}件`}。「完了」は、再チェックで検出されなくなったときに自動で付きます。</DialogDescription></DialogHeader>
      <form onSubmit={submit}>
        <Field id={id} label="対応状況"><NativeSelect id={id} containerClassName="w-full" value={status} onChange={e => setStatus(e.target.value as ResponseStatus)}>
          <NativeSelectOption value="" disabled>選んでください</NativeSelectOption>
          {(Object.keys(responseLabels) as ResponseStatus[]).filter(s => s !== 'resolved').map(s => <NativeSelectOption key={s} value={s}>{s === 'not-applicable' ? 'その他: 対象外（根拠が必要）' : s === 'awaiting-recheck' ? '確認待ち（再チェックで確かめる）' : statusDisplay[s]}</NativeSelectOption>)}
        </NativeSelect></Field>
        <Field id={`${id}-note`} label={status === 'not-applicable' ? '対象外にする根拠' : 'メモ（任意）'} hint={status === 'not-applicable' ? '例: 開発時のビルドにだけ使い、公開する成果物に含まれない' : undefined}>
          <Textarea id={`${id}-note`} aria-describedby={`${id}-note-hint`} rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></Field>
        {status === 'not-applicable' && <Field id={`${id}-review`} label="見直す日（任意）"><Input id={`${id}-review`} type="date" value={reviewBy} onChange={e => setReviewBy(e.target.value)} /></Field>}
        {error && <p role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}</p>}
        <DialogFooter><Button type="button" disabled={busy} onClick={close}>キャンセル</Button><Button variant="default" disabled={busy || (prefill && status === items[0].status && note === items[0].note && (status !== 'not-applicable' || reviewBy === (items[0].reviewBy ?? '')))}>{busy ? `変更中… ${progress}/${items.length}` : `${items.length.toLocaleString()}件を変更`}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function MemoDialog({ text, close }: { text: string; close: () => void }) {
  const [copied, setCopied] = useState(false); const area = useRef<HTMLTextAreaElement>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { area.current?.select(); setCopied(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="w-[min(760px,calc(100vw-32px))]">
      <DialogHeader><DialogTitle>対策メモ</DialogTitle><DialogDescription>Claude Code などに渡して、依存の更新を進めるときの下書きです。内容を確認してから使ってください。</DialogDescription></DialogHeader>
      <Textarea ref={area} aria-label="対策メモ" readOnly rows={18} className="mb-4 font-mono text-caption" value={text} />
      <DialogFooter><span role="status" className="mr-auto text-caption text-muted-foreground">{copied ? 'コピーしました' : ''}</span><Button type="button" onClick={close}>閉じる</Button><Button variant="default" onClick={() => void copy()}><Copy size={15} />コピー</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function LayoutSwitch({ layout, choose }: { layout: 'list' | 'tree'; choose: (layout: 'list' | 'tree') => void }) {
  return <div role="group" aria-label="表示の切り替え" className="flex items-center gap-1">
    <Button variant="ghost" size="sm" aria-pressed={layout === 'list'} className="aria-pressed:border-border aria-pressed:bg-accent" onClick={() => choose('list')}><LayoutList size={15} />一覧</Button>
    <Button variant="ghost" size="sm" aria-pressed={layout === 'tree'} className="aria-pressed:border-border aria-pressed:bg-accent" onClick={() => choose('tree')}><FolderTree size={15} />フォルダ別</Button>
  </div>;
}

const issueText: Record<IssueKind, { title: string; text: string }> = {
  vulnerable: { title: '既知の脆弱性', text: 'OSVに登録済みの脆弱性がある依存を使っています。重大度の高い順。詳細で修正版を確認できます。' },
  recheck: { title: '結果が古い（再チェックが必要）', text: 'チェックのあとに依存内容が変わったか、一部をチェックできなかったため、結果が今の依存と合っていません。' },
  missing: { title: 'フォルダが見つからない', text: '移動・削除された可能性があります。移動先で使っている場合は「アプリを追加」から登録し直します。' },
  excluded: { title: '除外設定のフォルダにある', text: '今後の探索では読み取りません。カタログに残す必要がなければ外せます。' },
  'read-failed': { title: '構成・依存を読み取れない', text: '設定やlockの読み取りに失敗しています（権限・壊れた形式・未対応形式など）。lockが無いだけの場所はここに出しません。' },
};

// One check accepts this many projects, as the API does.
const checkLimit = 1000;
const freshness = (p: Project) => !p.vulnerabilities ? 0 : p.vulnerabilities.stale || p.vulnerabilities.status === 'partial' ? 1 : 2;

// 対応する: the response queue first, then the other problems by kind, then what has not been checked yet.
// Known vulnerabilities are listed once, in the queue. Triage (purpose, lifecycle) stays a small line at the end.
function AttentionView({ projects, issues, layout, chooseLayout, apps, open, reveal, check, remove, readDependencies, fillPurposes, showUntriaged, toDependencies, toDiscover, reloadProjects, notify, openSettings }: {
  projects: Project[]; layout: 'list' | 'tree'; chooseLayout: (layout: 'list' | 'tree') => void;
  issues: ReturnType<typeof groupIssues>; apps: RegisteredApp[]; open: (project: Project, role: AppRole) => void; reveal: (project: Project) => void;
  check: (ids: string[], label?: string) => void; remove: (projects: Project[], reason: RemovalReason) => void; readDependencies: (ids: string[]) => Promise<void>;
  fillPurposes: () => Promise<void>; showUntriaged: () => void; toDependencies: () => void; toDiscover: () => void;
  reloadProjects: () => Promise<unknown>; notify: (message: string) => void; openSettings: () => void }) {
  const [expanded, setExpanded] = useState<Set<IssueKind>>(new Set());
  const [filling, setFilling] = useState(false);
  const fill = async () => { setFilling(true); try { await fillPurposes(); } finally { setFilling(false); } };
  const action = (kind: IssueKind, list: Project[]) => kind === 'recheck' ? <Button size="sm" onClick={() => check(list.map(p => p.id))}><ShieldAlert size={15} />{list.length}件を再チェック</Button>
    : kind === 'missing' || kind === 'excluded' ? <Button size="sm" variant="destructive" onClick={() => remove(list, kind)}>カタログから外す…</Button>
    : <Button size="sm" onClick={() => void readDependencies(list.map(p => p.id))}><RefreshCw size={15} />{list.length}件を読み直す</Button>;
  const sections = issueKinds.filter(kind => kind !== 'vulnerable' && issues.groups.get(kind)!.length);
  const monitored = projects.filter(p => p.lifecycle !== 'archived');
  const unavailable = monitored.filter(p => p.dependencyStatus === 'no-lock' || p.dependencyStatus === 'failed');
  const remaining = monitored.filter(p => !unavailable.includes(p));
  const unchecked = remaining.filter(p => !p.vulnerabilities);
  const recheck = remaining.filter(p => p.vulnerabilities && (p.vulnerabilities.stale || p.vulnerabilities.status === 'partial' || p.dependencyStatus === 'partial'));
  const current = remaining.length - unchecked.length - recheck.length;
  // Every monitored project, those never checked or out of date first, within what one check accepts.
  const checkAll = [...monitored].sort((a, b) => freshness(a) - freshness(b) || (a.vulnerabilities?.checkedAt ?? '').localeCompare(b.vulnerabilities?.checkedAt ?? '')).slice(0, checkLimit).map(p => p.id);
  const header = <PageHeader context="あなたの開発アプリ" title="脆弱性と対応" subtitle="既知の脆弱性を優先度の高い順に進めます。止まっている確認と、まだ確認していないものは下にまとめます。">
    {monitored.length > 0 && <Button variant="default" className="max-lg:px-3 max-lg:text-xs" title="アーカイブ以外のアプリをOSVに照会します。送る内容は照会の前に確認できます"
      onClick={() => check(checkAll, `監視対象（アーカイブ以外）の${checkAll.length}件`)}>
      <ShieldAlert size={17} />{monitored.length > checkLimit ? `監視対象のうち${checkLimit}件をチェック` : `監視対象${monitored.length}件をチェック`}</Button>}
  </PageHeader>;
  if (!projects.length) return <>{header}<Empty>
    <div className="mb-4 text-brand"><FolderSearch size={32} /></div>
    <h2 className={emptyTitle}>作ったアプリを、ここに集める</h2>
    <p className={emptyText}>親フォルダを探索し、見つかった候補から登録できます。登録すると、対応が必要なものがここに並びます。</p>
    <Button variant="default" onClick={toDiscover}>フォルダから探す<ArrowRight size={16} /></Button>
  </Empty></>;
  return <>
    {header}
    <p className="mb-6 border-y py-3 text-caption text-muted-foreground tabular-nums" aria-label="チェック範囲">監視対象 {monitored.length}アプリ · 最新結果 {current} · 要再確認 {recheck.length} · 未検査 {unchecked.length} · 判定できない {unavailable.length}<span className="mt-1 block">アーカイブ{projects.length - monitored.length}件は対象外。対応するlock形式の依存が対象で、公開先の稼働・反映は未確認です。{monitored.length > checkLimit && `チェックは1回${checkLimit}件までで、未検査・要再確認のものから選びます。`}</span></p>
    <QueueView projects={projects} reloadProjects={reloadProjects} notify={notify} check={check} apps={apps} open={open} openSettings={openSettings} hasUnchecked={issues.unchecked.length > 0} />
    {sections.length > 0 && <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-t pt-8">
      <div><h2 className="text-base font-semibold">ほかに確認が必要なもの</h2>
        <p className="mt-1 text-caption text-muted-foreground">結果が古い・フォルダがない・読み取れないなど、確認が止まっているアプリ。</p></div>
      <LayoutSwitch layout={layout} choose={chooseLayout} />
    </div>}
    {sections.map(kind => {
      const list = issues.groups.get(kind)!; const all = expanded.has(kind); const shown = all ? list : list.slice(0, 20);
      return <section key={kind} aria-labelledby={`issue-${kind}`} className="mb-10">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div><h3 id={`issue-${kind}`} className="text-sm font-semibold">{issueText[kind].title}<span className="ml-2 font-normal text-muted-foreground tabular-nums">{list.length}件</span></h3>
            <p className="mt-1 max-w-[720px] text-caption text-muted-foreground">{issueText[kind].text}</p></div>
          {action(kind, list)}
        </div>
        {layout === 'tree' ? <CatalogTree key={list.length} projects={list} startOpen label={`${issueText[kind].title}のフォルダ別`} apps={apps} open={open} reveal={reveal} /> :
        <ul className="m-0 list-none border-t p-0">{shown.map(project => <li key={project.id} className="grid grid-cols-[minmax(0,1fr)_minmax(200px,300px)_auto] items-start gap-x-4 border-b py-3 max-lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0"><a className={cn('text-sm font-semibold text-foreground no-underline', wrap)} href={`#project/${project.id}`}>{project.name}</a>
            <code className={cn('mt-1 block text-caption text-muted-foreground', wrap)}>{project.path}</code>
            <div className="mt-1"><LifecycleLabel lifecycle={project.lifecycle} /></div></div>
          <div className="text-caption max-lg:col-start-1 max-lg:mt-2"><ProjectStatus project={project} /></div>
          <div className="max-lg:col-start-2 max-lg:row-start-1"><ProjectActions project={project} apps={apps} open={open} reveal={reveal} /></div>
        </li>)}</ul>}
        {layout === 'list' && list.length > shown.length && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setExpanded(prev => new Set(prev).add(kind))}>すべて表示（{list.length}件）</Button>}
      </section>;
    })}
    <section aria-labelledby="not-yet" className="rounded-lg border bg-raised p-6 max-md:p-4">
      <h2 id="not-yet" className="mb-1 text-sm font-semibold">まだ確認していないもの</h2>
      <p className="mb-4 text-caption text-muted-foreground">問題が見つかったわけではありません。確認が済むまでは、安全とも言えません。</p>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 text-xs">
        <dt>脆弱性をまだチェックしていない（lockあり）<span className="ml-2 text-muted-foreground tabular-nums">{issues.unchecked.length}件</span></dt>
        <dd>{issues.unchecked.length > 0 && <Button size="sm" onClick={() => check(issues.unchecked.map(p => p.id))}><ShieldAlert size={15} />{issues.unchecked.length}件をチェック</Button>}</dd>
        <dt>依存情報をまだ読み取っていない<span className="ml-2 text-muted-foreground tabular-nums">{issues.unread.length}件</span></dt>
        <dd>{issues.unread.length > 0 && <Button size="sm" onClick={toDependencies}><Package size={15} />依存検索でまとめて読み取る</Button>}</dd>
        <dt>判定できる依存がない・読み取り失敗<span className="ml-2 text-muted-foreground tabular-nums">{unavailable.length}件</span><span className="mt-0.5 block">lockなし・未対応の形式など。脆弱性なしとは判定していません。</span></dt>
        <dd>{unavailable.length > 0 && <Button size="sm" onClick={toDependencies}>依存情報を確認</Button>}</dd>
      </dl>
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 text-caption text-muted-foreground">
        <span className="tabular-nums">整理（任意）: 用途が未入力 {issues.noPurpose.length}件・管理状態が未設定 {issues.untriaged.length}件</span>
        {issues.noPurpose.length > 0 && <Button size="sm" variant="ghost" className="text-dim" disabled={filling} title="READMEやpackage.jsonの説明から、空欄だけに入れます。入力済みの用途は変えません" onClick={() => void fill()}><FileCode2 size={15} />{filling ? '読み取り中…' : 'READMEから用途を入れる'}</Button>}
        {issues.untriaged.length > 0 && <Button size="sm" variant="ghost" className="text-dim" onClick={showUntriaged}><ListChecks size={15} />カタログで未設定を表示</Button>}
      </div>
    </section>
  </>;
}

// Projects by folder. A project that holds other projects shows them as its children.
// Guide lines like a file tree: a vertical line per ancestor level that still has rows below, and a branch to this row.
// The line of the last child stops at its branch. Columns line up with the open/close button of each level.
function TreeGuides({ depth, rails, last, branchAt }: { depth: number; rails: boolean[]; last: boolean; branchAt: string }) {
  if (!depth) return null;
  const x = (column: number) => column * 20 + 8 + 13;
  return <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0">
    {rails.map((on, column) => on && <span key={column} className="absolute inset-y-0 w-px bg-border-strong" style={{ left: x(column) }} />)}
    <span className="absolute top-0 w-px bg-border-strong" style={{ left: x(depth - 1), ...(last ? { height: branchAt } : { bottom: 0 }) }} />
    <span className="absolute h-px w-3 bg-border-strong" style={{ left: x(depth - 1), top: branchAt }} />
  </span>;
}

// Without selected/setSelected the tree has no checkboxes, as in 要対応 where each group has its own action.
function CatalogTree({ projects, selected, setSelected, filtered = false, startOpen = false, label = 'アプリのフォルダ別', apps, open, reveal, exclude }: { projects: Project[];
  selected?: Set<string>; setSelected?: (next: Set<string>) => void; filtered?: boolean; startOpen?: boolean; label?: string;
  apps: RegisteredApp[]; open: (project: Project, role: AppRole) => void; reveal: (project: Project) => void; exclude?: (path: string) => void }) {
  const { root, nodes } = useMemo(() => buildTree(projects), [projects]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(startOpen ? allPaths(buildTree(projects).nodes) : []));
  const selectable = !!selected && !!setSelected;
  // While searching or filtering, every match is shown open, so results are never hidden in a closed folder.
  const isOpen = (node: TreeNode) => filtered || expanded.has(node.path);
  const toggleNode = (node: TreeNode) => setExpanded(prev => { const next = new Set(prev); next.has(node.path) ? next.delete(node.path) : next.add(node.path); return next; });
  const choose = (ids: string[], on: boolean) => { const next = new Set(selected); ids.forEach(id => on ? next.add(id) : next.delete(id)); setSelected?.(next); };
  const rows: ReactNode[] = [];
  // rails[i]: whether the vertical guide in column i continues past this row (an ancestor there has later siblings).
  const walk = (list: TreeNode[], depth: number, rails: boolean[]) => {
    for (const [index, node] of list.entries()) {
      const last = index === list.length - 1;
      const ids = node.projects.map(p => p.id);
      const picked = ids.filter(id => selected?.has(id)).length;
      // A project row counts only the projects inside it, so a parent without findings never looks vulnerable.
      const inside = node.project ? node.projects.filter(p => p !== node.project) : node.projects;
      const attention = inside.filter(hasIssue).length;
      const vulnerable = inside.filter(p => p.vulnerabilities?.count).length;
      const hasChildren = node.children.length > 0;
      const indent = { paddingLeft: `${depth * 20 + 8}px` };
      const toggle = hasChildren ? <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-expanded={isOpen(node)} disabled={filtered}
        aria-label={`${node.label}を${isOpen(node) ? '閉じる' : '開く'}`} onClick={() => toggleNode(node)}>{isOpen(node) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</Button> : <span className="size-7 shrink-0" />;
      const counts = hasChildren && <span className="flex shrink-0 items-center gap-3 text-micro tabular-nums">
        <span className="text-muted-foreground">{node.project ? `配下 ${inside.length}件` : `${inside.length}件`}</span>
        {vulnerable > 0 && <span className="text-error">{node.project ? '配下に' : ''}脆弱性あり {vulnerable}</span>}
        {attention > 0 && <span className="text-warning">{node.project ? '配下に' : ''}要対応 {attention}</span>}
      </span>;
      rows.push(node.project ? <li key={node.path} data-state={selected?.has(node.project.id) ? 'selected' : undefined}
        className="relative grid grid-cols-[minmax(0,1fr)_minmax(200px,280px)_auto] items-start gap-x-4 border-b py-3 pr-0 data-[state=selected]:bg-brand-subtle max-lg:grid-cols-[minmax(0,1fr)_auto] max-md:py-4">
        <TreeGuides depth={depth} rails={rails} last={last} branchAt="26px" />
        <div className="flex min-w-0 items-start gap-2" style={indent}>
          {toggle}
          {selectable && <Checkbox className="mt-1.5" aria-label={`${node.project.name}を選択`} checked={selected!.has(node.project.id)} onCheckedChange={() => choose([node.project!.id], !selected!.has(node.project!.id))} />}
          <div className="min-w-0 pt-0.5">
            <div className="flex flex-wrap items-baseline gap-x-2"><a className={cn('text-sm font-semibold text-foreground no-underline', wrap)} href={`#project/${node.project.id}`}>{node.project.name}</a>
              {node.label !== node.project.name && <code className={cn('text-caption text-muted-foreground', wrap)} title={node.project.path}>{node.label}</code>}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"><LifecycleLabel lifecycle={node.project.lifecycle} /><TechLine technologies={node.project.technologies} /></div>
            <div className="mt-1.5"><GitLine project={node.project} /></div>
            {hasChildren && <div className="mt-1">{counts}</div>}
          </div>
        </div>
        <div className="text-caption max-lg:col-start-1 max-lg:mt-2 lg:pl-0!" style={{ paddingLeft: `calc(${indent.paddingLeft} + ${selectable ? 64 : 36}px)` }}><ProjectStatus project={node.project} /></div>
        <div className="max-lg:col-start-2 max-lg:row-start-1"><ProjectActions project={node.project} apps={apps} open={open} reveal={reveal} /></div>
      </li> : <li key={node.path} className={cn('relative flex items-center gap-2 border-b py-2 pr-2', depth === 0 ? 'bg-sunken' : depth === 1 ? 'bg-raised' : 'bg-raised/50')} style={indent}>
        <TreeGuides depth={depth} rails={rails} last={last} branchAt="50%" />
        {toggle}
        {selectable && <Checkbox aria-label={`${node.label}の${ids.length}件を選択`}
          checked={picked === ids.length ? true : picked ? 'indeterminate' : false} onCheckedChange={checked => choose(ids, checked === true)} />}
        <Folder size={16} className="shrink-0 text-muted-foreground" />
        <button type="button" className={cn('min-w-0 flex-1 cursor-pointer text-left text-[13px]', depth === 0 ? 'font-semibold' : 'font-medium', wrap)} onClick={() => !filtered && toggleNode(node)} title={node.path}>{node.label}</button>
        {counts}
        {exclude && <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" title="このフォルダとサブフォルダを今後の探索から除外します" aria-label={`${node.label}のフォルダを探索から除外`} onClick={() => exclude(node.path)}><EyeOff size={14} /></Button>}
      </li>);
      if (hasChildren && isOpen(node)) walk(node.children, depth + 1, depth === 0 ? [] : [...rails, !last]);
    }
  };
  walk(nodes, 0, []);
  const paths = allPaths(nodes);
  return <section aria-label={label}>
    <div className="flex flex-wrap items-center gap-3 border-y bg-raised px-3 py-2 text-caption text-muted-foreground">
      <span className={cn('min-w-0 flex-1', wrap)}><code>{root || 'すべてのドライブ・共有'}</code> 以下 · {projects.length}件</span>
      {filtered ? <span>検索・絞り込み中はすべて開いて表示します</span> : <>
        <Button variant="ghost" size="sm" disabled={expanded.size === paths.length} onClick={() => setExpanded(new Set(paths))}>すべて開く</Button>
        <Button variant="ghost" size="sm" disabled={!expanded.size} onClick={() => setExpanded(new Set())}>すべて閉じる</Button>
      </>}
    </div>
    <ul aria-label="フォルダとアプリ" className="m-0 list-none p-0">{rows}</ul>
  </section>;
}

function DependencyLine({ dependency }: { dependency: Dependency }) {
  return <div className={cn('text-caption', wrap)}>
    <code className="font-medium text-foreground">{dependency.name}@{dependency.version ?? '版不明'}</code>
    <span className="ml-2 text-muted-foreground">{[ecosystemLabels[dependency.ecosystem], dependency.direct ? `直接${dependency.requested ? `（${dependency.requested}）` : ''}` : '間接', scopeLabels[dependency.scope], sourceLabel(dependency)].join(' · ')}</span>
    <code className="block text-micro text-muted-foreground">{dependency.file}{dependency.component && dependency.component !== dependency.file.replace(/\/[^/]+$/, '') ? ` → ${dependency.component}` : ''}</code>
  </div>;
}
const scanLabels = { running: '探索中', paused: '一時停止中', completed: '探索完了', partial: '一部未確認', cancelled: 'キャンセル済み', failed: '探索失敗' };
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
// Elapsed time of a running scan, ticking every second between polls.
function useElapsed(startedAt: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return Math.max(0, now - Date.parse(startedAt));
}
// The total grows while walking, so show durable counts instead of a misleading percent.
function ScanProgress({ scan }: { scan: Scan }) {
  const elapsed = useElapsed(scan.startedAt);
  const stats: [string, string][] = [['確認した項目', scan.visited.toLocaleString()], ['処理済みフォルダ', (scan.processedFolders ?? 0).toLocaleString()],
    ['読み取り待ちのフォルダ', (scan.pending ?? 0).toLocaleString()], ['検出したフォルダ', `${(scan.found ?? 0).toLocaleString()}件`]];
  return <section aria-labelledby="scan-progress" className="rounded-lg border bg-raised p-6 max-md:p-4">
    <div className="flex items-center gap-2"><FolderSearch size={18} className="shrink-0 text-brand" /><h2 id="scan-progress" className="text-sm font-semibold">{scan.status === 'paused' ? '探索を一時停止しています' : scan.phase === 'group' ? '見つかった構成を候補に整理しています' : 'アプリの構成を調べています'}</h2></div>
    <dl className="mt-4 grid grid-cols-4 gap-4 max-md:grid-cols-2">{stats.map(([label, value]) => <div key={label}>
      <dt className="text-caption text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold tracking-[-.02em] tabular-nums">{value}</dd></div>)}</dl>
    <p className="mt-4 text-caption text-muted-foreground">読み取り中のフォルダ</p>
    <code className={cn('mt-1 block text-caption text-dim', wrap)}>{scan.currentPath || scan.root}</code>
    <p className="mt-4 text-caption text-muted-foreground">進捗はこの端末のDBに保存します。深さ・総件数・総時間による打ち切りはありません。一時停止やアプリ終了後は、続きから再開できます。</p>
    <p className="mt-2 text-caption text-muted-foreground tabular-nums">開始から {clock(elapsed)}。全体の量は終わるまで分からないため、完了率は表示しません。</p>
  </section>;
}
function ScanIssues({ scan }: { scan: Scan }) {
  const [open, setOpen] = useState(false); const [page, setPage] = useState(0);
  const [items, setItems] = useState(scan.issues); const [error, setError] = useState('');
  const total = scan.issueCount ?? scan.issues.length;
  useEffect(() => {
    if (!open) return; let alive = true;
    request<{ issues: Scan['issues']; total: number }>(`/scans/${scan.id}/issues?offset=${page * 100}`).then(data => { if (alive) { setItems(data.issues); setError(''); } }, e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [scan.id, scan.status, open, page]);
  return <details className="mt-6 rounded-md bg-warning-subtle px-4 py-3 text-caption text-dim" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="min-h-8 py-1.5 text-warning"><CircleAlert size={16} className="mr-2 inline align-middle" />確認できなかった項目 {total}件</summary>
    {error && <p role="alert">{error}</p>}
    <ul className="list-disc pl-4">{items.map((issue, i) => <li key={i} className={cn('mb-3', wrap)}><code className="text-caption">{issue.path}</code><p className="my-1">{issue.message}</p></li>)}</ul>
    {total > 100 && <div className="flex flex-wrap items-center gap-3"><Button size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>前の100件</Button><span>{page * 100 + 1}〜{Math.min(total, (page + 1) * 100)} / {total}件</span><Button size="sm" disabled={(page + 1) * 100 >= total} onClick={() => setPage(p => p + 1)}>次の100件</Button></div>}
  </details>;
}
function ScanHistory({ refreshKey, show }: { refreshKey: string; show: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false); const [page, setPage] = useState(0); const [error, setError] = useState('');
  const [data, setData] = useState<{ items: Pick<Scan, 'id' | 'root' | 'status' | 'startedAt' | 'candidateCount'>[]; total: number }>();
  useEffect(() => {
    if (!open) return; let alive = true;
    request<NonNullable<typeof data>>(`/scan-history?offset=${page * 20}`).then(value => { if (alive) { setData(value); setError(''); } }, e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [open, page, refreshKey]);
  return <details className="mt-8 border-t pt-4 text-caption" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="min-h-8 py-1.5">保存した探索の履歴</summary>
    {open && <div>{error && <p role="alert">{error}</p>}{data?.items.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2 border-b py-3">
      <div className="min-w-0 flex-1"><code className={cn('block', wrap)}>{item.root}</code><p className="mt-1 text-muted-foreground">{date(item.startedAt)} · {scanLabels[item.status]} · 候補{item.candidateCount ?? 0}件</p></div>
      <Button size="sm" variant="ghost" onClick={() => void show(item.id)}>この探索を見る</Button>
    </div>)}{data?.total === 0 && <p>保存した探索はありません。</p>}
      {data && data.total > 20 && <div className="mt-3 flex items-center gap-3"><Button size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>前の20件</Button><span>{page + 1} / {Math.ceil(data.total / 20)}</span><Button size="sm" disabled={(page + 1) * 20 >= data.total} onClick={() => setPage(p => p + 1)}>次の20件</Button></div>}
    </div>}
  </details>;
}
// A one-line reminder on other screens while a scan runs in the background.
function ScanBanner({ scan, open }: { scan: Scan; open: () => void }) {
  const elapsed = useElapsed(scan.startedAt);
  return <div aria-live="polite" className="mb-6 flex flex-wrap items-center gap-2 rounded-md border bg-raised px-4 py-3 text-xs text-dim tabular-nums">
    <FolderSearch size={16} className="shrink-0 text-brand" />フォルダを探索中: {scan.visited.toLocaleString()}項目を確認・{(scan.found ?? 0).toLocaleString()}件のフォルダを発見・{clock(elapsed)}
    <code className={cn('min-w-0 text-micro text-muted-foreground max-md:hidden', wrap)}>{scan.root}</code>
    <Button variant="link" size="sm" className="ml-auto h-auto min-h-0 px-0 text-xs" onClick={open}>アプリを追加で見る</Button>
  </div>;
}
const date = (value: string) => new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
// Colors a row as needing a look: a real problem, or a project not triaged yet. Only problems count as 要対応.
const needsAttention = (p: Project) => hasIssue(p) || needsTriage(p);
const splitTags = (value: string) => value.split(/[,、\n]/).map(t => t.trim()).filter(Boolean);
const wrap = '[overflow-wrap:anywhere]';
const headingTitle = 'mb-2 text-title leading-[1.35] font-[650] tracking-[-.035em] max-lg:text-[25px] max-md:text-2xl';

function PageHeader({ context, title, subtitle, children }: { context: string; title: string; subtitle: string; children?: ReactNode }) {
  return <header className="mb-8 flex items-center justify-between gap-6 max-lg:items-start max-md:mb-6 max-md:flex-wrap max-md:gap-4">
    <div><p className="mb-2 text-xs text-muted-foreground max-md:text-caption">{context}</p><h1 className={headingTitle}>{title}</h1><p className="text-[13px] text-dim">{subtitle}</p></div>
    {children}
  </header>;
}

function Empty({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-col items-center border-y px-4 py-16 text-center max-md:py-12', className)}>{children}</div>;
}
const emptyTitle = 'mt-4 mb-2 text-xl font-semibold tracking-[-.025em] max-md:text-lg';
const emptyText = 'mb-6 text-[13px] text-muted-foreground max-md:text-xs';

function TechLine({ technologies }: { technologies: string[] }) {
  return <div className={cn('mt-1 text-caption text-muted-foreground', wrap)}>{technologies.join(' · ') || '技術構成は未確認'}</div>;
}

function LifecycleLabel({ lifecycle }: { lifecycle: Lifecycle }) {
  return <span className={cn('inline-flex items-center gap-1.5 text-caption whitespace-nowrap', lifecycle === 'untriaged' ? 'text-warning' : 'text-dim')}>
    <span className={cn('size-[5px] rounded-full', lifecycle === 'active' || lifecycle === 'testing' || lifecycle === 'maintained' ? 'bg-brand' : lifecycle === 'untriaged' ? 'bg-warning' : 'bg-border-strong')} />
    {lifecycleLabels[lifecycle]}
  </span>;
}

// Opens the parent folder in Finder with the project folder selected.
async function showInFinder(project: Project) { await request(`/projects/${project.id}/reveal`, {}); }
async function openWith(project: Project, role: AppRole) { await request(`/projects/${project.id}/open`, { role }); }

function SearchBox({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <label className={cn('flex items-center gap-2 rounded-md border px-3 text-muted-foreground focus-within:border-ring focus-within:outline-2 focus-within:outline-brand-subtle', className)}>
    <span className="sr-only">{label}</span>{children}
  </label>;
}
const searchInput = 'min-w-0 border-0 bg-transparent px-0 text-foreground focus-visible:outline-none';

export function App() {
  const [capabilities, setCapabilities] = useState(unavailablePlatform);
  const [projects, setProjects] = useState<Project[]>([]);
  const [initialScan, setInitialScan] = useState<Scan>();
  const [readingSelectedDependencies, setReadingSelectedDependencies] = useState(false);
  const [dependencyProgress, setDependencyProgress] = useState<DependencyProgress | null>(null);
  const [gitProgress, setGitProgress] = useState<DependencyProgress | null>(null);
  const [vulnerabilityJob, setVulnerabilityJob] = useState<VulnerabilityJob | null>(null);
  const watchingChecks = useRef(false);
  const watching = useRef(false);
  const watchingGit = useRef(false);
  const [apps, setApps] = useState<OpenApps>(noApps);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [excluding, setExcluding] = useState<string[] | null>(null);
  // Detail saves share the fixed notification area and expire after four seconds.
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  // The notice at the top belongs to an earlier action by then, so it goes.
  const showToast = (text: string) => { setNotice(''); setToast({ id: Date.now(), text }); };
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4000); return () => clearTimeout(timer); }, [toast]);
  // One message at a time: a newer notice at the top replaces the toast.
  useEffect(() => { if (notice) setToast(null); }, [notice]);
  const [problem, setProblem] = useState('');
  const [view, setView] = useState<View>('home');
  // The discovery screen follows its own scan. Elsewhere, a running scan is followed here for the banner.
  const scanRunning = initialScan?.status === 'running' && view !== 'discover';
  useEffect(() => {
    if (!scanRunning || !initialScan) return;
    const id = initialScan.id; let alive = true;
    const timer = setInterval(() => { void request<{ scan: Scan }>(`/scans/${id}`).then(async ({ scan }) => {
      if (!alive) return;
      if (scan.status === 'running') { setInitialScan(scan); return; }
      // While every folder is being scanned, the banner moves on to the next folder.
      const { sweep } = await request<{ sweep: Sweep | null }>('/scans/sweep').catch(() => ({ sweep: null }));
      if (!alive) return;
      if (sweep?.status === 'running') {
        // Until the next folder's scan starts, keep watching this one.
        const next = sweep.scanId && sweep.scanId !== id ? await request<{ scan: Scan }>(`/scans/${sweep.scanId}?limit=0`).catch(() => null) : null;
        if (alive && next) setInitialScan(next.scan);
        return;
      }
      setInitialScan(scan);
      // The banner goes away when the scan ends, so say how it ended.
      setNotice(sweep && sweep.scanId === id && sweep.roots.length > 1 ? `すべてのフォルダの探索が終わりました（${sweep.done} / ${sweep.roots.length}フォルダ）。「アプリを追加」で候補を選べます`
        : `${scan.root} の探索が終わりました（${scanLabels[scan.status]}・候補${scan.candidateCount ?? scan.candidates.length}件）。「アプリを追加」で候補を選べます`);
    }, () => {}); }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [scanRunning, initialScan?.id]);
  const [detail, setDetail] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [tech, setTech] = useState('');
  const [gitFilter, setGitFilter] = useState<GitFilter | ''>('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [batch, setBatch] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagging, setTagging] = useState(false);
  const [changingLifecycle, setChangingLifecycle] = useState(false);
  const [readingDependencies, setReadingDependencies] = useState(false);
  const [readingGit, setReadingGit] = useState(false);
  // label names the set in the confirmation, e.g. 今回登録した2件. Without it the dialog says 選んだN件.
  const [checking, setChecking] = useState<{ ids: string[]; label?: string } | null>(null);
  const [changingExposure, setChangingExposure] = useState(false);
  const [page, setPage] = useState(0);
  // List or folder tree, remembered per browser. Storage may be unavailable, so it falls back to the list.
  const [layout, setLayout] = useState<'list' | 'tree'>(() => { try { return localStorage.getItem('owndapp.catalogLayout') === 'tree' ? 'tree' : 'list'; } catch { return 'list'; } });
  const chooseLayout = (next: 'list' | 'tree') => { setLayout(next); setSelected(new Set()); try { localStorage.setItem('owndapp.catalogLayout', next); } catch { /* not remembered */ } };
  const [only, setOnly] = useState<RemovalReason | null>(null);
  const [removing, setRemoving] = useState<{ projects: Project[]; reason: RemovalReason } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const unsaved = useRef(false);
  const previousHash = useRef(location.hash);

  // Follows background dependency reads (after registering, or reading all) and refreshes the catalog when they finish.
  function watchDependencies() {
    if (watching.current) return;
    watching.current = true;
    const poll = async () => {
      try {
        const progress = await request<DependencyProgress>('/dependencies/progress');
        if (!mounted.current) return;
        if (progress.running) { setDependencyProgress(progress); setTimeout(() => void poll(), 1000); return; }
        setDependencyProgress(null); watching.current = false; await reload();
      } catch { watching.current = false; setDependencyProgress(null); }
    };
    void poll();
  }
  // Follows catalog-wide Git reads and refreshes when they finish.
  function watchGitReads() {
    if (watchingGit.current) return;
    watchingGit.current = true;
    const poll = async () => {
      try {
        const progress = await request<DependencyProgress>('/git/progress');
        if (!mounted.current) return;
        if (progress.running) { setGitProgress(progress); setTimeout(() => void poll(), 1000); return; }
        setGitProgress(null); watchingGit.current = false; await reload();
      } catch { watchingGit.current = false; setGitProgress(null); }
    };
    void poll();
  }
  // Follows a background vulnerability check and reports its outcome when it ends.
  function watchVulnerabilities() {
    if (watchingChecks.current) return;
    watchingChecks.current = true;
    const poll = async () => {
      try {
        const { job } = await request<{ job: VulnerabilityJob | null }>('/vulnerabilities/job');
        if (!mounted.current) return;
        if (job?.status === 'running') { setVulnerabilityJob(job); setTimeout(() => void poll(), 1000); return; }
        setVulnerabilityJob(null); watchingChecks.current = false;
        if (!job) return;
        await reload();
        if (job.status === 'failed') { setProblem(job.error || '照会を完了できませんでした'); return; }
        const results = job.result!.results;
        const counts = new Map<string, number>(); results.forEach(r => counts.set(checkStatusLabels[r.status] || r.status, (counts.get(checkStatusLabels[r.status] || r.status) || 0) + 1));
        const found = results.filter(r => r.count > 0).length;
        setNotice(`${results.length}件を照会しました（${[...counts].map(([l, n]) => `${l}${n}件`).join('・')}${job.read ? `、照会前に${job.read}件の依存を読み取り` : ''}）。${found ? `既知の脆弱性があるアプリは${found}件です` : '既知の脆弱性は見つかりませんでした（OSVに登録済みのもの）'}`);
      } catch { watchingChecks.current = false; setVulnerabilityJob(null); }
    };
    void poll();
  }
  async function reload() {
    const data = await request<{ projects: Project[] }>('/projects'); setProjects(data.projects); return data.projects;
  }
  async function initialize() {
    setError('');
    try {
      const session = await connect();
      setCapabilities(session.capabilities ?? unavailablePlatform);
      const [catalog, history, settings] = await Promise.all([request<{ projects: Project[] }>('/projects'), request<{ scans: Scan[] }>('/scans'), request<{ apps: OpenApps }>('/apps')]);
      if (!mounted.current) return;
      setProjects(catalog.projects); setInitialScan(history.scans[0]); setApps(settings.apps); setReady(true);
      watchDependencies();
      watchGitReads();
      void request<{ job: VulnerabilityJob | null }>('/vulnerabilities/job').then(({ job }) => { if (job?.status === 'running') watchVulnerabilities(); }, () => {});
    } catch (e) { if (mounted.current) setError((e as Error).message); }
  }
  useEffect(() => { mounted.current = true; void initialize(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const route = () => {
      if (unsaved.current && location.hash !== previousHash.current) {
        if (!window.confirm('保存していない変更があります。別の画面へ移動しますか？')) {
          history.replaceState(null, '', previousHash.current || '#home'); return;
        }
        unsaved.current = false;
      }
      // The former 対応キュー address opens the same screen under its canonical address.
      if (location.hash === '#queue') history.replaceState(null, '', '#attention');
      previousHash.current = location.hash;
      const [next, id] = location.hash.slice(1).split('/');
      if (next === 'project' && id) { setDetail(id); return; }
      setDetail(null);
      if (views.includes(next as View)) setView(next as View);
    };
    route(); window.addEventListener('hashchange', route); return () => window.removeEventListener('hashchange', route);
  }, []);
  // Every screen and project detail opens at the top, not where the previous one was scrolled to.
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [view, detail]);
  function navigate(next: View) {
    if (unsaved.current && !window.confirm('保存していない変更があります。別の画面へ移動しますか？')) return false;
    // Notices belong to the screen they came from. Callers that report a result set it after navigating.
    unsaved.current = false; setDetail(null); setView(next); setSelected(new Set()); setPage(0); setNotice(''); setProblem(''); location.hash = next; return true;
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); if (navigate('catalog')) setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => { setPage(0); setSelected(new Set()); }, [query, lifecycle, tech, gitFilter, includeArchived, batch, view, only]);
  const visible = useMemo(() => projects.filter(p => {
    if (view === 'archive' ? p.lifecycle !== 'archived' : !includeArchived && p.lifecycle === 'archived') return false;
    if (only && !p[only]) return false;
    if (batch && p.importBatch !== batch) return false;
    if (lifecycle && p.lifecycle !== lifecycle) return false;
    if (tech && !p.technologies.includes(tech)) return false;
    if (gitFilter && !matchesGitFilter(p, gitFilter)) return false;
    const haystack = [p.name, p.path, p.purpose, p.notes, ...p.tags, ...p.technologies, ...p.components.map(c => c.name)].join(' ').toLocaleLowerCase();
    return haystack.includes(query.trim().toLocaleLowerCase());
  }).sort((a, b) => Number(hasIssue(b)) - Number(hasIssue(a)) || Number(needsTriage(b)) - Number(needsTriage(a)) || b.createdAt.localeCompare(a.createdAt)), [projects, view, batch, lifecycle, tech, gitFilter, query, includeArchived, only]);
  const technologies = [...new Set(projects.flatMap(p => p.technologies))].sort();
  const rows = visible.slice(page * 30, (page + 1) * 30);
  function toggle(id: string) { setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function clearFilters() { setQuery(''); setTech(''); setLifecycle(''); setGitFilter(''); setBatch(null); setOnly(null); setPage(0); }
  const missingProjects = projects.filter(p => p.missing);
  const excludedProjects = projects.filter(p => p.excluded);
  async function recheck() {
    setProblem('');
    try { const latest = await reload(); const count = latest.filter(p => p.missing).length; setNotice(count ? `フォルダの存在を確認しました。見つからないアプリが${count}件あります` : 'フォルダの存在を確認しました。すべて見つかりました'); }
    catch (e) { setProblem((e as Error).message); }
  }
  const current = projects.find(p => p.id === detail);
  // Every catalog total counts projects outside the archive, like 要対応.
  const activeProjects = projects.filter(p => p.lifecycle !== 'archived');
  const activeCount = activeProjects.length;
  const checkedCount = activeProjects.filter(p => p.vulnerabilities).length;
  const vulnerableCount = activeProjects.filter(p => p.vulnerabilities?.count).length;
  const issues = useMemo(() => groupIssues(projects), [projects]);
  const attentionCount = issues.issueCount;
  const pageSelected = rows.length > 0 && rows.every(p => selected.has(p.id)) ? true : rows.some(p => selected.has(p.id)) ? 'indeterminate' : false;
  const mobileCell = 'max-md:block max-md:p-0';
  const reveal = (project: Project) => { setProblem(''); showInFinder(project).catch(e => setProblem((e as Error).message)); };
  async function readSelected() {
    setProblem(''); setReadingDependencies(true);
    try { const { summary } = await readDependencies([...selected]); await reload(); setSelected(new Set()); setNotice(`${selected.size}件の依存情報を読み取りました（${summary}）。「依存検索」で探せます`); }
    catch (e) { setProblem((e as Error).message); } finally { setReadingDependencies(false); }
  }
  async function readSelectedGit() {
    setProblem(''); setReadingGit(true);
    try { const { summary } = await readGitInfo([...selected]); await reload(); setSelected(new Set()); setNotice(`${selected.size}件のGit情報を読み取りました（${summary}）`); }
    catch (e) { setProblem((e as Error).message); } finally { setReadingGit(false); }
  }
  const open = (project: Project, role: AppRole) => { setProblem(''); openWith(project, role).catch(e => setProblem((e as Error).message)); };
  const registeredApps = ((capabilities.externalApps ? Object.keys(appRoleLabels) : []) as AppRole[]).flatMap(role => apps[role] ? [{ role, app: apps[role]! }] : []);

  // Project detail belongs under アプリ, wherever it was opened from.
  const projectArea = inProjects(view) || !!detail;
  return <PlatformContext.Provider value={capabilities}><div className="flex min-h-screen max-lg:block">
    <a className="fixed -top-20 left-3 z-20 bg-background p-3 focus:top-3" href="#main" onClick={e => { e.preventDefault(); document.getElementById('main')?.focus(); }}>本文へ移動</a>
    {/* Below lg the menu becomes a top bar. The six destinations stay visible at every width. */}
    <aside className="fixed inset-y-0 left-0 flex w-[232px] shrink-0 flex-col border-r bg-raised px-4 pt-8 pb-6 max-xl:w-[196px] max-lg:static max-lg:w-full max-lg:flex-row max-lg:flex-wrap max-lg:items-center max-lg:justify-between max-lg:gap-x-3 max-lg:gap-y-2 max-lg:border-r-0 max-lg:border-b max-lg:px-6 max-lg:py-3 max-md:px-4">
      <a className="flex items-center gap-3 px-2 text-[23px] leading-[1.1] font-[650] tracking-[-.045em] text-foreground no-underline hover:no-underline max-lg:gap-2 max-lg:p-0 max-lg:text-[19px]" href="#home" aria-label="owndapp" onClick={e => { e.preventDefault(); navigate('home'); }}>
        <span className="flex text-brand"><Layers size={22} /></span>
        <span className="max-[440px]:hidden">owndapp<span className="mt-1.5 block text-micro font-normal tracking-[.06em] text-muted-foreground max-lg:hidden">Project catalog</span></span>
      </a>
      <div className="mx-2 mt-8 mb-6 flex items-center gap-1.5 text-caption text-dim max-lg:hidden"><span className="inline-block size-1.5 rounded-full bg-brand" />ローカルワークスペース</div>
      <nav aria-label="メインメニュー" className="grid gap-1 max-lg:w-full max-lg:grid-cols-3 max-md:grid-cols-2">{navItems.map(item => {
        const active = !detail && view === item.id || item.id === 'catalog' && projectArea;
        return <a key={item.id} href={`#${item.id}`} aria-label={item.label} aria-current={active ? 'page' : undefined} onClick={e => { e.preventDefault(); navigate(item.id); }}
          className={cn('flex min-h-11 items-center gap-2 rounded-md px-3 py-2.5 text-[13px] text-dim no-underline hover:bg-accent hover:no-underline max-lg:justify-center max-lg:px-2 max-md:justify-start', active && 'bg-brand-subtle font-semibold text-brand hover:bg-brand-subtle')}>
          <item.icon size={18} className="shrink-0" /><span>{item.label}</span>
        </a>;
      })}</nav>
      <div className="mt-auto px-2 pt-6 text-caption text-dim max-lg:hidden">
        <div className="flex items-center gap-2"><span className="inline-block size-1.5 rounded-full bg-brand" />この端末に保存</div>
        <p className="my-3 leading-[1.8] text-muted-foreground">ソースコードや依存の版は変更しません。設定は確認後に適用します。</p>
        <span className="font-mono text-micro text-muted-foreground">v0.1 · カタログ初版</span>
      </div>
    </aside>
    <main id="main" tabIndex={-1} className="ml-[232px] w-[calc(100%-232px)] px-12 pb-12 max-xl:ml-[196px] max-xl:w-[calc(100%-196px)] max-xl:px-8 max-lg:ml-0 max-lg:w-full max-lg:px-6 max-md:px-4">
      <div className={cn('flex min-h-[66px] items-center gap-2 border-b text-xs text-muted-foreground max-md:min-h-12', projectArea ? 'mb-0' : 'mb-8 max-md:mb-6')}><span className="whitespace-nowrap max-md:hidden">ワークスペース</span><ChevronRight size={14} className="max-md:hidden" />
        {projectArea ? <><span>登録したアプリ</span><ChevronRight size={14} /><span>{detail ? 'アプリ詳細' : projectTabs.find(t => t.id === view)?.label}</span></> : <span>{navItems.find(n => n.id === view)?.label}</span>}
        <span className="ml-auto shrink-0 font-mono text-micro whitespace-nowrap">Local only</span></div>

      {projectArea && !detail && <nav aria-label="登録したアプリの表示" className="mb-6 mt-3 flex flex-wrap gap-2 border-b pb-3">{projectTabs.map(tab => <a key={tab.id} href={`#${tab.id}`} aria-current={view === tab.id ? 'page' : undefined} onClick={e => { e.preventDefault(); if (navigate(tab.id)) clearFilters(); }} className={cn('inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-caption no-underline hover:bg-accent', view === tab.id && 'bg-brand-subtle font-semibold text-brand')}><tab.icon size={15} />{tab.label}</a>)}</nav>}
      {!ready ? <Empty><Layers size={34} /><h1 className={emptyTitle}>カタログに接続しています</h1><p className={emptyText}>ローカルの保存データを読み込みます。</p></Empty> : detail ? current ?
        <ProjectDetail key={current.id} project={current} checkVulnerabilities={() => setChecking({ ids: [current.id] })} reloadProjects={() => reload().then(() => {})} apps={registeredApps} open={role => open(current, role)} openSettings={() => navigate('settings')} reveal={() => reveal(current)} remove={reason => setRemoving({ projects: [current], reason })} exclude={() => setExcluding([current.path])} onDirty={value => { unsaved.current = value; }} back={() => { unsaved.current = false; setDetail(null); location.hash = view; }} saved={async () => { await reload(); showToast('アプリを保存しました'); }} /> :
        <Empty><h1 className={emptyTitle}>アプリが見つかりません</h1><Button onClick={() => navigate('catalog')}>カタログに戻る</Button></Empty> :
        view === 'home' ? <HomeView apps={apps} appsChanged={setApps} projects={projects} initialScan={initialScan} toDiscover={() => navigate('discover')} toCatalog={() => { if (navigate('catalog')) clearFilters(); }} toAttention={() => navigate('attention')} toSettings={() => navigate('settings')} check={(ids, label) => setChecking({ ids, label })} /> :
        view === 'attention' ? <AttentionView projects={projects} issues={issues} layout={layout} chooseLayout={chooseLayout} apps={registeredApps} open={open} reveal={reveal}
          reloadProjects={reload} notify={setNotice} openSettings={() => navigate('settings')} toDiscover={() => navigate('discover')}
          check={(ids, label) => setChecking({ ids, label })} remove={(list, reason) => setRemoving({ projects: list, reason })}
          readDependencies={async ids => { setProblem(''); setReadingSelectedDependencies(true); try { const { summary } = await readDependencies(ids); await reload(); setNotice(`${ids.length}件の依存情報を読み直しました（${summary}）`); } catch (e) { setProblem((e as Error).message); } finally { setReadingSelectedDependencies(false); } }}
          fillPurposes={async () => { setProblem(''); try { const { checked, filled } = await request<{ checked: number; filled: number }>('/purposes/fill', {}); await reload(); setNotice(`用途が空の${checked}件のうち${filled}件に、READMEなどの説明から用途を入れました${checked > filled ? `（${checked - filled}件は使える説明が見つかりませんでした）` : ''}`); } catch (e) { setProblem((e as Error).message); } }}
          showUntriaged={() => { if (navigate('catalog')) { clearFilters(); setLifecycle('untriaged'); } }} toDependencies={() => navigate('dependencies')} /> :
        view === 'settings' ? <SettingsView apps={apps} changed={setApps} toDiscover={() => navigate('discover')} /> :
        view === 'dependencies' ? <DependencySearch projects={projects} toCatalog={() => navigate('catalog')} reading={!!dependencyProgress || readingSelectedDependencies} readSelected={async ids => {
          const allowed = new Set(projects.filter(p => !p.missing && !p.excluded).map(p => p.id));
          if (!ids.length || ids.length > 25 || ids.some(id => !allowed.has(id))) throw new Error('読み取り対象を選び直してください');
          setReadingSelectedDependencies(true);
          try {
            const outcome = await readDependencies([...new Set(ids)]);
            try { await reload(); } catch { throw new Error('依存の読み取りは完了しましたが、一覧を更新できませんでした。画面を再読み込みして結果を確認してください'); }
            return { summary: outcome.summary };
          } finally { setReadingSelectedDependencies(false); }
        }} readAll={async () => {
          setProblem('');
          try { const { queued } = await request<{ queued: number }>('/dependencies/read-all', {}); setNotice(`アーカイブ以外の${queued}件の依存情報を読み取ります`); watchDependencies(); }
          catch (e) { setProblem((e as Error).message); }
        }} /> :
        view === 'discover' ? <Discovery initial={initialScan} imported={async (id, ids, check) => {
          await reload(); clearFilters(); setBatch(id); navigate('catalog'); watchDependencies();
          const over = check && ids.length > checkLimit ? `チェックは1回${checkLimit}件までのため、残り${ids.length - checkLimit}件は「脆弱性と対応」からチェックできます。` : '';
          setNotice(`${ids.length}件を追加しました。用途やタグの整理は任意です。依存情報は自動で読み取ります。${over}`);
          // Nothing leaves this Mac until the confirmation is accepted. The check reads any dependencies the background read has not reached yet.
          if (check && ids.length) setChecking({ ids: ids.slice(0, checkLimit), label: `今回登録した${Math.min(ids.length, checkLimit)}件` });
        }} changed={setInitialScan}
          exclusionsChanged={() => reload().catch(e => setProblem((e as Error).message))} showExcluded={() => { if (navigate('catalog')) { clearFilters(); setOnly('excluded'); } }} /> : <>
        <PageHeader context="あなたの開発アプリ" title={view === 'archive' ? 'アーカイブ' : '登録したアプリ'} subtitle={view === 'archive' ? '過去の取り組みと、再開に必要な記録を残す。' : '作ったものを把握して、次の対応を決める。'}>
          <Button variant="default" className="max-lg:px-3 max-lg:text-xs" onClick={() => navigate('discover')}><Plus size={17} />アプリを追加</Button>
        </PageHeader>
        {batch && view === 'catalog' && projects.some(p => p.importBatch === batch && p.lifecycle !== 'archived') && <section aria-label="登録後の次のステップ" className="mb-6 rounded-lg border bg-raised p-4"><h2 className="mb-1 text-sm font-semibold">次は、登録したアプリの脆弱性をチェック</h2><p className="mb-3 text-caption text-muted-foreground">用途・タグの入力は任意です。外部へ送るパッケージ情報を確認してからチェックを始めます。</p><Button onClick={() => setChecking({ ids: projects.filter(p => p.importBatch === batch && p.lifecycle !== 'archived').slice(0, checkLimit).map(p => p.id), label: '今回登録したアプリ' })}>登録したアプリの脆弱性をチェック</Button><Button className="ml-2" variant="ghost" onClick={() => navigate('attention')}>優先度の高いものから対応</Button></section>}
        <section aria-label="集計（アーカイブ以外）" className="mb-8 grid grid-cols-[1fr_1fr_1fr_1fr_2.4fr] gap-6 border-y py-6 max-xl:grid-cols-4 max-xl:gap-4 max-md:mb-6 max-md:grid-cols-2 max-md:py-4">
          {([['登録（アーカイブ以外）', activeCount], ['要対応', attentionCount], ['既知の脆弱性あり', vulnerableCount], ['脆弱性をチェック済み', checkedCount]] as const).map(([label, count], i) =>
            <div key={label} className="flex flex-col gap-2"><span className="text-xs text-dim max-md:text-micro">{label}</span><strong className={cn('text-title leading-[1.2] font-medium tabular-nums max-md:text-2xl', i === 0 && 'text-brand', i === 2 && count > 0 && 'text-error')}>{count}<small className="ml-1.5 text-caption font-normal text-muted-foreground">アプリ</small></strong></div>)}
          <div className="flex items-center gap-3 border-l pl-6 text-dim max-xl:col-span-full max-xl:border-t max-xl:border-l-0 max-xl:pt-4 max-xl:pl-0">
            {vulnerableCount ? <ShieldAlert size={24} className="shrink-0 text-error" /> : <ShieldQuestion size={24} className="shrink-0" />}
            <div><strong className="text-xs font-semibold">数はすべてアーカイブ以外のアプリ</strong>
              <p className="mt-1 text-caption leading-[1.8] text-muted-foreground tabular-nums">アーカイブの{projects.length - activeCount}件は含みません。チェックしていないものは安全とは限りません。<br className="max-xl:hidden" />更新候補・Gitの状態は未確認です。用途・管理状態の整理がまだのもの{issues.triageCount}件。</p></div>
          </div>
        </section>
        <section aria-label="アプリ一覧">
          <div className="flex items-center gap-4 max-md:gap-2">
            <SearchBox label="アプリを検索" className="w-[min(520px,100%)] max-md:min-w-0 max-md:flex-1"><Search size={18} className="shrink-0" /><Input ref={searchRef} className={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="名前、パス、技術、タグで検索" /><kbd className="shrink-0 rounded-sm border px-1.5 text-micro max-md:hidden">{capabilities.platform === 'win32' ? 'Ctrl K' : '⌘ K'}</kbd></SearchBox>
            <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground tabular-nums">{visible.length}件</span>
            {view !== 'archive' && <Button size="sm" variant="ghost" className="text-dim" disabled={!!gitProgress || activeCount === 0} onClick={() => {
              setProblem('');
              void request<{ queued: number }>('/git/read-all', {}).then(({ queued }) => {
                setNotice(`アーカイブ以外の${queued}件のGit情報を読み取ります`); watchGitReads();
              }, e => setProblem((e as Error).message));
            }} title="各アプリの .git からブランチとリモートを読みます。fetch や変更の確認はしません"><GitBranch size={15} /><span className="max-md:sr-only">{gitProgress ? 'Git読み取り中…' : `Gitをすべて読む（${activeCount}）`}</span></Button>}
            <Button size="sm" variant="ghost" className="text-dim" onClick={() => void recheck()} title="登録したフォルダがあるかを確認します"><RefreshCw size={15} /><span className="max-md:sr-only">存在を再確認</span></Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-4 pb-6 max-md:gap-2 max-md:pb-4">
            <NativeSelect size="sm" aria-label="技術で絞り込み" value={tech} onChange={e => setTech(e.target.value)}><NativeSelectOption value="">すべての技術</NativeSelectOption>{technologies.map(t => <NativeSelectOption key={t}>{t}</NativeSelectOption>)}</NativeSelect>
            <NativeSelect size="sm" aria-label="管理状態で絞り込み" value={lifecycle} onChange={e => setLifecycle(e.target.value)}><NativeSelectOption value="">すべての管理状態</NativeSelectOption>{Object.entries(lifecycleLabels).filter(([key]) => view === 'archive' ? key === 'archived' : key !== 'archived' || includeArchived).map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}</NativeSelect>
            <NativeSelect size="sm" aria-label="Gitで絞り込み" value={gitFilter} onChange={e => setGitFilter(e.target.value as GitFilter | '')}><NativeSelectOption value="">すべてのGit</NativeSelectOption>{Object.entries(gitFilterLabels).map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}</NativeSelect>
            {view !== 'archive' && <div className="flex min-h-10 items-center gap-2"><Checkbox id="include-archived" checked={includeArchived} onCheckedChange={checked => { setIncludeArchived(checked === true); setLifecycle(''); }} /><Label htmlFor="include-archived" className="cursor-pointer font-normal text-dim">アーカイブを含む</Label></div>}
            <div className="ml-auto flex items-center gap-1">
              {layout === 'list' && <span className="mr-2 text-caption text-muted-foreground max-lg:hidden">確認が必要な順</span>}
              <LayoutSwitch layout={layout} choose={chooseLayout} />
            </div>
          </div>
          {missingProjects.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md bg-error-subtle px-4 py-3 text-xs text-error">
            <FolderX size={16} className="shrink-0" /><span>フォルダが見つからないアプリが<strong className="mx-0.5">{missingProjects.length}</strong>件あります</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" className="text-inherit hover:bg-transparent hover:underline" aria-pressed={only === 'missing'} onClick={() => setOnly(on => on === 'missing' ? null : 'missing')}>{only === 'missing' ? 'すべて表示' : '見つからないものを表示'}</Button>
              <Button size="sm" variant="destructive" onClick={() => setRemoving({ projects: missingProjects, reason: 'missing' })}>カタログから外す…</Button>
            </div>
          </div>}
          {excludedProjects.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md bg-warning-subtle px-4 py-3 text-xs text-warning">
            <EyeOff size={16} className="shrink-0" /><span>除外設定のフォルダにあるアプリが<strong className="mx-0.5">{excludedProjects.length}</strong>件あります</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" className="text-inherit hover:bg-transparent hover:underline" aria-pressed={only === 'excluded'} onClick={() => setOnly(on => on === 'excluded' ? null : 'excluded')}>{only === 'excluded' ? 'すべて表示' : '除外設定のものを表示'}</Button>
              <Button size="sm" variant="destructive" onClick={() => setRemoving({ projects: excludedProjects, reason: 'excluded' })}>カタログから外す…</Button>
            </div>
          </div>}
          {batch && <div className="mb-4 flex flex-wrap items-center gap-3 bg-brand-subtle px-4 py-3 text-xs"><Check size={16} />今回追加したアプリを表示しています<Button variant="link" size="sm" className="ml-auto min-h-7" onClick={() => setBatch(null)}>全件に戻る</Button></div>}
          {selected.size > 0 && <div className="mb-4 flex flex-wrap items-center gap-3 bg-brand-subtle px-4 py-3 text-xs"><span className="tabular-nums">{selected.size}件を選択中</span><Button size="sm" onClick={() => setTagging(true)}><Tag size={16} />タグを追加</Button><Button size="sm" onClick={() => setChangingLifecycle(true)}><ListChecks size={16} />管理状態を変更</Button><Button size="sm" disabled={readingDependencies} onClick={() => void readSelected()}><Package size={16} />{readingDependencies ? '依存情報を読み取り中…' : '依存情報を読む'}</Button><Button size="sm" disabled={readingGit} onClick={() => void readSelectedGit()}><GitBranch size={16} />{readingGit ? 'Git情報を読み取り中…' : 'Git情報を読む'}</Button><Button size="sm" onClick={() => setChecking({ ids: [...selected] })}><ShieldAlert size={16} />脆弱性を照会</Button><Button size="sm" onClick={() => setChangingExposure(true)}><Globe size={16} />公開状況を変更</Button><Button size="sm" onClick={() => setExcluding(outermost(projects.filter(p => selected.has(p.id)).map(p => p.path)))}><EyeOff size={16} />探索から除外</Button><Button size="sm" onClick={() => setSelected(new Set())}>選択解除</Button></div>}
          {layout === 'tree' && visible.length > 0 ? <CatalogTree projects={visible} selected={selected} setSelected={setSelected}
            filtered={!!(query.trim() || tech || lifecycle || gitFilter || only || batch)} apps={registeredApps} open={open} reveal={reveal} exclude={path => setExcluding([path])} /> :
          rows.length > 0 ? <Table containerClassName="max-md:overflow-visible" className="max-md:block">
            <TableHeader className="max-md:hidden"><TableRow className="border-0">
              <TableHead className="w-8 pr-0 pl-2"><Checkbox aria-label="このページをすべて選択" checked={pageSelected} onCheckedChange={checked => setSelected(checked === true ? new Set(rows.map(p => p.id)) : new Set())} /></TableHead>
              <TableHead>アプリ</TableHead><TableHead>対応・確認</TableHead><TableHead className="max-xl:hidden">Git</TableHead><TableHead className="max-lg:hidden">管理状態</TableHead><TableHead className="max-xl:hidden">構成の確認</TableHead><TableHead><span className="sr-only">詳細</span></TableHead>
            </TableRow></TableHeader>
            <TableBody className="max-md:block">{rows.map(project => <TableRow key={project.id} data-state={selected.has(project.id) ? 'selected' : undefined} className="max-md:grid max-md:grid-cols-[24px_minmax(0,1fr)_auto] max-md:gap-x-2 max-md:border-t max-md:border-b-0 max-md:py-4">
              <TableCell className={cn('w-8 pr-0 pl-2', mobileCell, 'max-md:col-start-1 max-md:row-span-2 max-md:row-start-1 max-md:w-auto max-md:pt-1')}><Checkbox aria-label={`${project.name}を選択`} checked={selected.has(project.id)} onCheckedChange={() => toggle(project.id)} /></TableCell>
              <TableCell className={cn('w-[40%] max-w-[520px] min-w-[200px]', mobileCell, 'max-md:col-start-2 max-md:w-auto max-md:max-w-none max-md:min-w-0')}>
                <a className={cn('text-sm font-semibold text-foreground no-underline', wrap)} href={`#project/${project.id}`}>{project.name}</a>
                <code className={cn('mt-1 block text-caption text-muted-foreground', wrap)} title={project.path}>{project.path}</code>
                <TechLine technologies={project.technologies} />
                {project.purpose && <div className={cn('mt-2 max-w-[300px] text-caption text-dim', wrap)}>{project.purpose}</div>}
                {project.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{project.tags.map(t => <Badge key={t}>{t}</Badge>)}</div>}
              </TableCell>
              <TableCell className={cn(mobileCell, 'max-md:col-start-2 max-md:mt-3')}>
                <ProjectStatus project={project} />
                <div className="mt-2 xl:hidden"><GitLine project={project} /></div>
              </TableCell>
              <TableCell className="max-xl:hidden align-top"><GitLine project={project} /></TableCell>
              <TableCell className="max-lg:hidden"><LifecycleLabel lifecycle={project.lifecycle} /></TableCell>
              <TableCell className="max-xl:hidden"><time className="text-caption whitespace-nowrap text-muted-foreground" dateTime={project.observedAt}>{date(project.observedAt)}</time></TableCell>
              <TableCell className={cn('pr-0', mobileCell, 'max-md:col-start-3 max-md:row-start-1')}><ProjectActions project={project} apps={registeredApps} open={open} reveal={reveal} /></TableCell>
            </TableRow>)}</TableBody>
          </Table> : <Empty>
            <div className="mb-4 text-brand">{projects.length ? <Search size={30} /> : <FolderSearch size={32} />}</div>
            <h2 className={emptyTitle}>{projects.length ? '条件に一致するアプリがありません' : '作ったアプリを、ここに集める'}</h2>
            <p className={emptyText}>{projects.length ? '検索条件を変えると、ほかのアプリを探せます。' : '親フォルダを探索し、見つかった候補から登録できます。'}</p>
            <Button variant={projects.length ? 'outline' : 'default'} onClick={() => projects.length ? clearFilters() : navigate('discover')}>{projects.length ? '検索条件を解除' : 'フォルダから探す'}<ArrowRight size={16} /></Button>
          </Empty>}
          <div className="flex items-center justify-between gap-4 py-4 text-micro text-muted-foreground max-md:flex-wrap max-md:border-t">
            <span>構成はローカル設定から検出。クラウドの実態は未確認です。</span>
            {layout === 'list' && visible.length > 30 && <Pagination page={page} total={visible.length} move={delta => { setPage(p => p + delta); setSelected(new Set()); }} />}
          </div>
        </section>
      </>}
    </main>
    <section aria-label="作業の進捗と通知" className="pointer-events-none fixed top-[max(16px,env(safe-area-inset-top))] left-1/2 z-30 grid max-h-[45dvh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 gap-2 overflow-y-auto rounded-md [&>*]:pointer-events-auto">
      {error && <Alert variant="destructive" className="shadow-dialog"><CircleAlert size={18} /><AlertDescription>{error}</AlertDescription><Button variant="ghost" size="sm" className="min-h-6 text-inherit hover:bg-transparent hover:underline" onClick={() => void initialize()}>再接続</Button></Alert>}
      {problem && <Alert variant="destructive" className="shadow-dialog"><CircleAlert size={18} /><AlertDescription>{problem}</AlertDescription><Button variant="ghost" size="icon" className="size-6 text-inherit hover:bg-transparent max-md:size-8" aria-label="エラーを閉じる" onClick={() => setProblem('')}><X size={16} /></Button></Alert>}
      {initialScan?.status === 'running' && <Alert role="status" className="shadow-dialog"><FolderSearch size={18} className="text-brand" /><AlertDescription>フォルダを探索中。{(initialScan.visited ?? 0).toLocaleString()}項目を確認<Button variant="link" size="sm" onClick={() => navigate('discover')}>探索の詳細</Button></AlertDescription></Alert>}
      {dependencyProgress && <div role="status" className="shadow-dialog flex items-center gap-2 rounded-md border bg-raised px-4 py-3 text-xs text-dim tabular-nums">
        <Package size={16} className="shrink-0 text-brand" />依存情報を読み取り中 {dependencyProgress.done} / {dependencyProgress.total}件<span className="text-muted-foreground max-md:hidden">この端末の中で読むだけで、外部には送りません</span></div>}
      {gitProgress && <div role="status" className="shadow-dialog flex items-center gap-2 rounded-md border bg-raised px-4 py-3 text-xs text-dim tabular-nums">
        <GitBranch size={16} className="shrink-0 text-brand" />Git情報を読み取り中 {gitProgress.done} / {gitProgress.total}件<span className="text-muted-foreground max-md:hidden">この端末の `.git` だけを読みます。fetch はしません</span></div>}
      {vulnerabilityJob && <div role="status" className="shadow-dialog flex flex-wrap items-center gap-2 rounded-md border bg-raised px-4 py-3 text-xs text-dim tabular-nums">
        <ShieldAlert size={16} className="shrink-0 text-brand" />{vulnerabilityJob.projects}件の脆弱性を照会中: {jobPhaseLabels[vulnerabilityJob.phase]} {vulnerabilityJob.done.toLocaleString()} / {vulnerabilityJob.total.toLocaleString()}
        <span className="text-muted-foreground max-md:hidden">終わると結果を表示します。この画面を離れても続きます</span></div>}
      {notice && <Alert variant="success" role="status" className="shadow-dialog"><Check size={18} /><AlertDescription>{notice}</AlertDescription><Button variant="ghost" size="icon" className="size-6 text-inherit hover:bg-transparent max-md:size-8" aria-label="通知を閉じる" onClick={() => setNotice('')}><X size={16} /></Button></Alert>}
      {!dependencyProgress && (readingDependencies || readingSelectedDependencies) && <Alert role="status" className="shadow-dialog"><Package size={18} className="text-brand" /><AlertDescription>依存情報を読み取り中…</AlertDescription></Alert>}
      {!gitProgress && readingGit && <Alert role="status" className="shadow-dialog"><GitBranch size={18} className="text-brand" /><AlertDescription>Git情報を読み取り中…</AlertDescription></Alert>}
    {toast && <Alert key={toast.id} variant="success" role="status"
      className="items-center shadow-dialog">
      <Check size={20} strokeWidth={2.5} /><AlertDescription>{toast.text}</AlertDescription>
      <Button variant="ghost" size="icon" className="ml-2 size-8 text-inherit hover:bg-white/15" aria-label="通知を閉じる" onClick={() => setToast(null)}><X size={17} /></Button>
    </Alert>}
    </section>
    {excluding && <ExcludeDialog paths={excluding} projects={projects} close={() => { setExcluding(null); void reload().catch(error => setProblem((error as Error).message)); }} excluded={async (registered, removed) => {
      setExcluding(null);
      let refreshed: Project[];
      try { refreshed = await reload(); } catch (error) { setProblem(`除外とカタログの整理は保存しましたが、表示を更新できませんでした。画面を再読み込みしてください。${(error as Error).message}`); return; }
      if (detail && !refreshed.some(project => project.id === detail)) { unsaved.current = false; setDetail(null); location.hash = 'catalog'; }
      if (removed > 0) { clearFilters(); unsaved.current = false; if (detail) { setDetail(null); location.hash = 'catalog'; } setSelected(new Set()); showToast(`探索から除外し、${removed}件をカタログから外しました。ソースは削除していません`); return; }
      if (detail) { showToast('探索から除外しました'); return; }
      setSelected(new Set());
      setNotice(`${excluding.length}個のフォルダを探索から除外しました。登録済みの${registered}件はカタログに残っています。不要なら「除外設定のものを表示」から外せます`);
    }} />}
    {removing && <RemoveDialog {...removing} close={() => setRemoving(null)} removed={async count => {
      unsaved.current = false; setRemoving(null); await reload(); setOnly(null);
      if (detail) { setDetail(null); location.hash = view; }
      setNotice(`${count}件をカタログから外しました。ソースは変更していません`);
    }} />}
    {checking && <VulnerabilityDialog ids={checking.ids} label={checking.label} close={() => setChecking(null)} started={() => {
      setChecking(null); setSelected(new Set()); setNotice(''); if (!detail && view !== 'attention') navigate('attention'); watchVulnerabilities();
    }} />}
    {changingExposure && <ExposureDialog count={selected.size} close={() => setChangingExposure(false)} save={async exposure => {
      await request('/projects/exposure', { ids: [...selected], exposure }); await reload(); setChangingExposure(false);
      setNotice(`${selected.size}件の公開状況を「${exposureLabels[exposure]}」にしました`); setSelected(new Set());
    }} />}
    {changingLifecycle && <LifecycleDialog count={selected.size} close={() => setChangingLifecycle(false)} save={async (next, archiveReason) => {
      await request('/projects/lifecycle', { ids: [...selected], lifecycle: next, archiveReason }); await reload(); setChangingLifecycle(false);
      setNotice(`${selected.size}件の管理状態を「${lifecycleLabels[next]}」にしました`); setSelected(new Set());
    }} />}
    {tagging && <TagDialog close={() => setTagging(false)} save={async tags => { await request('/projects/tags', { ids: [...selected], tags }); await reload(); setTagging(false); setNotice('選択したアプリにタグを追加しました'); }} />}
  </div></PlatformContext.Provider>;
}

function Pagination({ page, total, move, className }: { page: number; total: number; move: (delta: number) => void; className?: string }) {
  return <div className={cn('flex items-center gap-3 text-xs tabular-nums', className)}>
    <Button size="sm" disabled={page === 0} onClick={() => move(-1)}>前へ</Button>
    <span>{page + 1} / {Math.ceil(total / 30)}</span>
    <Button size="sm" disabled={(page + 1) * 30 >= total} onClick={() => move(1)}>次へ</Button>
  </div>;
}

type RemovalReason = 'missing' | 'excluded';
const removals = {
  missing: { endpoint: '/projects/remove-missing', title: '見つからないアプリをカタログから外す', check: '外す直前にもう一度確認し、フォルダがあるものは外しません。',
    hint: '外付けディスクやネットワーク上の場所なら、接続してから「存在を再確認」してください。移動先で使っている場合は「アプリを追加」から登録し直せます。' },
  excluded: { endpoint: '/projects/remove-excluded', title: '除外設定のフォルダにあるアプリをカタログから外す', check: '外す直前に除外設定をもう一度確認し、除外の外にあるものは外しません。',
    hint: '除外を解除すれば、「アプリを追加」から登録し直せます。' },
};

function RemoveDialog({ projects, reason, close, removed }: { projects: Project[]; reason: RemovalReason; close: () => void; removed: (count: number) => Promise<void> }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const text = removals[reason];
  async function confirm() {
    setBusy(true); setError('');
    try { const { removed: count } = await request<{ removed: number }>(text.endpoint, { ids: projects.map(p => p.id) }); await removed(count); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{text.title}</DialogTitle><DialogDescription>{projects.length}件。{text.check}</DialogDescription></DialogHeader>
      <ul className={cn('mb-4 max-h-40 overflow-auto rounded-md border bg-raised px-3 py-2 text-caption', wrap)}>{projects.slice(0, 50).map(p => <li key={p.id} className="py-0.5"><strong className="font-medium">{p.name}</strong> <code className="text-muted-foreground">{p.path}</code></li>)}{projects.length > 50 && <li className="py-0.5 text-muted-foreground">ほか{projects.length - 50}件</li>}</ul>
      <p className="mb-2 text-xs text-dim">ソースやクラウド資源は変更しません。用途・タグ・メモ・履歴は「外した記録」として保存します。</p>
      <p className="mb-4 text-xs text-dim">{text.hint}</p>
      {error && <p role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}</p>}
      <DialogFooter><Button type="button" disabled={busy} onClick={close}>キャンセル</Button><Button variant="destructive" disabled={busy} onClick={() => void confirm()}>{busy ? '外しています…' : `${projects.length}件を外す`}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function TagDialog({ close, save }: { close: () => void; save: (tags: string[]) => Promise<void> }) {
  const [value, setValue] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const id = useId();
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>タグをまとめて追加</DialogTitle></DialogHeader>
      <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const tags = splitTags(value); if (!tags.length) throw new Error('追加するタグを入力してください'); await save(tags); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
        <Field id={id} label="タグ" hint="カンマで区切って入力。既存のタグは残ります。"><Input id={id} aria-describedby={`${id}-hint`} autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder="個人開発, 要調査" maxLength={500} /></Field>
        {error && <p role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}</p>}
        <DialogFooter><Button type="button" onClick={close}>キャンセル</Button><Button variant="default" disabled={busy}>{busy ? '追加中…' : 'タグを追加'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

// Selected paths without those inside another selected path: excluding the outer folder covers them.
const outermost = (paths: string[]) => [...new Set(paths)].sort().filter((path, i, list) => !list.slice(0, i).some(root => withinPath(root, path)));
// Registered projects and folders excluded from future scans. They stay in the catalog, marked as excluded, until removed there.
function ExcludeDialog({ paths, projects, close, excluded }: { paths: string[]; projects: Project[]; close: () => void; excluded: (registered: number, removed: number) => Promise<void> }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const inside = projects.filter(p => paths.some(path => withinPath(path, p.path))).length;
  const [removeRegistered, setRemoveRegistered] = useState(false);
  const [exclusionSaved, setExclusionSaved] = useState(false);
  const choiceId = useId();
  async function submit() {
    setBusy(true); setError('');
    let saved = exclusionSaved;
    try {
      const { registeredInside } = await request<{ registeredInside: number }>('/exclusions', { paths });
      saved = true; setExclusionSaved(true);
      let removed = 0;
      if (removeRegistered) {
        // Re-read before removal so retrying a partly completed operation does not target already removed ids.
        const { projects: current } = await request<{ projects: Project[] }>('/projects');
        const ids = current.filter(p => paths.some(path => withinPath(path, p.path))).map(p => p.id);
        for (let start = 0; start < ids.length; start += 2000) removed += (await request<{ removed: number }>('/projects/remove-excluded', { ids: ids.slice(start, start + 2000) })).removed;
      }
      await excluded(registeredInside, removed);
    } catch (e) { setError(`${saved ? '除外設定は保存済みです。カタログの整理結果を確認し、必要なら再試行してください。' : ''}${(e as Error).message}`); setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{paths.length === 1 ? 'このフォルダを探索から除外' : `${paths.length}個のフォルダを探索から除外`}</DialogTitle>
        <DialogDescription>今後の探索で、このフォルダとサブフォルダを読み取りません。登録済みのアプリは、下の項目を選んだ場合だけカタログからも外します。元のソースファイルは削除しません。</DialogDescription></DialogHeader>
      <ul className="mb-3 max-h-40 overflow-y-auto rounded-md border bg-sunken px-3 py-2 font-mono text-caption">{paths.map(path => <li key={path} className={cn('py-0.5', wrap)}>{path}</li>)}</ul>
      <p className="mb-2 text-xs tabular-nums">登録済みのアプリ {inside}件が含まれます。</p>
      {inside > 0 && <div className="mb-4 flex items-start gap-2"><Checkbox id={choiceId} checked={removeRegistered} disabled={busy} onCheckedChange={value => setRemoveRegistered(value === true)} /><Label htmlFor={choiceId} className="text-caption leading-relaxed">このフォルダ内の登録済みアプリもカタログから外す</Label></div>}
      <p className="mb-4 text-caption text-muted-foreground">除外は「アプリを追加」の「除外するフォルダ」から解除できます。ソースは変更しません。</p>
      {error && <p role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}</p>}
      <DialogFooter><Button type="button" disabled={busy} onClick={close}>キャンセル</Button><Button variant="default" disabled={busy} onClick={() => void submit()}><EyeOff size={15} />{busy ? '除外中…' : '除外する'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ExposureDialog({ count, close, save }: { count: number; close: () => void; save: (exposure: Exposure) => Promise<void> }) {
  const [value, setValue] = useState<Exposure | ''>(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const id = useId();
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>公開状況をまとめて変更</DialogTitle><DialogDescription>選択中の{count}件に同じ公開状況を記録します。影響の確認や絞り込みに使います。公開状況だけでは優先度を引き下げません。</DialogDescription></DialogHeader>
      <form onSubmit={async e => { e.preventDefault(); if (!value) { setError('公開状況を選んでください'); return; } setBusy(true); setError(''); try { await save(value); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>
        <Field id={id} label="公開状況"><NativeSelect id={id} containerClassName="w-full" value={value} onChange={e => setValue(e.target.value as Exposure)}>
          <NativeSelectOption value="" disabled>選んでください</NativeSelectOption>
          {Object.entries(exposureLabels).map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}
        </NativeSelect></Field>
        {error && <p role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}</p>}
        <DialogFooter><Button type="button" disabled={busy} onClick={close}>キャンセル</Button><Button variant="default" disabled={busy}>{busy ? '変更中…' : `${count}件を変更`}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function LifecycleDialog({ count, close, save }: { count: number; close: () => void; save: (lifecycle: Lifecycle, archiveReason: string) => Promise<void> }) {
  const [value, setValue] = useState<Lifecycle | ''>(''); const [reason, setReason] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const id = useId();
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!value) { setError('変更後の管理状態を選んでください'); return; }
    setBusy(true);
    try { await save(value, value === 'archived' ? reason : ''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>管理状態をまとめて変更</DialogTitle><DialogDescription>選択中の{count}件を同じ管理状態にします。用途・タグ・メモは変わりません。</DialogDescription></DialogHeader>
      <form onSubmit={submit}>
        <Field id={id} label="変更後の管理状態"><NativeSelect id={id} containerClassName="w-full" autoFocus value={value} onChange={e => setValue(e.target.value as Lifecycle)}>
          <NativeSelectOption value="" disabled>選んでください</NativeSelectOption>
          {Object.entries(lifecycleLabels).map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}
        </NativeSelect></Field>
        {value === 'archived' && <Field id={`${id}-reason`} label="アーカイブの理由（任意）" hint="入力すると、選択したすべてのアプリに同じ理由を記録します。ソースは変更しません。"><Textarea id={`${id}-reason`} aria-describedby={`${id}-reason-hint`} rows={2} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></Field>}
        {error && <p role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}</p>}
        <DialogFooter><Button type="button" disabled={busy} onClick={close}>キャンセル</Button><Button variant="default" disabled={busy}>{busy ? '変更中…' : `${count}件を変更`}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function Field({ id, label, hint, className, children }: { id: string; label: string; hint?: string; className?: string; children: ReactNode }) {
  return <div className={cn('mb-6 flex flex-col gap-2', className)}>
    <Label htmlFor={id}>{label}</Label>{children}
    {hint && <p id={`${id}-hint`} className="text-caption text-muted-foreground">{hint}</p>}
  </div>;
}

function Discovery({ initial, imported, changed, exclusionsChanged, showExcluded }: { initial?: Scan; imported: (id: string, projectIds: string[], check: boolean) => Promise<void>; changed: (scan?: Scan) => void;
  exclusionsChanged: () => void; showExcluded: () => void }) {
  const capabilities = usePlatform();
  const [root, setRoot] = useState(initial?.root || '');
  const [scan, setScan] = useState<Scan | undefined>(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('new'); const [query, setQuery] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [picking, setPicking] = useState(false);
  const [pathTarget, setPathTarget] = useState<'scan' | 'exclude' | null>(null);
  const [page, setPage] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [removingScan, setRemovingScan] = useState(false);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [registeredInside, setRegisteredInside] = useState(0);
  const [roots, setRoots] = useState<ScanRoot[] | null>(null);
  const [adding, setAdding] = useState<'register' | 'check' | null>(null);
  // Candidates are listed from every folder's latest scan together. detail shows one scan instead, picked from a folder or the history.
  const [detail, setDetail] = useState(false);
  const [combined, setCombined] = useState<CombinedCandidates | null>(null);
  const [combinedKey, setCombinedKey] = useState(0);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  // The folder and exclusion lists fold away so a long list does not push the new candidates down. The choice is remembered per browser;
  // until one is made, they start folded only when a result is shown under a long list.
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(() => { try { const saved = localStorage.getItem('owndapp.discoverySettings'); return saved ? saved === 'open' : null; } catch { return null; } });
  useEffect(() => { if (settingsOpen === null && roots) setSettingsOpen(!(initial && roots.length + exclusions.length > 5)); }, [roots]);
  const showSettings = settingsOpen ?? true;
  const toggleSettings = () => { setSettingsOpen(!showSettings); try { localStorage.setItem('owndapp.discoverySettings', showSettings ? 'closed' : 'open'); } catch { /* not remembered */ } };
  const settingsId = useId();
  const importId = useRef(crypto.randomUUID());
  const loadRoots = () => request<{ roots: ScanRoot[] }>('/scan-roots').then(d => setRoots(d.roots), e => setError(e.message));
  useEffect(() => { void loadRoots(); }, []);
  // A finished scan changes its folder's summary.
  useEffect(() => { if (scan && scan.status !== 'running') { void loadRoots(); setCombinedKey(k => k + 1); } }, [scan?.id, scan?.status]);
  // A scan of every folder runs one folder after another; the screen follows each scan in turn.
  useEffect(() => { void request<{ sweep: Sweep | null }>('/scans/sweep').then(d => setSweep(d.sweep), () => {}); }, []);
  useEffect(() => {
    if (sweep?.status !== 'running') return;
    let alive = true;
    const interval = setInterval(() => { void request<{ sweep: Sweep | null }>('/scans/sweep').then(async ({ sweep: latest }) => {
      if (!alive) return;
      setSweep(latest);
      if (latest?.scanId && latest.scanId !== scan?.id) { const { scan: next } = await request<{ scan: Scan }>(`/scans/${latest.scanId}?limit=0`); if (alive) { setScan(next); changed(next); setRoot(next.root); } }
    }).catch(() => {}); }, 600);
    return () => { alive = false; clearInterval(interval); };
  }, [sweep?.status, scan?.id]);
  useEffect(() => { void request<{ exclusions: string[] }>('/exclusions').then(d => setExclusions(d.exclusions)).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!initial) return;
    let alive = true;
    void request<{ scan: Scan }>(`/scans/${initial.id}?limit=30&filter=new`).then(({ scan }) => { if (alive) setScan(scan); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [initial?.id]);
  useEffect(() => {
    if (!scan || scan.status !== 'running') return;
    const id = scan.id; let alive = true;
    const interval = setInterval(() => { void request<{ scan: Scan }>(`/scans/${id}?limit=30`).then(({ scan }) => { if (alive) { setScan(scan); changed(scan); setError(''); } }).catch(e => { if (alive) setError(e.message); }); }, 600);
    return () => { alive = false; clearInterval(interval); };
  }, [scan?.id, scan?.status]);
  const showingAll = !detail || !scan;
  useEffect(() => {
    if (!showingAll) return;
    let alive = true; setPageLoading(true);
    const params = new URLSearchParams({ limit: '30', offset: String(page * 30), filter, q: query });
    void request<CombinedCandidates>(`/candidates?${params}`).then(data => {
      if (alive) { setCombined(data); setError(''); if (page > 0 && !data.candidates.length) setPage(0); }
    }, e => { if (alive) setError(e.message); }).finally(() => { if (alive) setPageLoading(false); });
    return () => { alive = false; };
  }, [showingAll, page, filter, query, combinedKey]);
  useEffect(() => {
    if (showingAll || !scan || scan.status === 'running' || !scan.persistent) return;
    let alive = true; setPageLoading(true);
    const params = new URLSearchParams({ limit: '30', offset: String(page * 30), filter, q: query });
    void request<{ scan: Scan }>(`/scans/${scan.id}?${params}`).then(({ scan: latest }) => {
      if (alive) { setScan(latest); setError(''); if (page > 0 && !latest.candidates.length) setPage(0); }
    }, e => { if (alive) setError(e.message); }).finally(() => { if (alive) setPageLoading(false); });
    return () => { alive = false; };
  }, [showingAll, scan?.id, scan?.status, scan?.persistent, page, filter, query]);
  const paged = showingAll || !!scan?.persistent;
  const rows = showingAll ? combined?.candidates ?? [] : scan?.persistent ? scan.candidates : (scan?.candidates || []).filter(c => (filter === 'all' || (filter === 'registered' ? c.registered : !c.registered)) && [c.name, c.path, ...c.technologies].join(' ').toLowerCase().includes(query.toLowerCase()));
  const totalRows = showingAll ? combined?.filteredCount ?? 0 : scan?.persistent ? scan.filteredCount ?? rows.length : rows.length;
  const pageRows = paged ? rows : rows.slice(page * 30, (page + 1) * 30);
  const selectable = rows.filter(c => !c.registered);
  const selectedVisible = selectable.filter(c => selected.has(c.id)).length;
  async function selectAll(on: boolean) {
    if (!paged) { choose(selectable.map(c => c.id), on); return; }
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ filter: 'new', q: query });
      const { ids } = await request<{ ids: string[] }>(`${showingAll ? '/candidates' : `/scans/${scan!.id}`}/selection?${params}`);
      choose(ids, on);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function scanAction(action: 'pause' | 'cancel' | 'resume' | 'retry' | 'remove') {
    if (!scan) return;
    setBusy(true); setError('');
    try {
      await request(`/scans/${scan.id}/${action}`, {});
      if (action === 'remove') { setRemovingScan(false); setScan(undefined); changed(undefined); setSelected(new Set()); await loadRoots(); }
      else { const { scan: latest } = await request<{ scan: Scan }>(`/scans/${scan.id}?limit=30`); setScan(latest); changed(latest); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function choose(ids: string[], on: boolean) {
    const next = new Set(selected); ids.forEach(id => on ? next.add(id) : next.delete(id));
    if (next.size > 2000) { setError('一度に選べるのは2000件までです。登録後に残りを選んでください'); return; }
    setSelected(next);
    importId.current = crypto.randomUUID();
  }
  async function start(folder: string, errorInDialog = false) {
    setError(''); setBusy(true);
    try { const { scan } = await request<{ scan: Scan }>('/scans', { root: folder }); setRoot(scan.root); setQuery(''); setFilter('new'); setDetail(false); setScan(scan); changed(scan); setSelected(new Set()); setPage(0); importId.current = crypto.randomUUID(); void loadRoots(); return null; }
    catch (e) { if (!errorInDialog) setError((e as Error).message); return (e as Error).message; } finally { setBusy(false); }
  }
  async function show(id: string) {
    setError(''); setQuery('');
    try { const { scan } = await request<{ scan: Scan }>(`/scans/${id}?limit=30&filter=new`); setRoot(scan.root); setScan(scan); changed(scan); setDetail(true); setSelected(new Set()); setPage(0); setFilter('new'); importId.current = crypto.randomUUID(); }
    catch (e) { setError((e as Error).message); }
  }
  function showAll() { setDetail(false); setSelected(new Set()); setPage(0); setFilter('new'); setQuery(''); importId.current = crypto.randomUUID(); }
  async function scanEverything() {
    setError(''); setBusy(true);
    try { const data = await request<{ sweep: Sweep }>('/scans/sweep', {}); setSweep(data.sweep); setDetail(false); setSelected(new Set()); setPage(0); importId.current = crypto.randomUUID(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function unregister(path: string) {
    setError('');
    try { const data = await request<{ roots: ScanRoot[] }>('/scan-roots/remove', { path }); setRoots(data.roots); }
    catch (e) { setError((e as Error).message); }
  }
  async function pick() {
    setError(''); setPicking(true);
    try {
      const { path } = await request<{ path: string | null }>('/folder-picker', { defaultPath: root || undefined });
      if (path) await start(path);
    } catch (e) { setError((e as Error).message); } finally { setPicking(false); }
  }
  const locked = busy || picking || scan?.status === 'running' || sweep?.status === 'running';
  // The server drops excluded candidates from the scan result, so refreshing it applies the change without a rescan.
  async function changeExclusions(path: string, action: 'add' | 'remove', errorInDialog = false) {
    setError('');
    try {
      const data = await request<{ exclusions: string[]; registeredInside?: number }>(action === 'add' ? '/exclusions' : '/exclusions/remove', { path });
      setExclusions(data.exclusions); setRegisteredInside(data.registeredInside || 0); exclusionsChanged(); void loadRoots();
      setSelected(new Set()); importId.current = crypto.randomUUID();
      if (showingAll || (scan && scan.status !== 'running')) {
        try {
          const params = new URLSearchParams({ limit: '30', offset: String(page * 30), filter, q: query });
          if (showingAll) setCombined(await request<CombinedCandidates>(`/candidates?${params}`));
          else { const { scan: latest } = await request<{ scan: Scan }>(`/scans/${scan!.id}?${params}`); setScan(latest); changed(latest); }
        } catch (e) { setError(`除外設定は保存しましたが、候補を更新できませんでした。画面を再読み込みしてください（${(e as Error).message}）`); }
      }
      return null;
    } catch (e) { if (!errorInDialog) setError((e as Error).message); return (e as Error).message; }
  }
  async function pickExclusion() {
    setError(''); setPicking(true);
    try {
      const { path } = await request<{ path: string | null }>('/folder-picker', { defaultPath: root || undefined, purpose: 'exclude' });
      if (path) await changeExclusions(path, 'add');
    } catch (e) { setError((e as Error).message); } finally { setPicking(false); }
  }
  async function add(check: boolean) {
    setError(''); setBusy(true); setAdding(check ? 'check' : 'register');
    try { const result = await request<{ id: string; projectIds: string[] }>('/imports', { id: importId.current, scanId: showingAll ? undefined : scan?.id, candidateIds: [...selected] }); await imported(result.id, result.projectIds, check); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); setAdding(null); }
  }
  const insideNotice = <p role="status" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-warning"><CircleAlert size={14} className="shrink-0" />追加した除外の中に、登録済みのアプリが{registeredInside}件あります。<a href="#catalog" className="text-inherit underline" onClick={e => { e.preventDefault(); showExcluded(); }}>カタログで確認して外す</a></p>;
  return <>
    <PageHeader context="ローカルの開発資産を見つける" title="アプリを追加" subtitle="親フォルダを探索して、登録するアプリを選びます。" />
    <section aria-label="探索するフォルダ" className="mb-6 rounded-lg border bg-raised p-6 max-md:p-4">
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <FolderSearch size={19} className="shrink-0 text-muted-foreground max-md:hidden" />
        <div className="min-w-0 flex-1 max-md:basis-full">
          <p className="text-xs font-medium">探索するフォルダ{roots && <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{roots.length}件{!showSettings && ` · 除外 ${exclusions.length}件`}</span>}</p>
          <p className="mt-1 text-caption text-muted-foreground">登録したフォルダは、いつでも再探索できます。依存物・ビルド成果物・シンボリックリンク・Claude Code の作業用コピー（.claude/worktrees）は除外します。</p>
        </div>
        {roots && roots.length + exclusions.length > 0 && <Button variant="ghost" size="sm" className="text-dim max-md:order-last" aria-expanded={showSettings} aria-controls={settingsId}
          aria-label={showSettings ? '探索フォルダと除外の一覧を隠す' : '探索フォルダと除外の一覧を表示'} onClick={toggleSettings}>
          {showSettings ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{showSettings ? '一覧を隠す' : '一覧を表示'}</Button>}
        {!!roots?.length && <Button className="max-md:w-full" disabled={locked} title="登録したフォルダを順に探索し直し、すべての候補をまとめて表示します" onClick={() => void scanEverything()}><RefreshCw size={15} />すべて探索</Button>}
        <Button variant={capabilities.folderPicker ? 'outline' : 'default'} className="max-md:w-full" disabled={locked} onClick={() => setPathTarget('scan')}>探索フォルダをパスで追加</Button>
        {capabilities.folderPicker && <Button variant="default" className="max-md:w-full" disabled={locked} onClick={() => void pick()}><Plus size={16} />{picking ? 'フォルダを選択中…' : busy ? '準備中…' : 'フォルダを追加'}</Button>}
      </div>
      {!capabilities.folderPicker && <p className="mt-3 text-caption text-muted-foreground">フォルダのパスを直接入力して追加します。フォルダ選択・外部アプリ起動は、このOSでは利用できません。</p>}
      {!showSettings && <>
        {scan && <div className="mt-4 flex items-center gap-3 rounded-md bg-background px-3 py-2 max-md:flex-wrap">
          <div className="min-w-0 flex-1 max-md:basis-full"><span className="block text-caption text-muted-foreground">{detail ? '表示中の結果' : '直近の探索'}</span><code className={cn('block text-[13px] text-foreground', wrap)}>{scan.root}</code></div>
          <Button size="sm" disabled={locked || roots?.some(item => item.path === scan.root && item.excluded)} aria-label={`${scan.root}を再探索`} onClick={() => void start(scan.root)}><RefreshCw size={14} />再探索</Button>
        </div>}
        {registeredInside > 0 && insideNotice}
      </>}
      <div id={settingsId} hidden={!showSettings}>
      {roots && (roots.length ? <ul aria-label="登録した探索フォルダ" className="mt-4 grid gap-1">{roots.map(item => {
        const current = item.path === root;
        return <li key={item.path} aria-current={current ? 'true' : undefined} className={cn('flex items-center gap-3 rounded-md bg-background px-3 py-2 max-md:flex-wrap', current && 'bg-brand-subtle')}>
          <div className="min-w-0 flex-1 max-md:basis-full">
            <code className={cn('block text-[13px] text-foreground', wrap)}>{item.path}</code>
            <span className={cn('mt-0.5 block text-caption tabular-nums', item.excluded ? 'text-warning' : 'text-muted-foreground')}>{item.excluded ? '除外設定に含まれるため探索できません' : item.lastScan
              ? `${date(item.lastScan.endedAt || item.lastScan.startedAt)} · ${scanLabels[item.lastScan.status]} · 候補${item.lastScan.candidates}件（未登録${item.lastScan.newCandidates}件）${current ? detail ? ' · 表示中' : ' · 直近の探索' : ''}` : '未探索'}</span>
          </div>
          {item.lastScan && item.lastScan.status !== 'completed' && !(current && detail) && <Button size="sm" variant="ghost" disabled={locked} title="この探索の問題・再開・再試行を確認します" onClick={() => void show(item.lastScan!.id)}>詳細</Button>}
          <Button size="sm" disabled={locked || item.excluded} aria-label={`${item.path}を再探索`} onClick={() => void start(item.path)}><RefreshCw size={14} />再探索</Button>
          <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label={`${item.path}の登録を解除`} title="探索フォルダの登録を解除（登録済みのアプリは変わりません）" disabled={locked} onClick={() => void unregister(item.path)}><X size={15} /></Button>
        </li>;
      })}</ul> : <p className="mt-4 text-[13px] text-muted-foreground">「探索フォルダをパスで追加」で入力すると、登録して探索を始めます。</p>)}
      <div className="mt-6 border-t pt-4" aria-label="除外するフォルダ" role="group">
        <div className="flex items-center gap-3 max-md:flex-wrap">
          <div className="min-w-0 flex-1"><p className="text-xs font-medium">除外するフォルダ<span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{exclusions.length}件</span></p>
            <p className="mt-1 text-caption text-muted-foreground">指定したフォルダとそのサブフォルダは、すべての探索で読み取りません。</p></div>
          <Button size="sm" className="max-md:w-full" disabled={locked} onClick={() => setPathTarget('exclude')}>除外フォルダをパスで追加</Button>
          {capabilities.folderPicker && <Button size="sm" className="max-md:w-full" disabled={locked} onClick={() => void pickExclusion()}><FolderMinus size={15} />除外するフォルダを追加</Button>}
        </div>
        {exclusions.length > 0 && <ul className="mt-3 grid gap-1">{exclusions.map(path => <li key={path} className="flex items-center gap-2 rounded-md bg-background px-3 py-1.5">
          <code className={cn('min-w-0 flex-1 text-caption text-dim', wrap)}>{path}</code>
          <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label={`${path}の除外を解除`} title="除外を解除" disabled={scan?.status === 'running'} onClick={() => void changeExclusions(path, 'remove')}><X size={15} /></Button>
        </li>)}</ul>}
        {registeredInside > 0 && showSettings && insideNotice}
      </div>
      </div>
    </section>
    {error && <Alert variant="destructive" className="mb-6"><CircleAlert size={18} /><AlertDescription>{error}</AlertDescription></Alert>}
    {sweep?.status === 'running' && <p aria-live="polite" className="mb-3 flex items-center gap-2 text-xs tabular-nums"><FolderSearch size={15} className="shrink-0 text-brand" />すべてのフォルダを探索中: {Math.min(sweep.done + 1, sweep.roots.length)} / {sweep.roots.length}フォルダ目。一時停止・キャンセルすると、残りのフォルダは探索しません。</p>}
    {sweep && sweep.status !== 'running' && sweep.skipped.length > 0 && <p className="mb-3 text-caption text-warning">見つからないか除外されたため、{sweep.skipped.length}件のフォルダを探索しませんでした: {sweep.skipped.slice(0, 3).join('、')}{sweep.skipped.length > 3 ? ' ほか' : ''}</p>}
    {scan || roots?.length ? <>
      {scan && <div className="mb-6 flex flex-wrap items-center gap-4 text-xs" aria-live="polite">
        <span className={cn('size-[7px] rounded-full', scan.status === 'partial' || scan.status === 'paused' || scan.status === 'cancelled' ? 'bg-warning' : 'bg-brand')} />
        <strong>{scanLabels[scan.status]}</strong>
        <span className="tabular-nums">{scan.status === 'running' ? `${scan.visited.toLocaleString()}項目を確認` : scan.status === 'paused' && !scan.candidateCount ? `${scan.found ?? 0}件を検出（候補は再開後に整理）` : `${scan.candidateCount ?? scan.candidates.length}件の候補`}</span>
        {scan.status !== 'running' && !!scan.pending && <span className="text-warning tabular-nums">{scan.pending.toLocaleString()}フォルダが未処理です</span>}
        <span className="text-muted-foreground tabular-nums">除外 {scan.excluded.toLocaleString()}項目</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {scan.persistent && scan.status === 'running' && <Button size="sm" disabled={busy} onClick={() => void scanAction('pause')}>一時停止</Button>}
          {scan.persistent && (scan.canResume ?? (['paused', 'failed'].includes(scan.status) || scan.status === 'cancelled' && !!scan.pending)) && <Button size="sm" disabled={busy} onClick={() => void scanAction('resume')}>続きから再開</Button>}
          {scan.persistent && scan.status !== 'running' && (scan.canRetry ?? ((scan.issueCount ?? scan.issues.length) > 0)) && <Button size="sm" disabled={busy} onClick={() => void scanAction('retry')}>失敗したフォルダを再試行</Button>}
          {scan.status === 'running' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void scanAction('cancel')}>キャンセル</Button>}
          {scan.status !== 'running' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemovingScan(true)}>探索記録を削除…</Button>}
        </div>
        <code className={cn('basis-full text-caption text-muted-foreground', wrap)}>{scan.root}</code>
      </div>}
      {scan?.status === 'paused' && <div className="mb-6"><ScanProgress scan={scan} /></div>}
      {scan?.status === 'running' ? <ScanProgress scan={scan} /> : <section aria-label="見つかった候補">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          {showingAll ? <p className="text-xs"><strong>すべての探索フォルダの候補</strong><span className="ml-2 text-muted-foreground tabular-nums">{combined ? `${combined.candidateCount.toLocaleString()}件 · 探索済み ${combined.folders.scanned} / ${combined.folders.total}フォルダ` : ''}</span></p>
            : <p className="text-xs"><strong>この探索の候補</strong><code className={cn('ml-2 text-caption text-muted-foreground', wrap)}>{scan!.root}</code></p>}
          {!showingAll && <Button size="sm" variant="ghost" onClick={showAll}><ChevronLeft size={14} />すべての候補に戻る</Button>}
        </div>
        {showingAll && combined && combined.folders.scanned < combined.folders.total && <p className="mb-3 text-caption text-warning">まだ探索していないフォルダが{combined.folders.total - combined.folders.scanned}件あります。「すべて探索」で探索できます。</p>}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4 max-md:gap-2">
          <div role="group" className="flex gap-1" aria-label="候補の絞り込み">{[['new', '新規'], ['registered', '登録済み'], ['all', 'すべて']].map(([id, text]) =>
            <Button key={id} variant="ghost" size="sm" aria-pressed={filter === id} className="aria-pressed:border-border aria-pressed:bg-accent" onClick={() => { setFilter(id); setPage(0); }}>{text}</Button>)}</div>
          <SearchBox label="候補を絞り込み" className="w-[260px] max-md:w-full max-md:basis-full"><Search size={16} className="shrink-0" /><Input className={searchInput} placeholder="候補を絞り込み" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} /></SearchBox>
        </div>
        {selectable.length > 0 && <div className="flex min-h-12 items-center gap-3 border-t bg-raised px-4 max-md:px-1">
          <Checkbox id="select-visible" checked={selectedVisible === selectable.length ? true : selectedVisible ? 'indeterminate' : false} disabled={busy || pageLoading} onCheckedChange={checked => void selectAll(checked === true)} />
          <Label htmlFor="select-visible" className="cursor-pointer text-xs">表示中の新規候補をすべて選択<span className="ml-1 font-normal text-muted-foreground tabular-nums">{paged && filter === 'new' ? totalRows : selectable.length}件</span></Label>
          {query && <span className="text-caption text-muted-foreground max-md:hidden">「{query}」で絞り込み中</span>}
          {paged && totalRows > 30 && <Button size="sm" variant="ghost" disabled={busy || pageLoading} onClick={() => choose(pageRows.filter(c => !c.registered).map(c => c.id), true)}>このページの新規候補を選択</Button>}
        </div>}
        {pageLoading && <p aria-live="polite" className="py-2 text-caption text-muted-foreground">候補を読み込んでいます…</p>}
        {pageRows.length ? <div className="border-t">{pageRows.map(candidate => <CandidateRow key={candidate.id} candidate={candidate} selected={selected.has(candidate.id)} toggle={() => choose([candidate.id], !selected.has(candidate.id))} exclude={() => void changeExclusions(candidate.path, 'add')} />)}</div>
          : <Empty><Search size={28} /><h2 className={emptyTitle}>該当する候補がありません</h2><p className={emptyText}>候補の区分や検索条件、探索するフォルダを確認してください。</p></Empty>}
        <div className="sticky bottom-0 z-10 flex items-center justify-between gap-4 border-b bg-background p-4 max-md:flex-wrap max-md:px-0">
          <div className="flex items-center gap-3"><span className="text-xs tabular-nums">{selected.size}件を選択<span className="mt-1 block text-micro text-muted-foreground">追加後に用途やタグを整理できます。チェックは送る内容の確認後に始めます。</span></span>{selected.size > 0 && <Button size="sm" disabled={busy} onClick={() => { setSelected(new Set()); importId.current = crypto.randomUUID(); }}>選択を解除</Button>}</div>
          {totalRows > 30 && <Pagination className="gap-2 max-md:order-3 max-md:w-full max-md:justify-center" page={page} total={totalRows} move={delta => setPage(p => p + delta)} />}
          <div className="flex items-center gap-2 max-md:w-full max-md:[&>button]:flex-1">
            <Button className="max-md:px-3 max-md:text-xs" disabled={!selected.size || busy} title="登録して、追加分の一覧で整理します" onClick={() => void add(false)}><Plus size={17} />{adding === 'register' && selected.size ? `${selected.size}件を確認・登録中…` : '選択した候補を登録'}</Button>
            <Button variant="default" className="max-md:px-3 max-md:text-xs" disabled={!selected.size || busy} title="登録したあと、OSVに送る内容を確認してから脆弱性をチェックします" onClick={() => void add(true)}><ShieldAlert size={17} />{adding === 'check' && selected.size ? `${selected.size}件を確認・登録中…` : '登録してチェック'}</Button>
          </div>
        </div>
      </section>}
      {scan && !showingAll && (scan.issueCount ?? scan.issues.length) > 0 && <ScanIssues key={scan.id} scan={scan} />}
    </> : <div className="mt-12 grid grid-cols-3 gap-8 max-md:mt-8 max-md:grid-cols-1 max-md:gap-4">
      {[['フォルダを指定', 'アプリをまとめて置いている親フォルダを指定します。'], ['候補を確認', '設定ファイルから技術構成を検出。登録するものを選べます。'], ['登録してチェック', '選んだ候補を登録し、脆弱性をチェックします。用途やタグの整理は任意です。']].map(([title, text], i) =>
        <div key={title} className="pr-4 max-md:relative max-md:pl-8">
          <span className="mb-3 inline-flex font-mono text-xs text-muted-foreground max-md:absolute max-md:top-0 max-md:left-0">{i + 1}</span>
          <h2 className="mb-2 text-sm font-semibold">{title}</h2>
          <p className="max-w-[240px] text-xs leading-[1.9] text-muted-foreground max-md:max-w-none">{text}</p>
        </div>)}
    </div>}
    {pathTarget && <FolderPathDialog key={pathTarget} target={pathTarget} close={() => setPathTarget(null)} submit={pathTarget === 'scan' ? path => start(path, true) : path => changeExclusions(path, 'add', true)} />}
    <ScanHistory refreshKey={`${scan?.id}:${scan?.status}:${sweep?.done}`} show={show} />
    <Dialog open={removingScan} onOpenChange={setRemovingScan}>
      <DialogContent><DialogHeader><DialogTitle>探索記録を削除</DialogTitle><DialogDescription>この探索の途中経過・候補・問題の記録を削除します。登録済みアプリと元のファイルは残ります。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setRemovingScan(false)}>戻る</Button><Button variant="destructive" disabled={busy} onClick={() => void scanAction('remove')}>探索記録を削除</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function SettingsView({ apps, changed, toDiscover }: { apps: OpenApps; changed: (apps: OpenApps) => void; toDiscover: () => void }) {
  return <>
    <PageHeader context="この端末での使い方" title="設定・使い方" subtitle="使い方を確認し、探索フォルダや作業用のアプリを設定します。" />
    <UsageGuide />
    <section className="mb-8 border-y py-5"><h2 className="mb-2 text-sm font-semibold">探索・除外フォルダ</h2><p className="mb-3 text-caption text-muted-foreground">探す範囲と、今後は探さないフォルダを管理します。登録済みアプリの整理とは別の設定です。</p><Button onClick={toDiscover} variant="outline" size="sm">探索・除外フォルダを管理</Button></section>
    <OpenAppSettings apps={apps} changed={changed} />
  </>;
}

type VulnerabilityData = { check: VulnerabilityCheck | null; summary: VulnerabilitySummary | null };
// The right column keeps a fixed-height summary so the records below it stay in view; every advisory is in VulnerabilityList.
const summaryGroups = 3;
const dependencyLine = (dependency: Dependency) => <><code>{dependency.name}@{dependency.version}</code>（{dependency.direct ? '直接' : '間接'}・{scopeLabels[dependency.scope]}）</>;
const fixLine = (group: FindingGroup) => group.fixed ? <>修正版 <code className="text-foreground">{group.fixed}</code>{group.withoutFix ? `（${group.withoutFix}件は修正版の情報なし）` : ''}</> : group.advisories.some(a => a.detailsAvailable) ? '修正版の情報なし' : '詳細を取得できませんでした';

function VulnerabilityPanel({ project, data, check, showList, panelText, error, retry }: { project: Project; data: VulnerabilityData | null; check: () => void; showList: () => void; panelText: string; error?: string; retry?: () => void }) {
  const result = data?.check; const summary = data?.summary;
  const notSent = result ? Object.entries(result.notSent).filter(([, n]) => n > 0) : [];
  const groups = groupFindings(result?.findings ?? []);
  const [copyState, setCopyState] = useState<{ busy: boolean; message: string; error?: boolean }>({ busy: false, message: '' });
  const [memoText, setMemoText] = useState<string | null>(null);
  // The same fix memo as the response queue, read fresh so statuses set there (対象外・解消確認) are left out here too.
  async function copyMemo() {
    setCopyState({ busy: true, message: '' });
    let text: string;
    try { const queue = decodeQueue(await request<QueueWire>(`/queue?project=${encodeURIComponent(project.id)}`)); text = buildMemo(project, queue.items, queue.projects[project.id]?.checkedAt ?? null, queue.projects[project.id]); }
    catch (e) { setCopyState({ busy: false, message: (e as Error).message, error: true }); return; }
    try { await navigator.clipboard.writeText(text); setCopyState({ busy: false, message: '対策メモをコピーしました' }); }
    catch { setCopyState({ busy: false, message: '' }); setMemoText(text); }
  }
  if (error || !data) return <section className="rounded-lg border bg-raised p-6 max-xl:col-span-full" aria-labelledby={`${project.id}-vulns`}>
    <h2 id={`${project.id}-vulns`} className="mb-2 text-sm font-semibold">既知の脆弱性</h2>
    {error ? <><p role="alert" className="mb-3 text-caption text-error">脆弱性の記録を取得できませんでした: {error}</p><Button type="button" size="sm" onClick={retry}>脆弱性の記録を再取得</Button></> : <p role="status" className={panelText}>脆弱性の記録を読み込み中…</p>}
  </section>;
  return <section className="rounded-lg border bg-raised p-6 max-xl:col-span-full" aria-labelledby={`${project.id}-vulns`}>
    {summary?.count ? <ShieldAlert size={23} className={cn('mb-3', severityTone(summary.highest))} /> : <ShieldQuestion size={23} className="mb-3 text-dim" />}
    <h2 id={`${project.id}-vulns`} className="mb-2 text-sm font-semibold">{!result ? '既知の脆弱性は未照会です' : summary?.count ? `既知の脆弱性 ${summary.count}件` : '既知の脆弱性は見つかっていません'}</h2>
    {!result ? <p className={panelText}>{project.dependencyStatus ? '読み取った依存（npm・Composer・Python・Rust）を、OSVのデータベースに照会できます。' : '先に「依存情報を読む」で依存を読み取ってください。'}</p> : <>
      {groups.length > 0 && <p className="mb-3 flex flex-wrap gap-x-3 text-caption tabular-nums">{severityCounts(groups).map(([severity, n]) => <span key={severity} className={severityTone(severity)}>{severityLabels[severity]} {n}</span>)}<span className="text-muted-foreground">{groups.length}個の依存</span></p>}
      <p className={panelText}>{date(result.checkedAt)}時点。{result.queried.toLocaleString()}種類の版を照会しました{result.failed ? `（${result.failed}種類は照会できず）` : ''}。</p>
      {summary?.stale && <p className="mb-3 flex items-center gap-1.5 text-caption text-warning"><CircleAlert size={14} className="shrink-0" />照会後に依存内容が変わりました。再照会してください</p>}
      {groups.length > 0 && <>
        <ul className="mb-3 grid gap-3">{groups.slice(0, summaryGroups).map(group => <li key={`${group.dependency.name}@${group.dependency.version}`} className={cn('border-t pt-3 text-caption', wrap)}>
          <div className="flex flex-wrap items-baseline gap-x-2"><span className={cn('font-semibold', severityTone(group.highest))}>{severityLabels[group.highest]}</span><code className="text-foreground">{group.dependency.name}@{group.dependency.version}</code>
            {group.advisories.length > 1 && <span className="text-muted-foreground tabular-nums">{group.advisories.length}件</span>}</div>
          <p className="mt-1 text-muted-foreground">{fixLine(group)}</p>
        </li>)}</ul>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button size="sm" disabled={copyState.busy} onClick={() => void copyMemo()}><Copy size={14} />{copyState.busy ? '作成中…' : '対策メモをコピー'}</Button>
          <span aria-live="polite" className={cn('text-caption', copyState.error ? 'text-error' : 'text-muted-foreground')}>{copyState.message}</span>
        </div>
        <p className={panelText}>更新する版・対応案・進め方をまとめたテキストです。Claude Code などに渡して対応を進められます。</p>
        <Button variant="link" size="sm" className="mb-3 min-h-8 px-0 text-caption" onClick={showList}>{groups.length > summaryGroups ? `ほか${groups.length - summaryGroups}個の依存を含む` : ''}全{summary?.count ?? groups.length}件の詳細を見る</Button>
      </>}
      {notSent.length > 0 && <p className={panelText}>照会していない依存: {notSent.map(([reason, n]) => `${notSentLabels[reason] || reason} ${n}件`).join('、')}</p>}
      <p className={panelText}>OSVに登録済みの既知の脆弱性だけが対象です。実際に悪用できるか、未公開の問題がないかはわかりません。更新候補・Gitの状態は未確認です。</p>
    </>}
    <Button size="sm" disabled={!project.dependencyStatus || project.dependencyStatus === 'no-lock'} onClick={check}><ShieldAlert size={14} />{result ? '再照会' : '脆弱性を照会'}</Button>
    {memoText !== null && <MemoDialog text={memoText} close={() => setMemoText(null)} />}
  </section>;
}

// Every advisory, one block per dependency version, in the wide column where long summaries stay readable.
function VulnerabilityList({ id, findings }: { id: string; findings: VulnerabilityFinding[] }) {
  const groups = groupFindings(findings);
  if (!groups.length) return null;
  const count = groups.reduce((n, g) => n + g.advisories.length, 0);
  return <section id={id} className="mt-12 border-t pt-6 max-xl:mt-8" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`} tabIndex={-1} className="mb-2 text-base font-semibold outline-none">既知の脆弱性の詳細<span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">{count}件・{groups.length}個の依存</span></h2>
    <p className="mb-6 text-caption text-muted-foreground">依存の版ごとに、重大度の高い順。修正版はアドバイザリに記載された情報です。</p>
    {groups.map(group => <div key={`${group.dependency.ecosystem}:${group.dependency.name}@${group.dependency.version}`} className={cn('border-t py-4 text-caption', wrap)}>
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold"><span className={severityTone(group.highest)}>{severityLabels[group.highest]}</span><span className="font-normal text-muted-foreground">{dependencyLine(group.dependency)}→ {fixLine(group)}</span></h3>
      <ul className="mt-3 grid gap-3 pl-4">{group.advisories.map(a => <li key={a.id}>
        <div className="flex flex-wrap items-baseline gap-x-2"><span className={cn('font-semibold', severityTone(a.severity))}>{severityLabels[a.severity]}</span>
          <a href={`https://osv.dev/vulnerability/${encodeURIComponent(a.id)}`} target="_blank" rel="noreferrer" className="font-mono text-foreground">{a.id}</a>
          {a.aliases.length > 0 && <span className="text-micro text-muted-foreground">{a.aliases.slice(0, 2).join('、')}</span>}
          {group.advisories.length > 1 && <span className="text-micro text-muted-foreground">{a.fixed ? `修正版 ${a.fixed}` : a.detailsAvailable ? '修正版の情報なし' : '詳細を取得できませんでした'}</span>}</div>
        {a.summary && <p className="mt-1 text-dim">{a.summary}</p>}
        {a.severitySource && <p className="mt-1 text-muted-foreground">重大度の出典: {a.severitySource}{a.severityScore != null ? ` / CVSS値: ${a.severityScore}` : ''}</p>}
        {a.severityReason && <p className="mt-1 text-muted-foreground">{a.severityReason}</p>}
        {(a.severityConflict || a.severityRetained) && <p className="mt-1 text-warning">{a.severityRetained ? '前回の重大度を保持・再照会が必要' : '重大度の情報に差異あり・高い判定を採用'}</p>}
      </li>)}</ul>
    </div>)}
  </section>;
}

type Preview = { destination: string; projects: number; notRead: string[]; reread: string[]; packageVersions: number; byEcosystem: Partial<Record<Ecosystem, number>>; notSent: Record<string, number>;
  nothingToSend: { name: string; reason: 'no-lock' | 'failed' | 'no-sendable' }[] };
const nothingToSendLabels = { 'no-lock': '対応しているlockがありません', failed: 'lockを読み取れませんでした', 'no-sendable': '照会できる依存がありません（Git・ローカルなど）' };
type CheckOutcome = { results: { id: string; name: string; status: string; count: number }[]; queried: number; failed: number };
type VulnerabilityJob = { id: string; status: 'running' | 'done' | 'failed'; phase: 'reading' | 'querying' | 'details'; done: number; total: number;
  projects: number; read: number; result?: CheckOutcome; error?: string };
const jobPhaseLabels = { reading: '依存を読み取り中', querying: 'OSVに照会中（パッケージの版）', details: 'アドバイザリの詳細を取得中' };
const checkStatusLabels: Record<string, string> = { complete: '判定済み', partial: '一部のみ判定', failed: '照会失敗', 'kept-previous': '前回の結果を維持', 'not-read': 'フォルダなし・未読み取り', 'nothing-to-check': '判定できる依存なし（lockなし等）' };

// Shows exactly what will leave this Mac before anything is sent.
function VulnerabilityDialog({ ids, label, close, started }: { ids: string[]; label?: string; close: () => void; started: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { request<Preview>('/vulnerabilities/preview', { ids }).then(setPreview, e => setError(e.message)); }, []);
  async function run() {
    setBusy(true); setError('');
    try {
      await request('/vulnerabilities/check', { ids });
      started();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const notSent = preview ? Object.entries(preview.notSent).filter(([, n]) => n > 0) : [];
  const byEcosystem = preview ? Object.entries(preview.byEcosystem ?? {}).filter(([, n]) => n > 0) as [Ecosystem, number][] : [];
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>既知の脆弱性を照会</DialogTitle><DialogDescription>{label ?? `選んだ${ids.length}件`}の依存（npm・Composer・Python・Rust）を、OSVのデータベースに照会します。</DialogDescription></DialogHeader>
      {!preview ? <p className="mb-4 text-xs text-muted-foreground">{error || '送る内容を確認しています。'}</p> : <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border bg-raised p-4 text-xs">
        <dt className="text-muted-foreground">送信先</dt><dd><code>{preview.destination}</code>（Googleが運営するOSV）</dd>
        <dt className="text-muted-foreground">送る内容</dt><dd className="tabular-nums">ecosystem・パッケージ名・版 <strong>{preview.packageVersions.toLocaleString()}種類</strong>（読み取り済みの{preview.projects}件から重複を除いて{byEcosystem.length > 0 && `。${byEcosystem.map(([e, n]) => `${ecosystemLabels[e]} ${n.toLocaleString()}`).join('・')}`}）{preview.notRead.length > 0 && '。下の未読み取りの分が加わります'}</dd>
        <dt className="text-muted-foreground">送らないもの</dt><dd>フォルダのパス、アプリ名、ソース、lockファイル{notSent.length ? `、${notSent.map(([r, n]) => `${notSentLabels[r] || r}の依存${n}件`).join('、')}` : ''}
          {preview.notSent.unknown > 0 && <span className="mt-1 block text-muted-foreground">取得元不明の依存は、「依存情報を読む」で読み直すと照会できる場合があります（lockに取得元が書かれていない版を、設定済みのレジストリのものとして扱うようにしたため）</span>}</dd>
        {preview.notRead.length > 0 && <><dt className="text-muted-foreground">先に読み取り</dt><dd className={wrap}>依存を読み取っていない{preview.notRead.length}件（{preview.notRead.slice(0, 3).join('、')}{preview.notRead.length > 3 ? ' ほか' : ''}）は、照会の前にこの端末で読み取ります</dd></>}
        {preview.reread.length > 0 && <><dt className="text-muted-foreground">読み直し</dt><dd className={wrap}>前回lockがなかった・一部しか読めなかった{preview.reread.length}件（{preview.reread.slice(0, 3).join('、')}{preview.reread.length > 3 ? ' ほか' : ''}）は、照会の前に読み直します</dd></>}
        <dt className="text-muted-foreground">進め方</dt><dd>裏側で進め、画面上部に進み具合を出します。照会前に毎回、対象の依存情報を読み直します。表示の種類数は保存済み情報による目安で、読み直し後に変わる場合があります。OSVが混み合っているときは待って再試行します</dd>
        {preview.nothingToSend.length > 0 && <><dt className="text-muted-foreground">照会なし</dt><dd><ul className="grid gap-1">{preview.nothingToSend.slice(0, 5).map(p => <li key={p.name} className={wrap}>{p.name}: {nothingToSendLabels[p.reason]}</li>)}
          {preview.nothingToSend.length > 5 && <li className="text-muted-foreground">ほか{preview.nothingToSend.length - 5}件</li>}</ul></dd></>}
      </dl>}
      {error && preview && <p role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}</p>}
      <DialogFooter><Button type="button" disabled={busy} onClick={close}>キャンセル</Button>
        <Button variant="default" disabled={busy || !preview || (!preview.packageVersions && !preview.notRead.length && !preview.reread.length)} onClick={() => void run()}>{busy ? '開始中…' : !preview ? '確認中…' : preview.packageVersions || preview.notRead.length || preview.reread.length ? `${ids.length.toLocaleString()}件を照会` : '照会できる依存がありません'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function DependencyPanel({ project, reloadProjects, className, headingClassName }: { project: Project; reloadProjects: () => Promise<void>; className: string; headingClassName: string }) {
  const [data, setData] = useState<{ snapshot: DependencySnapshot | null; dependencies: Dependency[]; changed: boolean } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => request<NonNullable<typeof data>>(`/projects/${project.id}/dependencies`).then(setData, e => setError(e.message));
  useEffect(() => { void load(); }, [project.id, project.dependenciesReadAt]);
  async function read() {
    setError(''); setBusy(true);
    try { const { results } = await readDependencies([project.id]); if (results[0]?.status === 'missing') throw new Error('フォルダが見つからないため読み取れません'); await reloadProjects(); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const snapshot = data?.snapshot;
  const direct = data?.dependencies.filter(d => d.direct) || [];
  const problems = snapshot?.files.filter(f => f.status !== 'ok') || [];
  return <section className={className} aria-labelledby={`${project.id}-deps`}>
    <h2 id={`${project.id}-deps`} className={headingClassName}><Package size={16} />依存関係</h2>
    {!data ? <p className="text-caption text-muted-foreground">{error || '読み込んでいます。'}</p> : !snapshot ? <p className="mb-3 text-caption leading-[1.8] text-muted-foreground">まだ読み取っていません。lockファイルを読むだけで、インストールや実行はしません。</p> : <>
      <dl className="grid grid-cols-2 gap-2 text-caption">
        <dt className="text-muted-foreground">状態</dt><dd className={cn('text-right', snapshot.status !== 'complete' && 'text-warning')}>{snapshot.files.length > 0 && snapshot.files.every(file => file.status === 'unsupported') ? '依存解析は未対応' : snapshot.status === 'no-lock' && !snapshot.files.length ? '対応する依存形式なし' : dependencyStatusLabels[snapshot.status]}</dd>
        <dt className="text-muted-foreground">依存</dt><dd className="text-right tabular-nums">{snapshot.total}件（直接{snapshot.direct}件）</dd>
        <dt className="text-muted-foreground">読み取り</dt><dd className="text-right">{date(snapshot.readAt)}</dd>
        <dt className="text-muted-foreground">lock形式</dt><dd className="text-right">{[...new Set(snapshot.files.flatMap(f => f.status === 'no-lock' ? [] : f.format ? [f.format] : f.lockfileVersion ? [`npm v${f.lockfileVersion}`] : []))].join('・') || 'なし'}</dd>
      </dl>
      {snapshot.status === 'no-lock' && !snapshot.files.length && <p className="mt-3 text-caption leading-[1.8] text-warning">このアプリには、読み取りに対応する依存形式が見つかりませんでした。現在の対象はnpm・Yarn・pnpm・Composer・Python・Rust・Go・Ruby（Bundler）・Maven（pom.xml）です。Swift・Gradleなどの依存検査は未対応で、再読み取りだけでは判定できません。脆弱性なしという意味ではありません。</p>}
      {data.changed && <p className="mt-3 flex items-center gap-1.5 text-caption text-warning"><CircleAlert size={14} className="shrink-0" />読み取り後に lock または宣言のファイル（package.json など）が変わっています</p>}
      {problems.length > 0 && <ul className="mt-3 grid gap-1.5 text-caption">{problems.map(f => <li key={f.path} className={wrap}><code className="text-dim">{f.path}</code> <span className={f.status === 'no-lock' ? 'text-muted-foreground' : 'text-warning'}>{fileStatusLabels[f.status]}</span>{f.message && <span className="block text-muted-foreground">{f.message}</span>}</li>)}</ul>}
      {direct.length > 0 && <details className="mt-3 text-caption text-dim"><summary className="min-h-8 py-1.5">直接依存 {direct.length}件</summary>
        <ul className="grid gap-2">{direct.map((d, i) => <li key={i}><DependencyLine dependency={d} /></li>)}</ul></details>}
    </>}
    {error && data && <p role="alert" className="mt-3 rounded-md bg-error-subtle p-2 text-caption text-error">{error}</p>}
    <Button size="sm" className="mt-3" disabled={busy || project.missing} onClick={() => void read()}><RefreshCw size={14} />{busy ? '読み取り中…' : snapshot ? '読み直す' : '依存情報を読む'}</Button>
  </section>;
}

function GitPanel({ project, reloadProjects, className, headingClassName }: { project: Project; reloadProjects: () => Promise<void>; className: string; headingClassName: string }) {
  const [observation, setObservation] = useState<GitObservation | null | undefined>(undefined);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => request<{ observation: GitObservation | null }>(`/projects/${project.id}/git`).then(d => setObservation(d.observation), e => setError(e.message));
  useEffect(() => { void load(); }, [project.id, project.gitReadAt]);
  async function read() {
    setError(''); setBusy(true);
    try { const { results } = await readGitInfo([project.id]); if (results[0]?.status === 'missing') throw new Error('フォルダが見つからないため読み取れません'); await reloadProjects(); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const ready = observation !== undefined;
  return <section className={className} aria-labelledby={`${project.id}-git`}>
    <h2 id={`${project.id}-git`} className={headingClassName}><GitBranch size={16} />Git</h2>
    {!ready ? <p className="text-caption text-muted-foreground">{error || '読み込んでいます。'}</p> : !observation ? <p className="mb-3 text-caption leading-[1.8] text-muted-foreground">まだ読み取っていません。この端末の `.git` からブランチとリモートだけを読みます。fetch や変更の確認はしません。</p> : <>
      <dl className="grid grid-cols-2 gap-2 text-caption">
        <dt className="text-muted-foreground">状態</dt><dd className={cn('text-right', (observation.status === 'unreadable' || observation.status === 'invalid') && 'text-warning')}>{gitStatusLabels[observation.status]}</dd>
        {observation.status === 'ok' && <>
          <dt className="text-muted-foreground">ブランチ</dt><dd className={cn('text-right', wrap)}>{observation.detached ? 'detached HEAD' : observation.branch || '不明'}</dd>
          <dt className="text-muted-foreground">リモート</dt><dd className="text-right tabular-nums">{observation.remotes.length ? `${observation.remotes.length}件` : 'なし'}</dd>
        </>}
        {observation.gitRoot && <><dt className="text-muted-foreground">リポジトリ</dt><dd className={cn('text-right', wrap)}><code className="text-dim">{observation.gitRoot}</code></dd></>}
        <dt className="text-muted-foreground">読み取り</dt><dd className="text-right">{date(observation.readAt)}</dd>
      </dl>
      {observation.message && <p className="mt-3 text-caption text-muted-foreground">{observation.message}</p>}
      {observation.remotes.length > 0 && <ul className="mt-3 grid gap-2 text-caption">{observation.remotes.map(remote => <li key={remote.name} className={wrap}>
        <span className="font-medium text-foreground">{remote.name}</span>
        <code className="mt-0.5 block text-micro text-muted-foreground">{remote.url}</code>
      </li>)}</ul>}
    </>}
    {error && ready && <p role="alert" className="mt-3 rounded-md bg-error-subtle p-2 text-caption text-error">{error}</p>}
    <Button size="sm" className="mt-3" disabled={busy || project.missing} onClick={() => void read()}><RefreshCw size={14} />{busy ? '読み取り中…' : observation ? '読み直す' : 'Git情報を読む'}</Button>
  </section>;
}

type SearchResult = { matches: { project: { id: string; name: string; path: string; lifecycle: Lifecycle }; readAt: string; status: DependencyStatus; dependencies: Dependency[] }[];
  coverage: { read: number; withLock: number; total: number; unsupported?: number } };

type CombinedCandidates = { candidates: ScanCandidate[]; candidateCount: number; filteredCount: number; folders: { total: number; scanned: number } };
type Sweep = { status: 'running' | 'completed' | 'stopped'; roots: string[]; done: number; scanId: string | null; skipped: string[]; startedAt: string; endedAt: string | null };
type DependencyProgress = { running: boolean; done: number; total: number };
type ScanRoot = { path: string; createdAt: string; excluded: boolean;
  lastScan: { id: string; status: Scan['status']; startedAt: string; endedAt: string | null; candidates: number; newCandidates: number } | null };

// "next@15.1.0" -> name and version. A leading "@" belongs to a scoped npm name; a "v" before the digits is dropped (versions are recorded without it).
function parseSearch(text: string) {
  const value = text.trim(); const at = value.lastIndexOf('@');
  return at > 0 ? { name: value.slice(0, at).trim(), version: value.slice(at + 1).trim().replace(/^v(?=\d)/, '') } : { name: value, version: '' };
}

function DependencySearch({ projects, toCatalog, reading, readAll, readSelected }: { projects: Project[]; toCatalog: () => void; reading: boolean; readAll: () => Promise<void>; readSelected: (ids: string[]) => Promise<{ summary: string }> }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<SearchResult & { name: string; version: string; mode: 'contains' | 'exact' } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const id = useId();
  const read = projects.filter(p => p.dependencyStatus);
  const activeCount = projects.filter(p => p.lifecycle !== 'archived').length;
  const heading = useRef<HTMLHeadingElement>(null);
  // Refresh content, not just counts: re-reading an existing app may change its packages.
  const inventoryKey = JSON.stringify(projects.map(p => [p.id, p.dependenciesReadAt, p.dependencyStatus, p.dependencyUnsupported]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const previousInventory = useRef(inventoryKey);
  const lastQuery = useRef<{ name: string; version: string; mode: 'contains' | 'exact' } | null>(null);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => {
    if (reading || previousInventory.current === inventoryKey) return;
    previousInventory.current = inventoryKey;
    const query = lastQuery.current;
    if (query) void run(query.name, query.version, query.mode);
  }, [inventoryKey, reading]);
  async function run(packageName: string, packageVersion: string, mode: 'contains' | 'exact') {
    setError('');
    if (!packageName) { setError('パッケージ名を入力してください'); return; }
    const current = ++sequence.current;
    lastQuery.current = { name: packageName, version: packageVersion, mode };
    setBusy(true);
    try {
      const params = new URLSearchParams({ name: packageName, match: mode, ...(packageVersion ? { version: packageVersion } : {}) });
      const data = await request<SearchResult>(`/dependencies/search?${params}`);
      if (current === sequence.current) setResult({ ...data, name: packageName, version: packageVersion, mode });
    } catch (e) { if (current === sequence.current) { setResult(null); setError((e as Error).message); } } finally { if (current === sequence.current) setBusy(false); }
  }
  // Typing searches by part of the name; an exact name comes from picking a package or narrowing a result.
  function search(event: FormEvent) { event.preventDefault(); const { name, version } = parseSearch(text); void run(name, version, 'contains'); }
  function clear() { sequence.current++; lastQuery.current = null; setText(''); setResult(null); setError(''); setBusy(false); }
  // Picking a package from the list searches that exact name and brings the result into view.
  function pick(packageName: string) {
    setText(packageName);
    void run(packageName, '', 'exact').then(() => { window.scrollTo({ top: 0 }); heading.current?.focus(); });
  }
  // 名前に「vue」を含み版が 3.5.13 の / 「vue」という名前の
  const described = result && `${result.mode === 'exact' ? `「${result.name}」という名前` : `名前に「${result.name}」を含`}${result.version ? `${result.mode === 'exact' ? 'で' : 'み'}版が ${result.version} の` : result.mode === 'exact' ? 'の' : 'む'}`;
  const coverage = result?.coverage || { read: read.length, withLock: read.filter(p => p.dependencyStatus === 'complete' || p.dependencyStatus === 'partial').length, total: projects.length, unsupported: projects.filter(project => project.dependencyUnsupported).length };
  return <>
    <PageHeader context="依存パッケージから探す" title="依存検索" subtitle="読み取った依存の記録（lockファイル・go.mod・pom.xml など）から、パッケージを使っているアプリを探します。" />
    <h2 ref={heading} tabIndex={-1} className="sr-only">パッケージを検索</h2>
    <form onSubmit={search} role="search" className="mb-2 flex flex-wrap items-end gap-3">
      <div className="flex min-w-[240px] flex-1 flex-col gap-2"><Label htmlFor={`${id}-name`}>パッケージ名</Label><Input id={`${id}-name`} value={text} onChange={e => setText(e.target.value)} placeholder="brotli、@types/node、next@15.1.0 など" maxLength={480} autoComplete="off" spellCheck={false} /></div>
      <Button variant="default" disabled={busy} className="max-md:w-full"><Search size={16} />{busy ? '検索中…' : '検索'}</Button>
      {result && <Button type="button" variant="ghost" onClick={clear} className="max-md:w-full">クリア</Button>}
    </form>
    <p className="mb-4 text-caption text-muted-foreground">名前の一部で探します（大文字・小文字は区別しません）。版でも絞るときは「next@15.1.0」のように @ のあとに版を書きます。</p>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <p className="text-caption text-muted-foreground tabular-nums">依存の読み取りを実施 {coverage.read}件 / 登録 {coverage.total}件（解析できた記録 {coverage.withLock}件）。読み取っていないアプリは結果に含まれません。未対応の依存形式は検索対象外です。コード内やOS標準ライブラリの使用は検索しません。脆弱性の有無は判定しません。{(coverage.unsupported ?? 0) > 0 && <span className="mt-1 block text-warning">未対応の依存形式を含むアプリ {coverage.unsupported}件は、一部または全体が検索対象外です。下の「依存の検索範囲」で確認し、読み直せます。</span>}</p>
      <Button size="sm" disabled={reading || !activeCount} onClick={() => void readAll()} title="lockファイルを読むだけで、インストールや実行、外部への送信はしません"><RefreshCw size={14} />{reading ? '読み取り中…' : `アーカイブ以外をすべて読み取る（${activeCount}件）`}</Button>
    </div>
    {error && <Alert variant="destructive" className="mb-6"><CircleAlert size={18} /><AlertDescription>{error}</AlertDescription></Alert>}
    {coverage.read === 0 ? <Empty>
      <Package size={30} className="text-brand" /><h2 className={emptyTitle}>まだ依存情報を読んだアプリがありません</h2>
      <p className={emptyText}>上の「アーカイブ以外をすべて読み取る」か、カタログで選んで「依存情報を読む」を実行してください。これから登録するアプリは自動で読み取ります。lockファイルを読むだけで、インストールや実行はしません。</p>
      <Button onClick={toCatalog}>カタログで選ぶ<ArrowRight size={16} /></Button>
    </Empty> : result && (result.matches.length ? <section aria-label="検索結果">
      <p className="mb-3 text-xs"><strong className="tabular-nums">{result.matches.length}件</strong>のアプリが、{described}パッケージを使っています</p>
      <Table>
        <TableHeader><TableRow className="border-0"><TableHead>アプリ</TableHead><TableHead>一致した依存</TableHead><TableHead className="max-lg:hidden">読み取り</TableHead></TableRow></TableHeader>
        <TableBody>{result.matches.map(match => <TableRow key={match.project.id}>
          <TableCell className="w-[38%] align-top max-md:w-auto"><a className={cn('text-sm font-semibold text-foreground no-underline', wrap)} href={`#project/${match.project.id}`}>{match.project.name}</a>
            <code className={cn('mt-1 block text-caption text-muted-foreground', wrap)}>{match.project.path}</code><div className="mt-2"><LifecycleLabel lifecycle={match.project.lifecycle} /></div></TableCell>
          <TableCell className="align-top"><ul className="grid gap-2">{match.dependencies.map((d, i) => <li key={i}><DependencyLine dependency={d} /></li>)}</ul></TableCell>
          <TableCell className="align-top max-lg:hidden"><time className="text-caption whitespace-nowrap text-muted-foreground" dateTime={match.readAt}>{date(match.readAt)}</time>
            {match.status !== 'complete' && <span className="mt-1 block text-micro text-warning">{dependencyStatusLabels[match.status]}</span>}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </section> : <Empty><Search size={28} /><h2 className={emptyTitle}>読み取り済み{result.coverage.read}件の範囲では見つかりません</h2>
      <p className={emptyText}>{described}依存は記録にありませんでした（Pythonは - と _ の違いを無視）。{result.mode === 'exact' ? '名前の一部で探すと見つかることがあります。' : ''}読み取っていないアプリや、対応していない形式の依存は確認していません。</p>
      {result.mode === 'exact' && <Button onClick={() => void run(result.name, result.version, 'contains')}>「{result.name}」を名前の一部として探す</Button>}</Empty>)}
    <DependencyCoverage projects={projects} reading={reading} onRead={readSelected} />
    {coverage.read > 0 && <PackageOverview key={inventoryKey} query={result?.name ?? ''} pick={pick} />}
  </>;
}

type PackageSummary = { ecosystem: Ecosystem; name: string; projects: number; directProjects: number; versions: string[] };
const compareVersions = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

// Every package recorded in the ledger, most used first, so the contents can be browsed without knowing a name.
// After a search it lists only the package names containing the searched text, so the search box drives both.
function PackageOverview({ query, pick }: { query: string; pick: (name: string) => void }) {
  const [limit, setLimit] = useState(100);
  // A new search starts from the first 100 again; the previous list stays until the new one arrives.
  const [shownQuery, setShownQuery] = useState(query);
  if (shownQuery !== query) { setShownQuery(query); setLimit(100); }
  const [data, setData] = useState<{ total: number; packages: PackageSummary[]; query: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      request<{ total: number; packages: PackageSummary[] }>(`/dependencies/packages?${new URLSearchParams({ q: query, limit: String(limit) })}`)
        .then(d => { if (alive) { setData({ ...d, query }); setError(''); } }, e => { if (alive) setError(e.message); });
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, limit]);
  return <section aria-labelledby="package-overview" className="mt-10">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
      <div><h2 id="package-overview" className="text-base font-semibold">記録されているパッケージ</h2>
        <p className="mt-1 text-caption text-muted-foreground tabular-nums">{data ? `${data.query ? `「${data.query}」を名前に含むもの ` : ''}${data.total.toLocaleString()}種類。使っているアプリが多い順。名前を選ぶと、その名前だけで検索します。` : '読み込んでいます。'}</p></div>
    </div>
    {error && <Alert variant="destructive" className="mb-4"><CircleAlert size={18} /><AlertDescription>{error}</AlertDescription></Alert>}
    {data && (data.packages.length ? <>
      <Table>
        <TableHeader><TableRow className="border-0"><TableHead>パッケージ</TableHead><TableHead className="text-right">アプリ</TableHead><TableHead className="max-md:hidden">記録された版</TableHead></TableRow></TableHeader>
        <TableBody>{data.packages.map(item => { const versions = [...item.versions].sort(compareVersions); return <TableRow key={`${item.ecosystem}:${item.name}`}>
          <TableCell className={wrap}><Button variant="link" size="sm" className="h-auto min-h-0 px-0 font-mono text-[13px] text-foreground" onClick={() => pick(item.name)}>{item.name}</Button>
            <span className="ml-2 text-micro text-muted-foreground">{ecosystemLabels[item.ecosystem ?? 'npm']}</span>
            <span className="mt-0.5 hidden text-caption text-muted-foreground max-md:block">{versions.slice(0, 3).join('、')}{versions.length > 3 ? ` ほか${versions.length - 3}` : ''}</span></TableCell>
          <TableCell className="text-right text-caption whitespace-nowrap tabular-nums">{item.projects}件<span className="block text-micro text-muted-foreground">直接 {item.directProjects}件</span></TableCell>
          <TableCell className={cn('text-caption text-muted-foreground max-md:hidden', wrap)}>{versions.slice(0, 6).join('、')}{versions.length > 6 ? ` ほか${versions.length - 6}版` : ''}</TableCell>
        </TableRow>; })}</TableBody>
      </Table>
      {data.packages.length < data.total && <div className="flex items-center justify-between gap-4 py-4 text-caption text-muted-foreground tabular-nums">
        <span>{data.packages.length.toLocaleString()} / {data.total.toLocaleString()}種類を表示</span>
        <Button size="sm" onClick={() => setLimit(l => Math.min(l + 200, 1000))} disabled={limit >= 1000}>{limit >= 1000 ? 'パッケージ名で検索するとほかも表示できます' : 'さらに表示'}</Button>
      </div>}
    </> : <p className="border-y py-8 text-center text-caption text-muted-foreground">「{data.query}」を名前に含むパッケージは記録されていません。</p>)}
  </section>;
}

function Evidence({ items }: { items: { file: string; detail: string }[] }) {
  return <ul className="list-disc pl-4">{items.map((item, i) => <li key={i} className={cn('mb-3', wrap)}><code className="text-caption">{item.file}</code><span className="block text-muted-foreground">{item.detail}</span></li>)}</ul>;
}

function CandidateRow({ candidate, selected, toggle, exclude }: { candidate: ScanCandidate; selected: boolean; toggle: () => void; exclude: () => void }) {
  return <div className={cn('flex gap-4 border-b px-4 py-6 max-md:gap-3 max-md:px-1', selected && 'bg-brand-subtle')}>
    <Checkbox className="mt-[5px]" aria-label={`${candidate.name}を登録候補に選択`} checked={selected} disabled={candidate.registered} onCheckedChange={toggle} />
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-4"><strong className={wrap}>{candidate.name}</strong><div className="flex shrink-0 items-center gap-2">
        <span className="text-caption whitespace-nowrap text-muted-foreground">{candidate.registered ? '登録済み' : '新規候補'}</span>
        <Button variant="ghost" size="sm" className="min-h-7 px-2 text-caption text-dim" title="このフォルダとサブフォルダを今後の探索から除外します" aria-label={`${candidate.name}のフォルダを探索から除外`} onClick={exclude}><EyeOff size={14} /><span className="max-md:sr-only">除外</span></Button>
      </div></div>
      <code className={cn('mt-1 block text-caption text-muted-foreground', wrap)}>{candidate.path}</code>
      <TechLine technologies={candidate.technologies} />
      {!candidate.registered && !!candidate.registeredInside && <p className="mt-2 flex items-center gap-1.5 text-caption text-warning"><CircleAlert size={14} className="shrink-0" />配下のフォルダが{candidate.registeredInside}件、別のアプリとして登録済みです</p>}
      {!candidate.registered && candidate.incomplete && <p className="mt-2 flex items-center gap-1.5 text-caption text-warning"><CircleAlert size={14} className="shrink-0" />中の一部を確認できていません。登録するときに読み直します</p>}
      <details className="mt-3 text-caption text-dim">
        <summary className="min-h-8 py-1.5">検出根拠{candidate.components.length > 0 ? `・${candidate.components.length}個のComponent` : ''}</summary>
        {candidate.components.map(component => <p key={component.path} className="my-1 flex items-center gap-1.5"><FileCode2 size={14} className="shrink-0" />{component.name} <code className="text-caption">{component.path}</code></p>)}
        <Evidence items={candidate.evidence} />
        {(candidate.componentTotal || candidate.evidenceTotal) && <p className="mt-2 text-caption text-muted-foreground">一覧は構成要素・根拠をそれぞれ先頭200件まで表示しています。検出結果はDBに保存しています。</p>}
      </details>
    </div>
  </div>;
}

function ProjectDetail({ project, checkVulnerabilities, reloadProjects, apps, open, openSettings, back, saved, onDirty, reveal, remove, exclude }: { project: Project; checkVulnerabilities: () => void; reloadProjects: () => Promise<void>; apps: { role: AppRole; app: { name: string } }[]; open: (role: AppRole) => void; openSettings: () => void;
  back: () => void; saved: () => Promise<void>; onDirty: (dirty: boolean) => void; reveal: () => void; remove: (reason: RemovalReason) => void; exclude: () => void }) {
  const capabilities = usePlatform();
  const [edit, setEdit] = useState<ProjectEdit>({ revision: project.revision, name: project.name, purpose: project.purpose, tags: project.tags, notes: project.notes, lifecycle: project.lifecycle, archiveReason: project.archiveReason, exposure: project.exposure ?? 'unknown' });
  const [tags, setTags] = useState(project.tags.join(', ')); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [latest, setLatest] = useState<Project | null>(null);
  // The lifecycle to return to when the archive box is cleared. Archived projects from before archivedFrom was kept return to 未設定.
  const [restoreTo, setRestoreTo] = useState<Lifecycle>(project.lifecycle === 'archived' ? project.archivedFrom ?? 'untriaged' : project.lifecycle);
  const archived = edit.lifecycle === 'archived';
  // A README or manifest description to offer when the purpose is empty. Nothing is filled until the button is pressed.
  const [suggestion, setSuggestion] = useState<{ text: string; source: string } | null>(null);
  useEffect(() => { if (!project.purpose.trim()) void request<{ suggestion: typeof suggestion }>(`/projects/${project.id}/purpose-suggestion`).then(d => setSuggestion(d.suggestion), () => {}); }, [project.id]);
  const dirtyCallback = useRef(onDirty); dirtyCallback.current = onDirty;
  const id = useId();
  useEffect(() => { dirtyCallback.current(dirty); return () => dirtyCallback.current(false); }, [dirty]);
  const [history, setHistory] = useState<{ action: string; createdAt: string; payload: string }[]>([]);
  useEffect(() => { void request<{ history: typeof history }>(`/projects/${project.id}/history`).then(d => setHistory(d.history)).catch(() => {}); }, [project.id, project.revision]);
  const [vulnerabilities, setVulnerabilities] = useState<VulnerabilityData | null>(null);
  const [vulnerabilityError, setVulnerabilityError] = useState('');
  const [vulnerabilityRetry, setVulnerabilityRetry] = useState(0);
  useEffect(() => {
    let active = true; setVulnerabilities(null); setVulnerabilityError('');
    void request<VulnerabilityData>(`/projects/${project.id}/vulnerabilities`).then(data => { if (active) setVulnerabilities(data); }, error => { if (active) setVulnerabilityError(error.message); });
    return () => { active = false; };
  }, [project.id, project.vulnerabilities?.checkedAt, project.vulnerabilities?.status, project.dependenciesReadAt, vulnerabilityRetry]);
  const vulnerabilityListId = `${id}-vulnerability-list`;
  function showVulnerabilityList() {
    document.getElementById(vulnerabilityListId)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    document.getElementById(`${vulnerabilityListId}-heading`)?.focus({ preventScroll: true });
  }
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  function update<K extends keyof ProjectEdit>(key: K, value: ProjectEdit[K]) { setDirty(true); setEdit(prev => ({ ...prev, [key]: value })); }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try { const result = await request<{ project: Project }>(`/projects/${project.id}`, { ...edit, tags: splitTags(tags) }, false, 'PATCH'); setEdit(prev => ({ ...prev, revision: result.project.revision })); setDirty(false); await saved(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const panelText = 'mb-3 text-caption leading-[1.9] text-muted-foreground last:mb-0';
  const recordSection = 'mt-6 border-t pt-6 text-xs max-xl:mt-0 max-md:mt-6';
  const recordHeading = 'mb-3 flex items-center gap-2 text-xs font-semibold';
  return <>
    <Button variant="ghost" className="mb-4 min-h-8 border-0 pl-0 text-xs text-dim hover:bg-transparent hover:text-foreground" onClick={() => { if (!dirty || window.confirm('保存していない変更があります。カタログに戻りますか？')) back(); }}><ArrowLeft size={16} />一覧に戻る</Button>
    <header className="mb-8 flex items-start justify-between gap-6 max-md:mb-6 max-md:flex-wrap max-md:gap-4">
      <div className="min-w-0"><h1 className={cn(headingTitle, wrap)}>{project.name}</h1><code className={cn('mt-1 block text-caption text-muted-foreground', wrap)}>{project.path}</code><TechLine technologies={project.technologies} /></div>
      <div className="flex shrink-0 flex-col items-end gap-3 max-md:w-full max-md:items-start">
        <div className="flex flex-wrap justify-end gap-2 max-md:justify-start">
          {apps.map(({ role, app }) => { const Icon = appIcons[role]; return <Button key={role} size="sm" disabled={project.missing} onClick={() => open(role)}><Icon size={16} />{app.name}で開く</Button>; })}
          {capabilities.revealFolder && <Button size="sm" disabled={project.missing} onClick={reveal}><FolderOpen size={16} />Finderで表示</Button>}
          {!project.excluded && !project.missing && <Button size="sm" variant="ghost" className="text-dim" onClick={exclude}><EyeOff size={16} />探索から除外</Button>}
        </div>
        {capabilities.externalApps && apps.length < 2 && <Button variant="link" size="sm" className="min-h-6 px-0 text-caption" onClick={openSettings}>{apps.length ? '開くアプリを追加' : 'エディタ・ターミナルを登録'}</Button>}
        <LifecycleLabel lifecycle={project.lifecycle} />
      </div>
    </header>
    <ProjectResponsePanel project={project} refreshKey={`${project.vulnerabilities?.checkedAt}:${project.vulnerabilities?.status}:${project.dependenciesReadAt}`} recheck={checkVulnerabilities} />
    {project.missing && <Alert variant="destructive" className="mb-8"><FolderX size={18} /><AlertDescription>フォルダが見つかりません。移動・削除された可能性があります。移動先で使っている場合は「アプリを追加」から登録し直してください。</AlertDescription><Button size="sm" variant="destructive" className="shrink-0" onClick={() => remove('missing')}>カタログから外す…</Button></Alert>}
    {project.excluded && !project.missing && <Alert variant="warning" className="mb-8"><EyeOff size={18} /><AlertDescription>除外設定のフォルダにあります。今後の探索では読み取りません。カタログに残す必要がなければ外せます。</AlertDescription><Button size="sm" variant="destructive" className="shrink-0" onClick={() => remove('excluded')}>カタログから外す…</Button></Alert>}
    <div className="grid grid-cols-[minmax(0,1.8fr)_minmax(240px,1fr)] gap-12 max-xl:grid-cols-[minmax(0,1fr)] max-xl:gap-8">
      <div className="min-w-0"><section className="border-t pt-6"><h2 className="mb-6 text-base font-semibold">アプリを整理</h2><form onSubmit={save}>
        <Field id={`${id}-name`} label="名前"><Input id={`${id}-name`} required maxLength={200} value={edit.name} onChange={e => update('name', e.target.value)} /></Field>
        <Field id={`${id}-purpose`} label="用途"><Textarea id={`${id}-purpose`} aria-describedby={`${id}-purpose-note`} rows={2} maxLength={2000} placeholder="何のために作ったアプリですか？" value={edit.purpose} onChange={e => update('purpose', e.target.value)} />
          {project.purposeSource && edit.purpose === project.purpose ? <p id={`${id}-purpose-note`} className="text-caption text-muted-foreground">{project.purposeSource}から自動入力しました。編集すると自分の記述として扱います。</p>
            : !edit.purpose.trim() && suggestion ? <div id={`${id}-purpose-note`} className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
              <span className={wrap}>{suggestion.source}の説明: {suggestion.text}</span>
              <Button type="button" size="sm" className="min-h-7" onClick={() => update('purpose', suggestion.text)}>この説明を入れる</Button></div> : null}</Field>
        <div className="grid grid-cols-[1fr_1fr_1.5fr] gap-4 max-lg:grid-cols-2 max-md:grid-cols-1 max-md:gap-0">
          <Field id={`${id}-exposure`} label="公開状況"><NativeSelect id={`${id}-exposure`} aria-label="公開状況" containerClassName="w-full" value={edit.exposure ?? 'unknown'}
            onChange={e => update('exposure', e.target.value as Exposure)}>{Object.entries(exposureLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
          <Field id={`${id}-lifecycle`} label="管理状態"><NativeSelect id={`${id}-lifecycle`} aria-label="管理状態" containerClassName="w-full" disabled={archived} value={archived ? restoreTo : edit.lifecycle}
            onChange={e => { const next = e.target.value as Lifecycle; setRestoreTo(next); update('lifecycle', next); }}>{Object.entries(lifecycleLabels).filter(([value]) => value !== 'archived').map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
          <Field id={`${id}-tags`} label="タグ" hint="カンマ区切り"><Input id={`${id}-tags`} aria-describedby={`${id}-tags-hint`} value={tags} onChange={e => { setTags(e.target.value); setDirty(true); }} placeholder="個人開発, 要調査" maxLength={500} /></Field>
        </div>
        <div className="mb-6 flex items-start gap-2">
          <Checkbox id={`${id}-archive`} className="mt-0.5" aria-describedby={`${id}-archive-hint`} checked={archived} onCheckedChange={checked => update('lifecycle', checked === true ? 'archived' : restoreTo)} />
          <div><Label htmlFor={`${id}-archive`} className="cursor-pointer">アーカイブする</Label>
            <p id={`${id}-archive-hint`} className="mt-1 text-caption text-muted-foreground">{archived ? `アーカイブ一覧に移します。チェックを外すと管理状態は「${lifecycleLabels[restoreTo]}」に戻ります。` : 'カタログの一覧から外し、アーカイブ一覧で記録を残します。理由は任意です。'}</p></div>
        </div>
        {(edit.lifecycle === 'archived' || edit.archiveReason) && <Field id={`${id}-reason`} label="アーカイブの理由（任意）" hint="カタログ上の分類です。ソースやクラウド資源は変更しません。"><Textarea id={`${id}-reason`} aria-describedby={`${id}-reason-hint`} value={edit.archiveReason} maxLength={2000} rows={2} onChange={e => update('archiveReason', e.target.value)} /></Field>}
        <Field id={`${id}-notes`} label="メモ"><Textarea id={`${id}-notes`} rows={5} value={edit.notes} maxLength={10000} onChange={e => update('notes', e.target.value)} placeholder="再開時の注意点、関連する取り組みなど" /></Field>
        {error && <div role="alert" className="mb-4 rounded-md bg-error-subtle p-3 text-xs text-error">{error}<Button type="button" size="sm" className="mt-2 flex text-caption" onClick={async () => { try { const { projects } = await request<{ projects: Project[] }>('/projects'); setLatest(projects.find(p => p.id === project.id) || null); } catch (e) { setError((e as Error).message); } }}>入力を保持して最新の内容を確認</Button></div>}
        {latest && <section className={cn('mb-4 rounded-md border border-border-strong p-4', wrap)}>
          <h2 className="mb-3 text-base font-semibold">現在保存されている内容</h2>
          <dl className="grid grid-cols-2 gap-2 text-caption"><dt className="text-muted-foreground">名前</dt><dd>{latest.name}</dd><dt className="text-muted-foreground">用途</dt><dd>{latest.purpose || '未入力'}</dd><dt className="text-muted-foreground">管理状態</dt><dd>{lifecycleLabels[latest.lifecycle]}</dd><dt className="text-muted-foreground">タグ</dt><dd>{latest.tags.join(', ') || 'なし'}</dd></dl>
          <p className="my-3 text-xs whitespace-pre-wrap text-muted-foreground">メモ: {latest.notes || 'なし'}</p>
          <Button type="button" onClick={() => { setEdit(prev => ({ ...prev, revision: latest.revision })); setLatest(null); setError('入力内容を優先する準備ができました。内容を確認して保存してください。'); }}>入力内容を優先する</Button>
        </section>}
        <div className="flex items-center justify-end gap-3 pt-2"><span className="mr-auto text-caption text-muted-foreground">{dirty ? '未保存の変更があります' : '保存済み'}</span><Button variant="default" disabled={busy}><Check size={16} />{busy ? '保存中…' : '変更を保存'}</Button></div>
      </form></section>
        {vulnerabilities?.check && <VulnerabilityList id={vulnerabilityListId} findings={vulnerabilities.check.findings} />}
      </div>
      <aside className="max-xl:grid max-xl:grid-cols-2 max-xl:gap-6 max-md:block">
        <VulnerabilityPanel project={project} data={vulnerabilities} error={vulnerabilityError} retry={() => setVulnerabilityRetry(value => value + 1)} check={checkVulnerabilities} showList={showVulnerabilityList} panelText={panelText} />
        <section className={recordSection}><h2 className={recordHeading}>構成の記録</h2>
          <dl className="grid grid-cols-2 gap-2 text-caption"><dt className="text-muted-foreground">登録</dt><dd className="text-right">{date(project.createdAt)}</dd><dt className="text-muted-foreground">構成の確認</dt><dd className="text-right">{date(project.observedAt)}</dd></dl>
          {project.components.length > 0 && <p className="mt-3">Component {project.components.length}件</p>}
          <details className="mt-3 text-caption text-dim"><summary className="min-h-8 py-1.5">検出の根拠を確認</summary><Evidence items={project.evidence} /></details>
        </section>
        <DependencyPanel project={project} reloadProjects={reloadProjects} className={recordSection} headingClassName={recordHeading} />
        <GuardPanel projectId={project.id} className={recordSection} headingClassName={recordHeading} />
        <GitPanel project={project} reloadProjects={reloadProjects} className={recordSection} headingClassName={recordHeading} />
        <section className={recordSection}><h2 className={recordHeading}><ClipboardList size={16} />整理の履歴</h2>{history.length ? <ul className="m-0 list-none p-0">{history.map((item, i) => <li key={i} className="mb-2 flex justify-between gap-3 text-caption"><span>{item.action === 'registered' ? 'カタログに登録' : item.action === 'tags_added' ? 'タグを追加' : item.action === 'lifecycle_changed' ? '管理状態を変更' : item.action === 'dependencies_read' ? '依存情報を読み取り' : item.action === 'git_read' ? 'Git情報を読み取り' : item.action === 'vulnerabilities_checked' ? '脆弱性を照会' : item.action === 'purpose_filled' ? '用途を自動入力' : item.action === 'exposure_changed' ? '公開状況を変更' : '情報を編集'}</span><time className="whitespace-nowrap text-muted-foreground" dateTime={item.createdAt}>{date(item.createdAt)}</time></li>)}</ul> : <p className="text-muted-foreground">履歴を読み込んでいます。</p>}</section>
      </aside>
    </div>
  </>;
}
