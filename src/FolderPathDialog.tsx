import { request } from './api';
import { usePlatform } from './PlatformContext';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function FolderPathDialog({ target, close, submit }: { target: 'scan' | 'exclude'; close: () => void; submit: (path: string) => Promise<string | null> }) {
  const { platform, folderPicker } = usePlatform();
  const id = useId(); const [path, setPath] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false); const running = useRef(false);
  const locked = busy || picking;
  async function browse() {
    if (running.current) return;
    running.current = true; setPicking(true); setError('');
    try {
      const chosen = await request<{ path: string | null }>('/folder-picker', { defaultPath: path.trim() || undefined, purpose: target === 'exclude' ? 'exclude' : 'scan' });
      if (chosen.path) setPath(chosen.path);
    } catch { setError('フォルダ選択画面を開けませんでした。パスを直接入力して追加できます。'); }
    finally { running.current = false; setPicking(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (running.current || !path.trim()) return;
    running.current = true;
    setBusy(true); setError('');
    try { const error = await submit(path.trim()); if (error) setError(error); else close(); }
    catch (e) { setError((e as Error).message); }
    finally { running.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !locked) close(); }}>
    <DialogContent><DialogHeader><DialogTitle>{target === 'scan' ? '探索フォルダをパスで追加' : '除外フォルダをパスで追加'}</DialogTitle>
      <DialogDescription>{target === 'scan' ? '登録すると、このフォルダの探索を始めます。' : 'このフォルダと配下のフォルダを、今後の探索から除外します。登録済みのアプリは残ります。'}</DialogDescription></DialogHeader>
      <form onSubmit={save}>
        <Label htmlFor={id}>フォルダのパス</Label>
        <div className="mt-2 flex items-start gap-2 max-sm:flex-col"><Input id={id} className="min-w-0 flex-1 max-sm:w-full" value={path} onChange={e => { setPath(e.target.value); setError(''); }} required maxLength={4096} disabled={locked}
          placeholder={platform === 'win32' ? 'C:\\Users\\名前\\Projects' : '/Users/名前/Projects'} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} />
          {folderPicker && <Button type="button" className="shrink-0 max-sm:w-full" disabled={locked} onClick={() => void browse()}>{picking ? '選択画面を開いています…' : 'フォルダを選択'}</Button>}</div>
        <p id={`${id}-hint`} className="mt-2 text-caption text-muted-foreground">{platform === 'win32' ? 'C:\\Users\\名前\\Projects のようなドライブからの絶対パス、または ~\\Projects を入力します。' : '絶対パス、または ~/Projects のように入力します。'}スペースを含むパスもそのまま貼り付けられます。</p>
        {error && <p id={`${id}-error`} role="alert" className="mt-3 text-xs text-error">{error}</p>}
        <DialogFooter className="mt-6"><Button type="button" variant="ghost" disabled={locked} onClick={close}>キャンセル</Button>
          <Button type="submit" disabled={locked || !path.trim()}>{busy ? '確認中…' : target === 'scan' ? '追加して探索' : '除外フォルダを追加'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
