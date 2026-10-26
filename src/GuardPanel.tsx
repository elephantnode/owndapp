import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { GuardStatus } from '../shared/guard';
import { request } from './api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function GuardPanel({ projectId, className, headingClassName }: { projectId: string; className?: string; headingClassName?: string }) {
  const [status, setStatus] = useState<GuardStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState('');
  const endpoint = `/projects/${encodeURIComponent(projectId)}/guard`;
  async function inspect() {
    setBusy(true); setError('');
    try { setStatus(await request<GuardStatus>(endpoint)); }
    catch (e) { setError((e as Error).message); setStatus(undefined); }
    finally { setBusy(false); }
  }
  useEffect(() => { let active = true;
    request<GuardStatus>(endpoint).then(value => { if (active) setStatus(value); }, e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [endpoint]);
  async function apply() {
    if (!status) return;
    setBusy(true); setError('');
    try {
      const result = await request<GuardStatus & { backup?: string }>(endpoint, { revision: status.revision });
      setStatus(result); setConfirm(false);
      setSaved(result.backup ? `設定しました。元の設定は ${result.backup} に保存しました。` : '設定しました。');
    } catch (e) { setError((e as Error).message); setConfirm(false); setStatus(undefined); }
    finally { setBusy(false); }
  }
  return <section className={className} aria-label="Takumi Guardの設定">
    <h2 className={headingClassName}><ShieldCheck size={16} aria-hidden="true" />パッケージ取得の保護</h2>
    <p className="text-caption text-muted-foreground">Takumi Guardを経由して、悪意が検出されたnpmパッケージの取得を防ぎます。</p>
    <p className="mt-3 text-xs" aria-live="polite">{busy ? '設定を確認中…' : status ? `${status.state === 'configured' ? '設定済み：' : ''}${status.message}` : error ? '' : '設定を読み込んでいます…'}</p>
    {status?.warnings.length ? <ul className="mt-2 list-disc pl-4 text-caption text-muted-foreground">{status.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul> : null}
    {error && <p role="alert" className="mt-2 text-caption text-error">{error}</p>}
    {saved && <p aria-live="polite" className="mt-2 break-all text-caption">{saved}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {status?.state === 'available' && <Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>Guardを設定…</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={inspect}>設定を再確認</Button>
      <a className="inline-flex min-h-8 items-center text-caption underline" href="https://shisho.dev/docs/ja/t/guard/quickstart/npm/" target="_blank" rel="noreferrer">公式ガイド</a>
    </div>
    <p className="mt-2 text-caption text-muted-foreground">ここでは設定ファイルだけを確認します。通信経路や検知動作は未検証です。環境変数や実行時の指定で上書きされる場合があります。</p>
    <Dialog open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>このアプリにGuardを設定</DialogTitle><DialogDescription>直下の.npmrcに取得先を設定します。既存ファイルがある場合は元の内容を同じフォルダに保存します。</DialogDescription></DialogHeader>
        <code className="break-all rounded-md bg-muted p-3 text-xs">registry=https://npm.flatt.tech/</code>
        <p className="text-sm">今後のnpm・pnpmによる公開パッケージの取得で、パッケージ名や版などのリクエストがTakumi Guardに送られます。個別に指定された別の取得先は対象外です。</p>
        <p className="text-caption text-muted-foreground">匿名利用のため後日の通知はありません。脆弱性チェックとテストも続けてください。依存の更新・インストールは行いません。バックアップはGitに追加しないでください。</p>
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>キャンセル</Button><Button disabled={busy} onClick={apply}>{busy ? '設定中…' : 'この設定を適用'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
