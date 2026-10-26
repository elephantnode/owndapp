import { useEffect, useId, useState, type FormEvent } from 'react';
import { request } from './api';
import { projectResponseSummary } from '../shared/project-response';
import { responseLabels, type Advisory, type Dependency, type Project, type QueueItem, type ResponseStatus } from '../shared/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

const labels = { ...responseLabels, investigating: '対応中（調査中）', fixing: '対応中', 'awaiting-recheck': '確認待ち', resolved: '完了', none: '検出なし（照会済みの範囲）', review: '再チェックが必要' };
type Context = { status?: string; stale?: boolean; checkedAt?: string };
type Wire = { advisories: Record<string, Advisory>; projects: Record<string, Context>;
  items: (Omit<QueueItem, 'advisory' | 'dependencies'> & { advisoryId: string; advisoryKey?: string; dependencies: Omit<Dependency, 'source'>[] })[] };
async function load(projectId: string) {
  const wire = await request<Wire>(`/queue?project=${encodeURIComponent(projectId)}`);
  return { context: wire.projects[projectId], items: wire.items.map(({ advisoryId, advisoryKey, ...item }): QueueItem => {
    const advisory = wire.advisories[advisoryKey ?? advisoryId];
    if (!advisory) throw new Error('対応状況の形式を読み取れません');
    return { ...item, advisory, dependencies: item.dependencies.map(dependency => ({ ...dependency, source: 'unknown' })) };
  }) };
}

export function ProjectResponsePanel({ project, refreshKey, recheck }: { project: Project; refreshKey: string; recheck: () => void }) {
  const id = useId();
  const [data, setData] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true; setData(null); setError(''); setNotice('');
    void load(project.id).then(result => { if (active) setData(result); }, reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [project.id, refreshKey, retry]);
  const summary = data ? projectResponseSummary(data.items, data.context) : null;
  const status = summary ? data?.context ? labels[summary.status] : '未照会' : null;
  return <section aria-labelledby={`${id}-heading`} className="mb-8 border-y py-5 text-xs [overflow-wrap:anywhere]">
    <h2 id={`${id}-heading`} className="mb-3 text-sm font-semibold">プロジェクト全体の対応状況</h2>
    {!data && !error && <p role="status" className="text-muted-foreground">対応状況を読み込み中…</p>}
    {error && <div role="alert" className="text-error"><p>対応状況を取得できませんでした: {error}</p><Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setRetry(value => value + 1)}>対応状況を再取得</Button></div>}
    {summary && <>
      <p className="mb-2 text-sm font-semibold">対応状況: {status}</p>
      <ul aria-label="対応の内訳" className="mb-3 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-caption text-muted-foreground tabular-nums">
        {(Object.keys(responseLabels) as ResponseStatus[]).filter(key => summary.counts[key] > 0).map(key => <li key={key}>{labels[key]} {summary.counts[key]}件</li>)}
      </ul>
      <p className="mb-3 text-caption text-muted-foreground">プロジェクト内の記録から全体の進捗を表示します。未対応が残る場合は未対応です。完了は全件の解消を再チェックで確認した場合に付きます。</p>
      {(data?.context?.status === 'partial' || data?.context?.stale) && <p className="mb-3 text-caption text-warning">照会が不完全、または依存が変わっています。再チェックして確認してください。</p>}
      {summary.current.length > 0 && <Button type="button" size="sm" variant="outline" onClick={() => setChanging(true)}>プロジェクトの対応状況を変更</Button>}
      {(!data?.context || summary.status === 'review') && <Button type="button" size="sm" variant="outline" onClick={recheck}>脆弱性をチェック</Button>}
      <p className="mt-3 text-caption text-muted-foreground">個別の対応記録は保持されます。対象外への変更時は、このプロジェクトに共通する根拠が必要です。</p>
    </>}
    {notice && <p role="status" className="mt-3 text-caption text-success">{notice}</p>}
    {changing && summary && <ProjectResponseDialog project={project} items={summary.current} initialStatus={summary.status} close={() => setChanging(false)} done={async status => {
      setChanging(false); setData(null);
      try { setData(await load(project.id)); setError(''); setNotice(`プロジェクトの対応状況を「${labels[status]}」にしました`); }
      catch (reason) { setError(`変更は保存しましたが、表示を更新できませんでした。${(reason as Error).message}`); }
    }} />}
  </section>;
}

function ProjectResponseDialog({ project, items, initialStatus, close, done }: { project: Project; items: QueueItem[]; initialStatus: ReturnType<typeof projectResponseSummary>['status']; close: () => void; done: (status: ResponseStatus) => Promise<void> }) {
  const id = useId();
  const [status, setStatus] = useState<ResponseStatus | ''>(initialStatus === 'none' || initialStatus === 'review' || initialStatus === 'resolved' ? '' : initialStatus);
  const sameNote = items.every(item => item.note === items[0]?.note);
  const sameDate = items.every(item => item.reviewBy === items[0]?.reviewBy);
  const [note, setNote] = useState(initialStatus === 'not-applicable' && sameNote ? items[0]?.note ?? '' : '');
  const [reviewBy, setReviewBy] = useState(initialStatus === 'not-applicable' && sameDate ? items[0]?.reviewBy ?? '' : '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!status) { setError('対応状況を選んでください'); return; }
    if (status === 'not-applicable' && !note.trim()) { setError('プロジェクト全体を対象外にする根拠を入力してください'); return; }
    setBusy(true);
    try {
      await request(`/projects/${encodeURIComponent(project.id)}/response`, { ids: items.map(item => item.advisory.id), status,
        ...(status === 'not-applicable' ? { note, reviewBy: reviewBy || null } : {}) });
      await done(status);
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent>
    <DialogHeader><DialogTitle>プロジェクトの対応状況を変更</DialogTitle><DialogDescription>{project.name} の解消確認済みを除く{items.length}件をまとめて変更します。通常の変更では個別メモを保持します。「完了」は再チェックでのみ付きます。</DialogDescription></DialogHeader>
    <form onSubmit={submit}>
      <Label htmlFor={id}>対応状況</Label><NativeSelect id={id} containerClassName="mt-2 mb-4 w-full" disabled={busy} value={status} onChange={event => setStatus(event.target.value as ResponseStatus)}>
        <NativeSelectOption value="" disabled>選んでください</NativeSelectOption>
        {(Object.keys(responseLabels) as ResponseStatus[]).filter(key => key !== 'resolved').map(key => <NativeSelectOption key={key} value={key}>{labels[key]}</NativeSelectOption>)}
      </NativeSelect>
      {status === 'not-applicable' && <>
        <Label htmlFor={`${id}-note`}>プロジェクト全体を対象外にする根拠</Label><Textarea id={`${id}-note`} className="mt-2 mb-2" rows={3} maxLength={2000} disabled={busy} value={note} onChange={event => setNote(event.target.value)} />
        <p className="mb-4 text-caption text-muted-foreground">共通の根拠で個別メモを置き換えます。これまでの対応履歴は保持します。</p>
        <Label htmlFor={`${id}-date`}>見直す日（任意）</Label><Input id={`${id}-date`} className="mt-2 mb-4" type="date" disabled={busy} value={reviewBy} onChange={event => setReviewBy(event.target.value)} />
      </>}
      {error && <p role="alert" className="mb-4 text-caption text-error">{error}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={close}>キャンセル</Button><Button disabled={busy}>{busy ? '変更中…' : 'プロジェクト全体を変更'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
