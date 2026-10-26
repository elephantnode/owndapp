import { usePlatform } from './PlatformContext';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function FolderPathDialog({ target, close, submit }: { target: 'scan' | 'exclude'; close: () => void; submit: (path: string) => Promise<string | null> }) {
  const { platform } = usePlatform();
  const id = useId(); const [path, setPath] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !path.trim()) return;
    setBusy(true); setError('');
    try { const error = await submit(path.trim()); if (error) setError(error); else close(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent><DialogHeader><DialogTitle>{target === 'scan' ? '探索フォルダをパスで追加' : '除外フォルダをパスで追加'}</DialogTitle>
      <DialogDescription>{target === 'scan' ? '登録すると、このフォルダの探索を始めます。' : 'このフォルダと配下のフォルダを、今後の探索から除外します。登録済みのアプリは残ります。'}</DialogDescription></DialogHeader>
      <form onSubmit={save}>
        <Label htmlFor={id}>フォルダのパス</Label>
        <Input id={id} className="mt-2" value={path} onChange={e => { setPath(e.target.value); setError(''); }} required maxLength={4096} disabled={busy}
          placeholder={platform === 'win32' ? 'C:\\Users\\名前\\Projects' : '/Users/名前/Projects'} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} />
        <p id={`${id}-hint`} className="mt-2 text-caption text-muted-foreground">{platform === 'win32' ? 'C:\\Users\\名前\\Projects のようなドライブからの絶対パス、または ~\\Projects を入力します。' : '絶対パス、または ~/Projects のように入力します。'}スペースを含むパスもそのまま貼り付けられます。</p>
        {error && <p id={`${id}-error`} role="alert" className="mt-3 text-xs text-error">{error}</p>}
        <DialogFooter className="mt-6"><Button type="button" variant="ghost" disabled={busy} onClick={close}>キャンセル</Button>
          <Button type="submit" disabled={busy || !path.trim()}>{busy ? '確認中…' : target === 'scan' ? '追加して探索' : '除外フォルダを追加'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
