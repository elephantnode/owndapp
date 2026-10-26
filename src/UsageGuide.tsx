import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const wrap = '[overflow-wrap:anywhere]';

const steps: { title: string; body: ReactNode }[] = [
  { title: 'インストールする', body: <>この画面が見えていれば、インストールと起動は済んでいます。入れ直しや更新の手順は下の「インストールと更新」にあります。</> },
  { title: 'フォルダを追加する', body: <>「アプリを追加」で、作ったアプリが入っている親フォルダを指定します。中を探して候補を並べます。読み取りはこの端末の中だけで、外部には送りません。探したくないフォルダは除外できます。</> },
  { title: 'アプリを選んで登録する', body: <>候補から管理したいものを選んで登録します。用途・タグ・管理状態の入力は任意で、あとからでも入れられます。</> },
  { title: 'パッケージをチェックする', body: <>登録したアプリの依存パッケージを、既知の脆弱性のデータベース（OSV）に照会します。照会の前に、送信先と送る件数を確認する画面が出ます。送るのはパッケージの種類・名前・版だけで、パスやソースは送りません。</> },
  { title: '重大なものから対応して、もう一度チェックする', body: <>「脆弱性と対応」で、優先度の高いものから進めます。対策メモで更新先の版や確認の手順をまとめ、エディタで開いて更新します。更新したら再チェックし、検出されなくなったものが完了になります。手で完了にはできません。<span className="mt-1 block">owndappは自動で更新しません。<code>npm audit fix --force</code> のような一括の修正は、互換性を壊すことがあるため勧めていません。パッケージごとに確認して進めます。</span></> },
  { title: 'アーカイブ・カタログから外す・除外を使い分ける', body: <ul className="m-0 mt-1 list-disc space-y-1 pl-5">
    <li><span className="font-semibold text-foreground">アーカイブ</span>：登録したまま、通常の一覧とまとめてのチェックから外します。記録は残り、いつでも戻せます。</li>
    <li><span className="font-semibold text-foreground">カタログから外す</span>：フォルダが見つからない・除外フォルダにあるアプリを登録から外します。用途・メモ・履歴は記録に残ります。使うときは「アプリを追加」から登録し直します。</li>
    <li><span className="font-semibold text-foreground">除外フォルダ</span>：以後の探索でそのフォルダを読みません。除外しただけでは、登録済みのアプリは登録から外れません。登録済みアプリから除外するときは、カタログからも外すかを選べます。外さなかったものは「除外フォルダにあります」と表示されます。</li>
    <li>どれを使っても、ソースのフォルダやファイルは移動・削除しません。</li>
  </ul> },
];

function Commands({ children }: { children: string }) {
  return <pre className={cn('my-2 overflow-x-auto rounded-md border bg-sunken px-3 py-2 text-caption leading-relaxed', wrap)}><code>{children}</code></pre>;
}

// 設定・使い方: the beginner path in six steps, with installation and updates folded away for when they are needed.
export function UsageGuide() {
  return <section aria-labelledby="usage-guide-title" className="max-w-[720px]">
    <h2 id="usage-guide-title" className="text-base font-semibold">使い方</h2>
    <p className="mt-1 mb-4 text-caption text-muted-foreground">はじめての方は、この順に進めてください。</p>
    <ol className="m-0 list-none border-t p-0">
      {steps.map((step, i) => <li key={step.title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 border-b py-3">
        <span aria-hidden className="text-sm font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
        <div className="min-w-0"><h3 className="text-sm font-semibold">{step.title}</h3>
          <div className={cn('mt-0.5 text-caption text-muted-foreground', wrap)}>{step.body}</div></div>
      </li>)}
    </ol>

    <details className="mt-6 rounded-md border px-4 py-3 max-md:px-3">
      <summary className="text-sm font-semibold">インストールと更新</summary>
      <div className={cn('mt-3 text-caption text-muted-foreground', wrap)}>
        <p>macOS、またはWindowsのパス入力による利用に対応します（Windows実機は未検証）。Node.js 24.14.0以降が必要です。owndappのフォルダで、1行ずつ実行して結果を確かめてから次へ進みます。</p>
        <h3 className="mt-4 text-xs font-semibold text-foreground">はじめて入れる</h3>
        <Commands>{`npm run doctor
npm audit --package-lock-only --audit-level=high
npm ci --ignore-scripts --include=dev
npm audit signatures
npm run build
npm start`}</Commands>
        <p>初回の <code>npm run doctor</code> は、依存とビルド結果がまだないため要対応を2件出して終わります。それ以外の指摘（Node.jsの版など）は先に直します。依存の検査で重大な指摘や失敗が残るときは、先へ進みません。検査は安全の保証ではありません。<code>--omit=dev</code> は使いません（起動に必要です）。</p>
        <p className="mt-2">起動したら、ブラウザで <code>http://127.0.0.1:4310</code> を開きます。2回目からは <code>npm start</code> だけです。止めるときは、起動したターミナルで <kbd>Ctrl</kbd>+<kbd>C</kbd> を押します。</p>
        <h3 className="mt-4 text-xs font-semibold text-foreground">更新する</h3>
        <ol className="m-0 mt-1 list-decimal space-y-1 pl-5">
          <li>サーバーを止め、データの保存先（既定は <code>.owndapp</code>）全体をバックアップします。</li>
          <li>配布元はまだ決まっていません。Gitで追跡先が設定されている場合だけ、更新を取り込みます。手元の変更は捨てずに扱いを決めます。</li>
          <li><code>package-lock.json</code> が変わっていれば、上と同じ順で検査してから <code>npm ci --ignore-scripts --include=dev</code> を実行します。</li>
          <li><code>npm run build</code>、<code>npm run doctor</code>、<code>npm start</code> の順に実行し、登録したアプリや対応の記録が残っていることを確認します。</li>
        </ol>
        <p className="mt-2">詳しい手順と元に戻す方法は、owndappのフォルダにある <code>docs/operations.md</code> にあります。</p>
      </div>
    </details>
  </section>;
}
