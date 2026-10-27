import { useId, useRef, useState } from 'react';
import { Check, CircleAlert, SquareCode, SquareTerminal } from 'lucide-react';
import { request } from './api';
import { usePlatform } from './PlatformContext';
import { appRoleLabels, type AppRole, type OpenApps } from '../shared/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const appIcons: Record<AppRole, typeof SquareCode> = { editor: SquareCode, terminal: SquareTerminal };
const wrap = '[overflow-wrap:anywhere]';

// Shared by the first-run home and Settings. The parent owns apps; this only sends /apps/pick and /apps/clear and hands back the result.
export function OpenAppSettings({ apps, changed, initialSetup = false }: { apps: OpenApps; changed: (apps: OpenApps) => void; initialSetup?: boolean }) {
  const { externalApps, platform } = usePlatform();
  const id = useId();
  const [busy, setBusy] = useState<AppRole | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  // State updates land after the next render, so a quick double click could start two pickers; the ref blocks that synchronously.
  const running = useRef(false);
  const windows = platform === 'win32';

  async function change(role: AppRole, action: 'pick' | 'clear') {
    if (running.current) return;
    running.current = true; setBusy(role); setMessage(null);
    try {
      const data = await request<{ apps: OpenApps; cancelled?: boolean }>(`/apps/${action}`, { role });
      if (data.cancelled) return;
      changed(data.apps);
      const app = data.apps[role];
      setMessage({ text: action === 'clear' ? `${appRoleLabels[role]}の登録を解除しました` : `${appRoleLabels[role]}に${app?.name ?? 'アプリ'}を登録しました` });
    } catch (e) { setMessage({ text: (e as Error).message, error: true }); }
    finally { running.current = false; setBusy(null); }
  }

  if (!externalApps) return <p className="text-caption text-muted-foreground">このOSではエディタ・ターミナルの登録と起動は利用できません。必要なアプリから、プロジェクトのパスを指定して開いてください。</p>;

  return <section aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`} className="max-w-[720px]">
    <h2 id={`${id}-title`} className="mb-1 text-base font-semibold">作業用のエディタ・ターミナル</h2>
    <p id={`${id}-desc`} className="mb-4 text-xs text-muted-foreground">
      一覧と詳細の「○○で開く」で、プロジェクトのフォルダを登録したアプリで開きます。
      {initialSetup && <span className="mt-1 block">登録は任意で、登録時には起動しません。後から設定で変更でき、登録せずにフォルダ探索へ進めます。</span>}
    </p>
    {message && (message.error
      ? <Alert variant="destructive" className="mb-4"><CircleAlert size={18} /><AlertDescription>{message.text}</AlertDescription></Alert>
      : <Alert variant="success" role="status" className="mb-4"><Check size={18} /><AlertDescription>{message.text}</AlertDescription></Alert>)}
    <div className="border-t">{(Object.keys(appRoleLabels) as AppRole[]).map(role => {
      const app = apps[role]; const Icon = appIcons[role];
      return <div key={role} role="group" aria-label={appRoleLabels[role]} className="flex items-center gap-4 border-b py-5 max-md:flex-wrap max-md:gap-3">
        <Icon size={20} className="shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{appRoleLabels[role]}</p>
          {app ? <><p className={cn('mt-1 text-sm font-semibold', wrap)}>{app.name}</p><code className={cn('mt-0.5 block text-caption text-muted-foreground', wrap)}>{app.path}</code></>
            : <p className="mt-1 text-[13px] text-muted-foreground">未登録</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 max-md:w-full">
          {app && <Button size="sm" variant="ghost" className="text-dim" disabled={!!busy} onClick={() => void change(role, 'clear')}>登録を解除</Button>}
          <Button size="sm" variant={app ? 'outline' : 'default'} disabled={!!busy} onClick={() => void change(role, 'pick')}>{busy === role ? (windows ? '選択中…' : 'Finderで選択中…') : app ? '選び直す' : 'アプリを選ぶ'}</Button>
        </div>
      </div>;
    })}</div>
    <p className="mt-4 text-caption text-muted-foreground">{windows
      ? '対応するエディタ（Code.exe・Cursor.exeなど）、またはpowershell.exe・pwsh.exe・cmd.exe・wt.exeを選びます。Windows TerminalはPowerShellをプロファイルなしで開きます。アプリのファイルは変更しません。'
      : 'macOSのアプリ選択画面から選びます。開くときはFinderでフォルダをアプリのアイコンに重ねたときと同じ動きで、アプリのファイルは変更しません。'}</p>
  </section>;
}
