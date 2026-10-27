import { OpenAppSettings } from './OpenAppSettings';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, CircleAlert, FolderSearch, LayoutList, RefreshCw, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { request } from './api';
import { severityRank } from '../shared/priority';
import type { OpenApps, Priority, Project, ResponseStatus, Scan, Severity } from '../shared/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const checkLimit = 1000;
const wrap = '[overflow-wrap:anywhere]';
const severityLabels: Record<Severity, string> = { malicious: '悪意のあるパッケージ', critical: '緊急', high: '高', moderate: '中', low: '低', unknown: '重大度不明' };
const severityTone = (severity: Severity) => severity === 'malicious' || severity === 'critical' || severity === 'high' ? 'text-error' : severity === 'moderate' || severity === 'unknown' ? 'text-warning' : 'text-dim';
// Not finished yet. not-applicable and resolved are decisions already made, so they are not counted as work.
const actionable = new Set<ResponseStatus>(['open', 'investigating', 'fixing', 'awaiting-recheck']);

// Only the fields the summary reads. Advisories are sent once and items refer to them by key (older servers: by id).
type QueueWire = { advisories: Record<string, { severity?: Severity } | undefined>;
  items: { projectId: string; advisoryId: string; advisoryKey?: string; status: ResponseStatus; priority: Priority }[] };
type Work = { projectId: string; severity: Severity; priority: Priority };
function decodeWork(wire: QueueWire): Work[] {
  if (!wire || !Array.isArray(wire.items) || (!wire.advisories || typeof wire.advisories !== 'object' || Array.isArray(wire.advisories))) throw new Error('対応状況の形式を読み取れません');
  return wire.items.filter(item => actionable.has(item.status)).map(item => ({ projectId: item.projectId, priority: item.priority,
    severity: wire.advisories[item.advisoryKey ?? item.advisoryId]?.severity ?? 'unknown' }));
}
const highest = (list: Work[]) => list.reduce<Severity>((top, w) => severityRank[w.severity] > severityRank[top] ? w.severity : top, 'unknown');

const steps: { title: string; text: string }[] = [
  { title: 'フォルダから探す', text: '作ったアプリが入っている親フォルダを指定すると、中を探して候補を並べます。' },
  { title: '選んで登録する', text: '候補から管理したいアプリを選んで登録します。' },
  { title: 'チェックする', text: '使っているパッケージに既知の脆弱性がないかを調べます。送る内容は照会の前に確認できます。' },
  { title: '対応する', text: '重大なものから、対策メモやエディタで更新を進めます。' },
  { title: 'もう一度チェックする', text: '更新後に再チェックし、検出されなくなったら完了になります。' },
];

// ホーム: where to start, and what to do next. The work itself stays on the existing screens; this only counts and points to them.
export function HomeView({ apps, appsChanged, projects, initialScan, toDiscover, toCatalog, toAttention, toSettings, check }: {
  apps: OpenApps; appsChanged: (apps: OpenApps) => void; projects: Project[]; initialScan?: Scan; toDiscover: () => void; toCatalog: () => void; toAttention: () => void; toSettings: () => void;
  check: (ids: string[], label?: string) => void }) {
  const registered = projects.length > 0;
  const [work, setWork] = useState<Work[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // Read again when projects change, keeping the last result on screen while it loads. A failure is never shown as "nothing to do".
  useEffect(() => {
    if (!registered) return;
    let alive = true;
    request<QueueWire>('/queue').then(decodeWork).then(result => { if (alive) { setWork(result); setError(''); } },
      e => { if (alive) { setWork(null); setError((e as Error).message); } });
    return () => { alive = false; };
  }, [registered, projects, attempt]);

  const scanAction = <ScanAction scan={initialScan} open={toDiscover} showResults={!registered} />;

  if (!registered) return <>
    <header className="mb-8 max-md:mb-6">
      <p className="mb-2 text-xs text-muted-foreground max-md:text-caption">ホーム</p>
      <h1 className="mb-2 text-title leading-[1.35] font-[650] tracking-[-.035em] max-lg:text-[25px] max-md:text-2xl">最初のアプリを登録しましょう</h1>
      <p className="max-w-[640px] text-[13px] text-dim">この端末にある自分のアプリを集めて、使っているパッケージの既知の脆弱性を確認し、対応を記録します。</p>
    </header>
    {scanAction}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <Button variant="default" onClick={toDiscover}><FolderSearch size={17} />フォルダからアプリを探す<ArrowRight size={16} /></Button>
      <Button variant="link" size="sm" className="px-0" onClick={toSettings}>使い方を詳しく見る</Button>
    </div>
    <p className="mt-4 max-w-[640px] text-caption text-muted-foreground">用途やタグの入力は任意です。入れなくても登録・チェック・対応まで進められます。ソースの移動・削除や自動更新はしません。</p>
    <div className="my-6"><OpenAppSettings apps={apps} changed={appsChanged} initialSetup /></div>
    <ol className="m-0 mb-6 max-w-[640px] list-none border-t p-0">
      {steps.map((step, i) => <li key={step.title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 border-b py-3">
        <span aria-hidden className="text-sm font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
        <div><p className="text-sm font-semibold">{step.title}</p><p className="mt-0.5 text-caption text-muted-foreground">{step.text}</p></div>
      </li>)}
    </ol>

  </>;

  const active = projects.filter(p => p.lifecycle !== 'archived');
  // Missing folders and folders under an exclusion are left to the user; they are not picked for a check automatically.
  const eligible = active.filter(p => !p.missing && !p.excluded);
  const skipped = active.length - eligible.length;
  const undecidable = eligible.filter(p => p.dependencyStatus === 'no-lock' || p.dependencyStatus === 'failed');
  const checkable = eligible.filter(p => !undecidable.includes(p));
  const unchecked = checkable.filter(p => !p.vulnerabilities);
  const outdated = checkable.filter(p => p.vulnerabilities && (p.vulnerabilities.stale || p.vulnerabilities.status === 'partial' || p.dependencyStatus === 'partial'));
  const targets = [...unchecked, ...[...outdated].sort((a, b) => a.vulnerabilities!.checkedAt.localeCompare(b.vulnerabilities!.checkedAt))];
  const selected = targets.slice(0, checkLimit).map(p => p.id);
  const withFindings = active.filter(p => p.vulnerabilities?.count).length;

  const activeIds = new Set(active.map(p => p.id));
  const open = (work ?? []).filter(w => activeIds.has(w.projectId));
  const urgent = open.filter(w => w.priority === 'high' || w.priority === 'review');
  const byProject = new Map<string, Work[]>();
  for (const w of urgent) byProject.set(w.projectId, [...(byProject.get(w.projectId) ?? []), w]);
  const names = new Map(projects.map(p => [p.id, p.name]));
  const topProjects = [...byProject].sort(([ia, a], [ib, b]) => severityRank[highest(b)] - severityRank[highest(a)] || b.length - a.length || (names.get(ia) ?? '').localeCompare(names.get(ib) ?? '')).slice(0, 3);
  const leadWithWork = urgent.length > 0;

  const workRow = error ? <Row icon={<CircleAlert size={18} className="text-error" />} title="対応状況を読み込めませんでした"
    text={<span role="alert">{error}。未完了の対応がないという意味ではありません。</span>}
    action={<Button size="sm" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={15} />もう一度読み込む</Button>} />
    : !work ? <Row icon={<ShieldQuestion size={18} className="text-muted-foreground" />} title="対応状況を読み込んでいます" text="読み込みが終わるまで、未完了の対応の有無はわかりません。" />
    : !open.length ? <Row icon={<ShieldQuestion size={18} className="text-muted-foreground" />} title="未完了の対応記録はありません"
      text={<>チェックで見つかったものだけが対象です。まだチェックしていない・結果が古いアプリの分は含みません。{withFindings > 0 && `既知の脆弱性が検出されたアプリは${withFindings}件あります（対象外にしたものを含む）。`}</>}
      action={<Button size="sm" onClick={toAttention}>脆弱性と対応を見る</Button>} />
    : <Row icon={<ShieldAlert size={18} className={leadWithWork ? 'text-error' : 'text-warning'} />}
      title={<>未完了の対応 <span className="tabular-nums">{open.length}件</span></>}
      text={<>
        <span className="block tabular-nums">最も重いもの: <span className={cn('font-semibold', severityTone(highest(open)))}>{severityLabels[highest(open)]}</span>
          {' · '}優先度 高 {open.filter(w => w.priority === 'high').length}件 · 要確認 {open.filter(w => w.priority === 'review').length}件 · ほか {open.length - urgent.length}件</span>
        {topProjects.length > 0 && <span className="mt-1 block">{topProjects.map(([id, list], i) => <span key={id}>{i > 0 && '、'}
          <a className={cn('font-semibold text-foreground', wrap)} href={`#project/${id}`}>{names.get(id) ?? id}</a>
          <span className="tabular-nums">（<span className={severityTone(highest(list))}>{severityLabels[highest(list)]}</span> {list.length}件）</span></span>)}
          {byProject.size > topProjects.length && <span className="tabular-nums"> ほか{byProject.size - topProjects.length}件のアプリ</span>}</span>}
      </>}
      action={<Button size="sm" variant={leadWithWork ? 'default' : 'outline'} onClick={toAttention}>{leadWithWork ? '重大なものから対応する' : '脆弱性と対応を開く'}<ArrowRight size={15} /></Button>} />;

  const checkRow = targets.length > 0 ? <Row icon={<ShieldAlert size={18} className="text-warning" />}
    title={<>チェックが必要なアプリ <span className="tabular-nums">{targets.length}件</span></>}
    text={<>
      <span className="block tabular-nums">まだチェックしていない {unchecked.length}件 · 結果が古い・一部のみ判定 {outdated.length}件</span>
      <span className="mt-0.5 block">確認が済むまでは、安全とも言えません。送る内容は照会の前に確認できます。{targets.length > checkLimit && `1回${checkLimit}件までのため、まだチェックしていないものから選びます（残り${targets.length - checkLimit}件は次の回に）。`}</span>
    </>}
    action={<Button size="sm" variant={leadWithWork || !work ? 'outline' : 'default'} onClick={() => check(selected, `未検査・要再確認の${selected.length}件`)}>
      <ShieldAlert size={15} />{selected.length}件をチェック</Button>} />
    : checkable.length > 0 ? <Row icon={<ShieldQuestion size={18} className="text-muted-foreground" />} title="チェック結果はすべて最新です"
      text="依存の内容が変わったら「結果が古い」として、ここに戻ってきます。既知の脆弱性がないという意味ではありません。" /> : null;

  return <>
    <header className="mb-8 max-md:mb-6">
      <p className="mb-2 text-xs text-muted-foreground max-md:text-caption">ホーム</p>
      <h1 className="mb-2 text-title leading-[1.35] font-[650] tracking-[-.035em] max-lg:text-[25px] max-md:text-2xl">次にやること</h1>
      <p className="max-w-[640px] text-[13px] text-dim">重大な対応、止まっているチェック、続きのある探索の順に並べています。</p>
    </header>
    {scanAction}
    <ul className="m-0 list-none border-t p-0" aria-label="次にやること">
      {leadWithWork ? <>{workRow}{checkRow}</> : <>{checkRow}{workRow}</>}
      {(undecidable.length > 0 || skipped > 0) && <Row icon={<CircleAlert size={18} className="text-muted-foreground" />} title="自動ではチェックしないアプリ"
        text={<span className="tabular-nums">
          {undecidable.length > 0 && <span className="block">判定できる依存がない・読み取り失敗 {undecidable.length}件（lockなし等。脆弱性なしとは判定していません）</span>}
          {skipped > 0 && <span className="block">フォルダが見つからない・除外フォルダにある {skipped}件</span>}
        </span>}
        action={<Button size="sm" onClick={toAttention}>確認する</Button>} />}
      <Row icon={<LayoutList size={18} className="text-muted-foreground" />} title={<>登録したアプリ <span className="tabular-nums">{projects.length}件</span></>}
        text={<span className="tabular-nums">アーカイブ以外 {active.length}件{projects.length > active.length && ` · アーカイブ ${projects.length - active.length}件`}。用途・タグの整理は任意です。</span>}
        action={<Button size="sm" onClick={toCatalog}>一覧を開く</Button>} />
    </ul>
    <p className="mt-6 text-caption text-muted-foreground">
      流れ: {steps.map(s => s.title).join(' → ')}。<Button variant="link" size="sm" className="h-auto min-h-0 px-1 text-caption max-md:min-h-0" onClick={toSettings}>使い方を見る</Button>
    </p>
  </>;
}

function Row({ icon, title, text, action }: { icon: ReactNode; title: ReactNode; text: ReactNode; action?: ReactNode }) {
  return <li className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b py-4">
    <span aria-hidden className="mt-0.5 shrink-0">{icon}</span>
    <div className="min-w-0 flex-1 basis-[240px]">
      <p className="text-sm font-semibold">{title}</p>
      <div className={cn('mt-1 text-caption text-muted-foreground', wrap)}>{text}</div>
    </div>
    {action && <div className="shrink-0 max-md:w-full max-md:pl-[30px]">{action}</div>}
  </li>;
}

// A scan that can still go on: running, paused, or stopped with folders to retry. Discovery owns resuming; this only points there.
function ScanAction({ scan, open, showResults }: { scan?: Scan; open: () => void; showResults?: boolean }) {
  if (!scan) return null;
  const running = scan.status === 'running';
  const paused = scan.status === 'paused' || (!!scan.canResume && !running);
  const retry = !running && !paused && !!scan.canRetry;
  const results = showResults && (scan.candidateCount ?? scan.candidates.length) > 0;
  if (!running && !paused && !retry && !results) return null;
  const title = running ? 'フォルダを探索しています' : scan.status === 'paused' ? '一時停止中の探索があります' : paused ? '途中で止まった探索があります' : retry ? '読み取れなかったフォルダがあります' : '検出した候補を確認できます';
  return <div role="status" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-raised px-4 py-3 text-xs text-dim">
    <FolderSearch size={16} className="shrink-0 text-brand" />
    <div className="min-w-0 flex-1 basis-[200px]"><p className="font-semibold text-foreground">{title}</p>
      <code className={cn('block text-micro text-muted-foreground', wrap)}>{scan.root}</code></div>
    <Button size="sm" onClick={open}>{running ? '進み具合を見る' : paused ? '続きから再開する' : '結果を確認する'}</Button>
  </div>;
}
