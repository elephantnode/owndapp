import { useId, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, RefreshCw } from 'lucide-react';
import type { DependencyStatus, Project } from '../shared/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

type Filter = 'unconfirmed' | 'unread' | 'unsupported' | 'problem' | 'no-lock' | 'all';
const filterLabels: Record<Filter, string> = {
  unconfirmed: '未確認のすべて', unread: '未読', unsupported: '未対応形式あり', problem: '読み取りの問題（一部・失敗）', 'no-lock': 'lockなし', all: 'すべて',
};
const statusLabels: Record<DependencyStatus, string> = { complete: '読み取り済み', partial: '一部を読み取れません', failed: '読み取れません', 'no-lock': 'lockなし' };
const pageSize = 25;

const unsupported = (p: Project) => (p.dependencyUnsupported ?? 0) > 0;
const problem = (p: Project) => p.dependencyStatus === 'partial' || p.dependencyStatus === 'failed';
// complete only means one lock was read, so a project with unsupported files is still unconfirmed.
const matches: Record<Filter, (p: Project) => boolean> = {
  unconfirmed: p => p.dependencyStatus !== 'complete' || unsupported(p),
  unread: p => !p.dependencyStatus,
  unsupported,
  problem,
  'no-lock': p => p.dependencyStatus === 'no-lock',
  all: () => true,
};
const readable = (p: Project) => !p.missing && !p.excluded;
const date = (value: string) => new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const wrap = '[overflow-wrap:anywhere]';

// Finds apps the dependency search cannot see yet and reads only the chosen ones again, on this Mac.
export function DependencyCoverage({ projects, reading, onRead }: { projects: Project[]; reading: boolean; onRead: (ids: string[]) => Promise<{ summary: string }> }) {
  const id = useId();
  const [filter, setFilter] = useState<Filter>('unconfirmed');
  const [archived, setArchived] = useState(false);
  const [text, setText] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const locked = busy || reading;

  const scope = archived ? projects : projects.filter(p => p.lifecycle !== 'archived');
  const counts = { unread: scope.filter(matches.unread).length, unsupported: scope.filter(unsupported).length, problem: scope.filter(problem).length, noLock: scope.filter(matches['no-lock']).length };
  const query = text.trim().toLowerCase();
  const rows = scope.filter(p => matches[filter](p) && (!query || p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = rows.slice(current * pageSize, (current + 1) * pageSize);
  const pageIds = visible.filter(readable).map(p => p.id);
  // Only ids still on this page and readable count; selections of projects that moved, vanished, or became excluded are dropped.
  const chosen = pageIds.filter(projectId => selected.has(projectId));
  const allState = chosen.length && chosen.length === pageIds.length ? true : chosen.length ? 'indeterminate' : false;

  function reset() { setSelected(new Set()); setError(''); setMessage(''); }
  function toggle(projectId: string, on: boolean) {
    setSelected(previous => { const next = new Set(previous); if (on) next.add(projectId); else next.delete(projectId); return next; });
  }
  async function read() {
    if (running.current || reading || !chosen.length) return;
    running.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const { summary } = await onRead(chosen);
      setSelected(new Set()); setMessage(summary);
    } catch (e) { setError((e as Error).message || '依存を読み取れませんでした'); }
    finally { running.current = false; setBusy(false); }
  }

  const scopeText = archived ? 'アーカイブを含む' : 'アーカイブを除く';
  return <section aria-label="依存の検索範囲" className="mb-8 border-y py-5">
    <h2 className="mb-1 text-sm font-semibold">依存の検索範囲</h2>
    <p className="text-caption text-muted-foreground tabular-nums">
      {scopeText}登録 {scope.length.toLocaleString()}件のうち、未読 {counts.unread.toLocaleString()}件、未対応形式あり {counts.unsupported.toLocaleString()}件、一部/読取失敗 {counts.problem.toLocaleString()}件、lockなし {counts.noLock.toLocaleString()}件。1件のアプリが複数に数えられることがあります。これらのアプリの依存は、検索結果に含まれないか一部だけです。
    </p>
    <details className="mt-3 text-caption">
      <summary className="min-h-8 py-1.5">検索対象外・未確認のアプリを確認</summary>
      <div className="mt-3">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex w-[240px] flex-col gap-2 max-md:w-full"><Label htmlFor={`${id}-filter`}>読み取り状態</Label>
            <NativeSelect id={`${id}-filter`} containerClassName="w-full" value={filter} disabled={locked} onChange={e => { setFilter(e.target.value as Filter); setPage(0); reset(); }}>
              {(Object.keys(filterLabels) as Filter[]).map(key => <NativeSelectOption key={key} value={key}>{filterLabels[key]}</NativeSelectOption>)}
            </NativeSelect></div>
          <div className="flex min-w-[220px] flex-1 flex-col gap-2 max-md:min-w-0 max-md:w-full"><Label htmlFor={`${id}-text`}>アプリ名・パスで絞り込み</Label>
            <Input id={`${id}-text`} value={text} disabled={locked} onChange={e => { setText(e.target.value); setPage(0); reset(); }} autoComplete="off" spellCheck={false} /></div>
          <div className="flex min-h-10 items-center gap-2 max-md:min-h-11"><Checkbox id={`${id}-archived`} checked={archived} disabled={locked} onCheckedChange={on => { setArchived(on === true); setPage(0); reset(); }} />
            <Label htmlFor={`${id}-archived`} className="text-xs">アーカイブも含める</Label></div>
        </div>
        <p className="mb-4 text-muted-foreground">名前・パスは大文字・小文字を区別しません。絞り込みやページを変えると、選択は解除されます。フォルダが見つからないアプリと除外フォルダ内のアプリは選べません。</p>

        {!scope.length ? <Empty title={projects.length ? 'アーカイブ以外の登録はありません' : '登録したアプリはありません'}>
          {projects.length ? '「アーカイブも含める」を選ぶと、アーカイブしたアプリを表示します。' : 'アプリを登録すると、ここで依存の読み取り状態を確認できます。'}
        </Empty> : !rows.length ? filter === 'unconfirmed' && !query ? <Empty title="未確認のアプリはありません">
          {scopeText}登録 {scope.length.toLocaleString()}件は、記録上はすべて読み取り済みです。新たな依存や未対応形式、脆弱性の有無は別途確認してください。
        </Empty> : <Empty title="条件に一致するアプリはありません">
          読み取り状態や絞り込みの文字を変えてください。{archived ? '' : 'アーカイブしたアプリは「アーカイブも含める」で表示します。'}
        </Empty> : <>
          <Table className="max-md:block">
            <TableHeader className="max-md:block"><TableRow className="border-0 max-md:flex">
              <TableHead className="w-11 max-md:flex max-md:w-full max-md:items-center max-md:gap-3 max-md:px-3">
                <Checkbox aria-label="表示中の読み取り可能なアプリをすべて選択" checked={allState} disabled={locked || !pageIds.length} onCheckedChange={on => setSelected(on === true ? new Set(pageIds) : new Set())} />
                <span aria-hidden="true" className="md:hidden">このページの読み取り可能なアプリをすべて選択</span>
              </TableHead>
              <TableHead className="max-md:hidden">アプリ</TableHead><TableHead className="max-md:hidden">読み取り状態</TableHead><TableHead className="max-md:hidden">最終読み取り</TableHead>
            </TableRow></TableHeader>
            <TableBody className="max-md:block">{visible.map(project => {
              const can = readable(project);
              return <TableRow key={project.id} data-state={can && selected.has(project.id) ? 'selected' : undefined} className="max-md:grid max-md:grid-cols-[2.75rem_minmax(0,1fr)] max-md:py-3">
                <TableCell className="w-11 py-4 align-top max-md:row-span-3 max-md:w-auto max-md:px-3 max-md:py-1">
                  <Checkbox aria-label={`${project.name}の依存を読み取る対象に選択`} checked={can && selected.has(project.id)} disabled={locked || !can} onCheckedChange={on => toggle(project.id, on === true)} />
                </TableCell>
                <TableCell className="py-4 align-top max-md:col-start-2 max-md:px-0 max-md:py-1 max-md:pr-3">
                  <a className={cn('text-sm font-semibold text-foreground no-underline', wrap)} href={`#project/${project.id}`}>{project.name}</a>
                  {project.lifecycle === 'archived' && <Badge variant="outline" className="ml-2 align-middle">アーカイブ</Badge>}
                  <code className={cn('mt-1 block text-caption text-muted-foreground', wrap)}>{project.path}</code>
                  {!can && <span className="mt-1 block text-micro text-warning">{project.missing ? 'フォルダが見つからないため読み取れません' : '除外フォルダ内のため読み取りません'}</span>}
                </TableCell>
                <TableCell className="py-4 align-top max-md:col-start-2 max-md:px-0 max-md:py-1 max-md:pr-3">
                  <span className={cn('block', project.dependencyStatus !== 'complete' && 'text-warning')}>{project.dependencyStatus ? statusLabels[project.dependencyStatus] : '未読'}</span>
                  {unsupported(project) && <span className="mt-1 block text-micro text-warning tabular-nums">未対応形式 {project.dependencyUnsupported}件</span>}
                </TableCell>
                <TableCell className="py-4 align-top text-muted-foreground max-md:col-start-2 max-md:px-0 max-md:py-1 max-md:pr-3">
                  <span className="md:hidden">最終読み取り </span>
                  {project.dependenciesReadAt ? <time className="whitespace-nowrap" dateTime={project.dependenciesReadAt}>{date(project.dependenciesReadAt)}</time> : '未読'}
                </TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-muted-foreground tabular-nums">
            <span>{(current * pageSize + 1).toLocaleString()}–{(current * pageSize + visible.length).toLocaleString()}件目 / {rows.length.toLocaleString()}件</span>
            {pages > 1 && <div className="flex gap-2">
              <Button size="sm" disabled={locked || current === 0} onClick={() => { setPage(current - 1); reset(); }}><ChevronLeft size={14} />前へ</Button>
              <Button size="sm" disabled={locked || current >= pages - 1} onClick={() => { setPage(current + 1); reset(); }}>次へ<ChevronRight size={14} /></Button>
            </div>}
          </div>
        </>}

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button variant="default" disabled={!chosen.length || locked} onClick={() => void read()} className="max-md:w-full">
            <RefreshCw size={14} />{busy ? '読み取り中…' : `選択した${chosen.length.toLocaleString()}件の依存を読み取る`}
          </Button>
          {reading && !busy && <span className="text-muted-foreground">ほかの読み取りが終わるまで待っています。</span>}
        </div>
        <p className="mt-2 text-muted-foreground">選んだアプリのlockファイルを、この端末の中で読み直します。インストール・スクリプトの実行・設定の変更・外部への送信はしません。未対応形式は、読み直しても解析できないことがあります。</p>
        {error && <Alert variant="destructive" className="mt-3"><CircleAlert size={18} /><AlertDescription>{error}<span className="mt-1 block">選択はそのままです。もう一度読み取れます。</span></AlertDescription></Alert>}
        <p role="status" className={cn('text-success', message && 'mt-3')}>{message}</p>
      </div>
    </details>
  </section>;
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="border-y px-4 py-10 text-center">
    <h3 className="mb-2 text-sm font-semibold">{title}</h3>
    <p className="text-muted-foreground">{children}</p>
  </div>;
}
