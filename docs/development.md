# 開発者向け資料

利用するための導入手順は[はじめる](getting-started.md)、開発課題は[開発課題と未対応項目](roadmap.md)を参照してください。

## 検証する

```sh
npm test
npm run build
npm run test:e2e
```

ブラウザ検証はインストール済みのGoogle Chromeを使う。テストは一時フォルダに生成したサンプルと別のSQLiteを使用し、実用カタログを変更しない。テスト用サーバーには4317番ポートを使用する。

[検証記録](verification.md)と[画面のスクリーンショット](screenshots/README.md)を参照。スクリーンショットのプロジェクトはすべてサンプル。

## 画面の技術構成

React・TypeScript・Vite。部品は [shadcn/ui](https://ui.shadcn.com) の形式で `src/components/ui/` に置き、Tailwind CSS v4 と Radix UI を使う。色・角丸などは `src/tokens.css` のトークンを `src/index.css` で shadcn の変数に対応づけている。部品の追加は shadcn CLI ではなく、[依存管理方針](dependency-policy.md)で依存を確認してからソースを配置する。

## データ・検証用の設定

データはこのディレクトリの `.owndapp/catalog.sqlite` に保存する。アーカイブでソースを移動・削除しない。`.owndapp` はGit対象外。

環境変数 `OWNDAPP_PORT` でポート、`OWNDAPP_DATA_DIR` で保存先を指定できる。フォルダ選択ダイアログはサーバーが `osascript` で開くため、サーバーを起動したMacの画面に表示される（macOS以外では使えない）。`OWNDAPP_TEST_PICK_FOLDER` はブラウザ検証用で、ダイアログの代わりに指定したフォルダを返し、「Finderで表示」と「○○で開く」は何もしない。同じく `OWNDAPP_TEST_PICK_APP` はアプリ選択の代わりに返す `.app` を指定する。サーバーの接続先は127.0.0.1に固定している。データベースをバックアップする場合はサーバーを停止してから `.owndapp` 全体（`OWNDAPP_DATA_DIR` を指定していればそのディレクトリ全体）をコピーする。手順と復元は[運用](operations.md#バックアップ)を参照。

## 主な変更の経緯

- owndapp自身のnpm取得先をTakumi Guardに設定。登録プロジェクトにも詳細の「パッケージ取得の保護」から個別に設定できる。設定済みは安全性や通信の検証済みを意味しない。[使い方と保護範囲](takumi-guard.md)を参照。

- 主要メニューは「ホーム」「アプリを追加」「登録したアプリ」「脆弱性と対応」「依存検索」「設定・使い方」の6項目。以前の「プロジェクト」配下の構成から変更した。
- 「要対応」と「対応キュー」を「脆弱性と対応」に統合し、対策メモ・エディタで開く・対応状況の変更・再チェックを同じ画面で行う。旧URL `#queue` は `#attention` へ移る。既存の記録形式は維持し、調査中と修正中は詳細で区別する。用途・タグ・開発状態の整理は任意。
- 登録候補の「登録してチェック」は登録後に送信内容の確認を開く。「選択した候補を登録」だけなら照会せず登録する。「脆弱性と対応」の先頭からアーカイブ以外の監視対象をまとめてチェックできる（1回1000件まで、超える場合は対象範囲を表示）。探索フォルダと除外一覧は表示／非表示を切り替えられる。
- Swiftの `.build` 配下（取得した依存ソースを含む）を探索から除外する。登録済みのものは除外対象と表示し、確認後に記録を残してカタログから外せる（自動削除はしない）。読み取りに対応する依存形式がない場合は「依存を判定できない」ことを優先表示し、詳細で対応範囲を説明する。
- Rustの依存取り込みと、未対応形式を含む検索範囲の表示を追加。
- 依存検索で未確認のアプリを一覧し、選択した対象だけを読み直す操作を追加。

## 設計・方針・検証記録

- [実装済みの機能と対応範囲](features.md)
- [全体構成](product-plan.md)・[検出・診断の予定対応表](detection-matrix.md)
- [画面設計](wireframes.md)・[ナビゲーション](navigation-plan.md)
- [データモデル案](data-model.md)・[探索の設計](discovery-plan.md)
- [npm依存管理方針](dependency-policy.md)
- [重大度と優先度](severity-policy.md)・[プロジェクトの対応状況](project-response.md)
- [初版の検証記録](verification.md)・[新規導入の検証記録](install-verification.md)

設計資料は将来の機能も含みます。実装の範囲は[実装済み機能](features.md)とコード、検証の範囲は各記録の日付・対象を確認してください。


## OSによる機能の切り替え

`/api/session`の`capabilities`はサーバーOSに基づく。macOSはフォルダ選択・Finder表示・登録アプリ起動、Windowsはパス入力を提供する。ブラウザOSでは判定しない。未対応のネイティブAPIは501で拒否し、画面からも隠す。機能情報を取得できない場合もネイティブ操作を表示しない。

Windowsのドライブ・UNC・引用符付きパス・ホーム展開を扱い、ドライブ相対/ルート相対/デバイス名前空間は直接入力として拒否する。探索範囲はサーバー側のpath.relativeで判断。画面のフォルダツリーはOS形式別に区切りと大小文字を扱い、別ドライブ・共有を区別する。Windowsの区切り規則と利用可能なファイルフラグは[Node.js path](https://nodejs.org/api/path.html)と[fs constants](https://nodejs.org/api/fs.html#file-open-constants)を参照。

WindowsにないO_NOFOLLOWだけに依存せず、静的読み取りでlstatの種類と開いたファイルのidentityを確認する。ジャンクションを含むWindows実FSの振る舞いや競合の網羅検証は未完了。既存の範囲外参照とsymlinkの拒否はmacOSで回帰検証する。

2026-10-26: macOS上でWindowsパスの純粋処理・OS機能を模擬したAPI/画面を検証。Windows実機でのCI・新規導入・起動を実施したという記録ではない。実機の受け入れ項目は[Windows手順](windows.md)を参照。


## 本番ビルドの警告（2026-10-26）

単一JSが520.39kBとなり500kBの警告が出たため、アプリ約221kBと依存ライブラリ約299kBに分割した。警告の閾値は引き上げていない。合計転送量を大きく削減したという変更ではない。

Radix UIとLucideのMODULE_LEVEL_DIRECTIVE（use client）は、RSCを使わないブラウザ専用構成でのみ限定して除外する。アプリ内・未知のライブラリ・別のdirectiveや別種の警告は通常のハンドラーに渡す。RSC/SSRやライブラリ配布へ変更する際は、この除外条件を再評価する。[Reactのuse client](https://react.dev/reference/rsc/use-client)、[Rolldownのdirective](https://rolldown.rs/in-depth/directives)と[codeSplitting](https://rolldown.rs/reference/OutputOptions.codeSplitting)に基づく。


## CIと配布物

`.github/workflows/ci.yml`はcontents:read、checkoutの認証情報保存なし、公式ActionのコミットSHA固定で用意する。macOSではlockのaudit→スクリプトを無効にしたci→署名検証→単体/API→ビルド→Chromeのブラウザ操作を実行する。Windows experimentalはbuild/doctorとWindows向けの限定したfixtureテストで、全テストや手動の実機受け入れを代替しない。GitHub上で実行するまではCI成功と扱わない。

npm公開は行わないためpackage.jsonのprivate:trueを維持する。MITはownコードへ適用し、バンドルした依存の表示はbuildで生成するdist/third-party-licenses.mdを同梱する。公開準備・残る判断は[公開準備](release-readiness.md)を参照。
