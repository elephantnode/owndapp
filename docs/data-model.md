# データモデルと処理境界のたたき台

更新日: 2026-10-19
状態: 設計案。DBスキーマ・API・型定義は未実装。

## データの単位

| 単位 | 責務・主要項目 |
| --- | --- |
| Project | 人が管理する単位。安定したID、名前、用途、説明、タグ、管理状態、編集版番号 |
| Component | Project内のアプリ・ライブラリ。名前、役割、基準ディレクトリからの相対パス。単体構成にも1件を持つ |
| SourceLocation | Projectのローカルコピー。実パス、探索範囲ID、Repositoryへの参照、確認状態 |
| Repository | ローカルのGit管理領域。共通Gitディレクトリ、関連候補の情報。Gitなしは参照なし |
| ScanRoot | 明示的な探索範囲。絶対パス、除外条件、上限 |
| DiscoveryRun / Candidate | 探索履歴と候補。範囲、検出根拠、親子関係、新規・登録済み・要確認 |
| ImportBatch | 一度の追加操作。操作ID、選択候補、登録Project一覧、結果。追加直後の絞り込みに利用 |
| Snapshot | あるSourceLocationで読んだ入力集合。対象ファイルの指紋、読取時点、パーサー版 |
| Observation | Snapshotに基づく構成情報。対象Component、情報種別、取得方法、根拠、日時 |
| DependencyRecord | 依存の検索用情報。ecosystem、名前、宣言値、具体的な版、種別、帰属、Snapshot |
| CheckRun | 検査ジョブ。対象、能力、進行状態、入力Snapshot、結果、エラー、開始・終了時刻 |
| Finding | 診断上の指摘。種別、重大度、対象、根拠、識別子、初回・最終検出日時 |
| Decision | 人の判断と対応履歴。FindingまたはProject、対応状態、理由、記録日 |

Projectの管理状態は `untriaged（未設定） / planning（計画中） / active（開発中） / testing（テスト・検証） / maintained（運用中） / on_hold（保留） / completed（完了） / cancelled（中止） / archived（アーカイブ）` とする（2026-10-20に計画中・開発中・完了・中止を追加し、表示名を見直した。既存の値は変更しない。2026-10-22にテスト・検証を追加した）。Findingへの対応状態とは別の列で保持する。

Projectは複数のSourceLocationとComponentを持てる。Componentの情報はSourceLocationごとに観測し、同じProjectの別チェックアウトの依存を混ぜない。Componentの相対パスがないコピーは欠落として扱う。

同じGit remoteだけでは同一Projectと確定しない。worktreeは共通Git領域を関連付けつつ、パス・ブランチ・変更・Snapshotは個別に持つ。

GitのないSourceLocationも登録可能。SourceLocationの実パスは一意とし、ProjectのIDや名前とは切り離す。パス移動は確認後に既存IDへ関連付け、勝手に過去データを削除しない。

## 情報の根拠と訂正

自動検出した名前・分類と手入力した名前・分類を別に持つ。表示は明示的な手入力を優先するが、元の観測値と根拠は詳細から参照できる。

Observationには少なくとも次を持つ。

- 対象: SourceLocationと、必要ならComponent。
- 値の種類: 宣言、lockの記録、静的な配置設定、将来の実環境観測など。
- 根拠: ScanRoot内の相対ファイル位置、フィールド位置、ファイル指紋。
- 取得条件: アダプターIDと版、確認日時、Snapshot。
- 確からしさ: 静的に確認できた事実、候補、動的指定、未対応。

根拠ファイルの全文、環境変数の値、認証付きURLはDB・ログ・APIへ保存しない。ローカルパスの表示に必要な情報と、診断に必要な許可フィールドだけを保持する。

## 状態を分ける

| 軸 | 値の案 | 用途 |
| --- | --- | --- |
| ジョブ進行 | queued / running / succeeded / partial / failed / cancelled | 実行がどう終わったか |
| 検査範囲 | complete / partial / unsupported / not_applicable | その能力のどこまで確認したか |
| 診断結果 | issues_found / none_found / inconclusive | 対応範囲内で何が分かったか |
| 鮮度 | current / input_changed / stale / unknown | 今の対象にも結果を適用できるか |

例えば「Cargo.lockの一覧読取に成功」は、パッケージ一覧能力について完了であり、target別の依存解析や脆弱性検査の完了ではない。能力ごとに結果を持ち、単一の正常フラグへ集約しない。

未確認はCheckRunがまだ存在しない場合にも表現できる。未導入ツールや破損入力は、対象外と混同しない。失敗しても最後に成功した結果を保持し、古い結果であることと最新の失敗を併記する。

Findingの「対応済み」という人の記録と、再検査で検出されなくなった事実は別に持つ。検査失敗、未対応パーサー、入力変更だけで過去のFindingを解消済みにしない。

## アダプターの契約案

| 処理 | 入力 | 出力 |
| --- | --- | --- |
| discover | 許可された探索範囲、相対パス、制限、キャンセル信号 | 候補、根拠、親子の提案、未探索・失敗情報 |
| inspect | 許可範囲内で読み取ったファイル集合とその指紋 | Observation、DependencyRecord、能力別の対応範囲 |
| inspectGit | 登録済みSourceLocation、固定した読取専用Git操作 | Git観測、能力別エラー |
| diagnose | 対象Snapshot、検索可能な依存情報、利用者の診断設定 | Finding、照会元、照会日時、送信情報の要約、範囲 |

discover/inspectは既定で外部通信・プロジェクトコード実行をしない。ファイルアクセスは共通サービスが範囲・サイズ・シンボリックリンクを検証して提供する。アダプターごとに任意のシェルコマンドを組み立てる設計にしない。

アダプターは、対応ファイル・形式・能力・必要ツール・外部通信の有無を宣言する。対応範囲はUIに返せる情報として扱う。フォーマットを認識できても版を解釈できない場合はunsupportedを返す。

Gitの機械処理や外部脆弱性照会など、静的な解析以外の処理は専用の実行制御を通す。検査に必要なCLIがなければ自動インストールしない。

## 画面とAPIの操作単位

| 操作 | 要点 |
| --- | --- |
| 探索範囲の登録・変更 | パスと制限を検証し、探索とは分けて保存 |
| 探索開始・状態取得・キャンセル | ジョブIDを返す。途中結果と完了を区別 |
| 候補一覧の取得 | 探索ID、候補区分、ページ単位で取得 |
| 選択候補の追加 | 操作ID、候補ID、候補の版、親子の選択を送る。再確認後に一括確定 |
| カタログの検索 | 条件、並び順、ページ、アーカイブ有無、追加操作IDを指定 |
| Projectの編集 | 編集版番号を検証。古い版の更新は競合として返す |
| 診断開始 | 対象IDと能力を指定。入力Snapshotを固定し、多重実行を防ぐ |
| 根拠・履歴の取得 | 対象IDから取得。任意パスを渡してファイル全文を読むAPIを作らない |

追加は操作IDで冪等にする。通信断後に同じ操作を照会・再送した場合、二重登録せず、既に確定した結果を返す。確定前の失敗は選択を保ったまま回復可能にする。

検索結果はProject単位で返し、一致したSourceLocationとComponentを明示する。別コピーにある依存を、今選んでいるコピーの依存として表示しない。

初版の検索は通常のDB検索から始める。ローカルの説明・タグ・パスとecosystem別の依存名を検索できるようにし、全文検索エンジンや意味検索は必要性が確認できてから検討する。

## 将来のクラウド照合

静的な配置設定はObservationとして保持する。クラウド照合時にDeploymentとCloudResourceを追加し、プロバイダー・アカウント境界・環境・資源ID・照会日時を別に持つ。

ローカルの設定をクラウドの実在の証明にせず、1つのComponentに複数環境が関連付くこと、資源にソースが紐付いていないことも表現できるようにする。アーカイブ状態から資源の停止・削除を推定しない。

認証や照会権限、プロバイダー別の照合方法は後続段階で設計する。初版はクラウドAPIに接続しない。

Project には、アーカイブする直前の管理状態を `archivedFrom` として保存する（2026-10-20）。アーカイブから戻すときにこの値を使い、アーカイブ以外の状態になったら消す。それより前にアーカイブしたものには値がなく、戻すときは「未設定」になる。

## 実装済みの依存台帳（2026-10-20）

上の DependencyRecord と Snapshot の初版として、npm だけを対象に次の2テーブルを追加した（`CREATE TABLE IF NOT EXISTS`、user_versionは1のまま）。

- `dependency_snapshots`: プロジェクトごとに最新1件。読み取り日時、状態（complete / partial / failed / no-lock）、読んだファイルごとの lockfileVersion・状態・説明・sha256 を payload に持つ。
- `dependencies`: 最新の読み取り結果の行だけを持つ。ecosystem、名前（別名は実体の名前）、解決版、宣言範囲（直接依存のみ）、直接/間接、区分（prod / dev / optional / peer）、取得元（registry / other-registry / url / git / file / unknown）、lockの相対パス、帰属フォルダ。読み直しは1つのトランザクションで置き換える。

SourceLocation は未導入のため、帰属はプロジェクトのフォルダからの相対パスで表す。過去の Snapshot 履歴は持たず、整理の履歴に読み取りの件数と状態を残す。カタログから外したプロジェクトの依存行は削除し、removals には最後に読み取った日時だけを残す。

2026-10-23 追記：Yarn・pnpm・Composer・Python（poetry.lock・uv.lock・Pipfile.lock・requirements*.txt）にも広げた。テーブルは変えていない。

- `dependencies.ecosystem` は OSV の名前で `npm`（npm・Yarn・pnpm）・`Packagist`（Composer）・`PyPI`（Python）。Python の名前は PEP 503 の形で保存する。
- 読んだファイルごとの結果に `format`（例：`npm v3`・`Yarn v1`・`pnpm 9.0`・`Composer`・`Poetry 2.1`・`uv v1`・`Pipfile.lock`・`requirements`）を足した。以前の読み取りには無い。状態に `unpinned`（requirements に版を固定していない行がある）を足した。
- 取得元の registry は、各 ecosystem の公開レジストリ（registry.npmjs.org と registry.yarnpkg.com・packagist.org・pypi.org）だけを指す。
- 対応キューの記録（`responses` の payload のアドバイザリ）に `ecosystem` を足した。以前の記録には無く、npm として扱う。

## 実装済みの脆弱性照会（2026-10-20）

`vulnerability_checks` テーブルを追加した（プロジェクトごとに最新1件、`CREATE TABLE IF NOT EXISTS`）。payload には、照会日時、照会した依存台帳の読み取り日時（`snapshotReadAt`）、状態（complete / partial）、照会できた版の数と失敗数、送らなかった依存の理由別件数、見つかったもの（依存の行とアドバイザリ）を持つ。

- アドバイザリは照会時点の内容を payload に保存する。OSVの記録を共有キャッシュとしては持たない（1回の照会の中では、同じ版の照会を1回にまとめる）。
- 全部失敗したプロジェクトは保存しない。一部失敗した場合、前回の照会があれば置き換えない。
- 依存を読み直すと `snapshotReadAt` と食い違うため、画面では「再照会が必要」と表示する。
- カタログから外すと照会結果は削除し、removals には最後の照会日時とアドバイザリIDを残す。
- 対応状況（未対応→調査中→…→解消確認）は未導入。Finding・Decision は次の段階で設計する。

## 実装済みの対応記録（2026-10-20）

- Project に `exposure`（public / internal / local / unknown。なければ unknown）を追加した。
- `responses` テーブル（`project_id` と `advisory_id` が主キー、`CREATE TABLE IF NOT EXISTS`）。payload に、状態、メモ、見直す日（対象外のとき）、更新日時、解消日時、最後に見たアドバイザリの要約（ID・概要・重大度・修正版・パッケージと版）、状態の履歴（日時・状態・メモ・`user` か `recheck` か）を持つ。
- 行がないものは未対応として扱う。手で付けられる状態は open / investigating / fixing / awaiting-recheck / not-applicable。resolved は、完全に終わった照会で検出されなくなったときにだけ付く。手で状態を付けていないアドバイザリも、消えたときに解消として記録する。
- 優先度は保存しない。表示のたびに、重大度・公開状況・管理状態から `shared/priority.ts` で計算する。
- カタログから外すと、対応記録は removals に移して削除する。

## 実装開始時に決める事項

- 各テーブルの索引、参照制約、DBマイグレーション方式。
- lock形式のfixtureと、能力ごとの具体的な対応バージョン。
- 脆弱性情報源、更新照会先、ecosystemごとのバージョン比較方式。
- 鮮度判定の期限と、保持する診断履歴の期間。

この文書は契約のたたき台とし、実装時はfixtureと検索・追加・更新の受入条件に合わせて具体的な型とAPIへ落とし込む。
