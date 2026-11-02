import { useEffect, useState } from 'react';
import { Container, Plus, X } from 'lucide-react';
import type { Project } from '../shared/types';
import { request } from './api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

type Tools = { osvScanner: { path: string; version: string } | null; docker: { path: string; running: boolean } | null };
type ScannerState = { enabled: boolean; tools: Tools };
type DockerImage = { reference: string; id: string; size: string; created: string };

/** Settings: whether osv-scanner is used. Off until turned on; owndapp never installs it. */
export function ScannerSettings() {
  const [state, setState] = useState<ScannerState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { request<ScannerState>('/scanner').then(setState, e => setError(e.message)); }, []);
  async function toggle(enabled: boolean) {
    setBusy(true); setError('');
    try { setState(await request<ScannerState>('/scanner', { enabled }, false, 'PUT')); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const scanner = state?.tools.osvScanner; const docker = state?.tools.docker;
  return <section aria-labelledby="scanner-settings" className="mb-8 border-y py-5">
    <h2 id="scanner-settings" className="mb-2 text-sm font-semibold">osv-scanner（任意）</h2>
    <p className="mb-3 max-w-[720px] text-caption text-muted-foreground">owndappが読めない形式（Swift・Dart・.NET・Gradle・Bun・Elixirのlock）と、アプリに結び付けたDockerイメージを、この端末のosv-scannerで照会します。照会の前に確認画面を出します。</p>
    {!state ? <p className="text-caption text-muted-foreground">{error || '確認しています'}</p> : <>
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
        <dt className="text-muted-foreground">osv-scanner</dt><dd>{scanner ? <>バージョン {scanner.version}（<code>{scanner.path}</code>）</> : <>見つかりません。<code>brew install osv-scanner</code> などで導入すると使えます</>}</dd>
        <dt className="text-muted-foreground">Docker</dt><dd>{!docker ? '見つかりません（イメージのチェックは使えません）' : docker.running ? '起動中' : '起動していません（イメージのチェックには起動が必要です）'}</dd>
      </dl>
      <div className="flex items-center gap-2"><Checkbox id="scanner-enabled" checked={state.enabled} disabled={busy || (!scanner && !state.enabled)} onCheckedChange={checked => void toggle(checked === true)} />
        <Label htmlFor="scanner-enabled" className="cursor-pointer font-normal">osv-scannerを使う</Label></div>
    </>}
    {error && state && <p role="alert" className="mt-2 text-caption text-error">{error}</p>}
  </section>;
}

/** Detail: local docker images linked to the project. Chosen from docker image ls; nothing is pulled. */
export function ImagePanel({ project, reloadProjects, className, headingClassName }: { project: Project; reloadProjects: () => Promise<void>; className?: string; headingClassName?: string }) {
  const [images, setImages] = useState<DockerImage[] | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const linked = project.images ?? [];
  async function load() {
    setError('');
    try { setImages((await request<{ images: DockerImage[] }>('/docker/images')).images); } catch (e) { setError((e as Error).message); }
  }
  async function save(next: string[]) {
    setBusy(true); setError('');
    try { await request(`/projects/${encodeURIComponent(project.id)}/images`, { images: next }, false, 'PUT'); await reloadProjects(); setChoice(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  // Images named like the project come first, since they were most likely built from it.
  const name = project.name.toLowerCase().split('/').pop() ?? '';
  const options = (images ?? []).filter(i => !linked.includes(i.reference))
    .sort((a, b) => Number(b.reference.toLowerCase().includes(name)) - Number(a.reference.toLowerCase().includes(name)) || a.reference.localeCompare(b.reference));
  return <section aria-labelledby={`images-${project.id}`} className={className}>
    <h2 id={`images-${project.id}`} className={headingClassName}><Container size={15} />コンテナイメージ</h2>
    <p className="mb-3 text-caption text-muted-foreground">結び付けたイメージは、osv-scannerを使う設定のとき脆弱性チェックの対象になります。手元にあるイメージだけで、取得はしません。</p>
    {linked.length > 0 && <ul className="mb-3 grid gap-1">{linked.map(image => <li key={image} className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate" title={image}>{image}</code>
      <Button variant="ghost" size="icon" className="size-7" aria-label={`${image}を外す`} disabled={busy} onClick={() => void save(linked.filter(i => i !== image))}><X size={14} /></Button></li>)}</ul>}
    {images === null ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}><Plus size={14} />手元のイメージから選ぶ</Button>
      : <div className="flex flex-wrap items-center gap-2">
        <NativeSelect size="sm" aria-label="結び付けるイメージ" value={choice} onChange={e => setChoice(e.target.value)}>
          <NativeSelectOption value="">{options.length ? 'イメージを選ぶ' : '選べるイメージがありません'}</NativeSelectOption>
          {options.map(i => <NativeSelectOption key={i.reference} value={i.reference}>{i.reference}（{i.size}・{i.created}）</NativeSelectOption>)}
        </NativeSelect>
        <Button size="sm" disabled={busy || !choice} onClick={() => void save([...linked, choice])}>結び付ける</Button></div>}
    {error && <p role="alert" className="mt-2 text-caption text-error">{error}</p>}
  </section>;
}
