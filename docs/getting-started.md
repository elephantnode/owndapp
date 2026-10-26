# はじめる

owndappは、この端末の中で起動してブラウザで使うローカルツール。Node.jsを導入済みの開発者を対象とする。Windowsでのパス入力による利用も実装しているが、Windows実機は未検証。[Windows向け手順](windows.md)を参照。Apple Developer Programの登録や、通常のアプリとしてのインストールは不要。ターミナルからサーバーを起動し、http://127.0.0.1:4310 を開く。

停止・更新・バックアップと復元・困ったときは[運用](operations.md)を参照。

## 必要なもの

- macOS、またはWindows（パス直接入力。フォルダ選択・外部アプリ起動は未対応、実機未検証）
- Node.js 24.14以降（`package.json` の `engines` は `>=24.14.0`）と、同梱のnpm
- [GitHubリポジトリ](https://github.com/elephantnode/owndapp)からclone、またはDownload ZIPで取得したowndappのフォルダ

以降のコマンドは、すべてそのプロジェクトディレクトリで実行する。

以下のコマンド例はmacOSのシェル向け。Windowsは[PowerShell向け手順](windows.md)を使う。

## 初回の開始

### 1. 環境を確認する

```sh
npm run doctor
```

doctorはNode.jsの標準機能だけで動き、依存を導入する前でも実行できる。Node.jsの版・OS・依存の有無・`dist`（ビルド結果）・ポート指定・データの保存先を表示する。読み取りだけを行い、外部への送信・自動修復・データベースの作成はしない。示された案内に従って次へ進む。

初回は依存とビルド結果がないため、この診断は「要対応」を表示して終了コード1になります。この2項目だけなら想定どおりなので、次の依存検査へ進んでください。Node.js・OS・ポート指定などに問題がある場合は先に直します。起動前の診断では、すべて準備できている必要があります。

### 2. 依存を導入する

依存は[依存管理方針](dependency-policy.md)に従って導入する。このプロジェクトの `.npmrc` は `ignore-scripts=true` で、install時のライフサイクルスクリプトを既定で無効にしている。`--ignore-scripts=false` や一括rebuildで迂回しない。

同梱の `package-lock.json` を再現する手順。1行ずつ実行して結果を確認し、失敗を残したまま次へ進まない:

```sh
npm audit --package-lock-only --audit-level=high
npm ci --ignore-scripts --include=dev
npm audit signatures
```

- `npm audit --package-lock-only --audit-level=high`: 取得する前に、lockに記録された依存（devDependenciesを含む）を既知の脆弱性の情報と照合する。high未満の指摘も結果を読む。照会に失敗した場合は検査済みとしない。
- `npm ci --ignore-scripts --include=dev`: lockどおりの版を取得し、`node_modules` を置き換える。lockは変更しない。
- `npm audit signatures`: 取得したパッケージのレジストリ署名と、対応するprovenanceを検証する。署名未対応・取得失敗・検証失敗は区別して読む。

auditは既知の脆弱性を照合するもので、未知のマルウェアがないことは保証しない。署名・provenanceは出所と整合性の検証で、コードが無害である証明ではない。どちらかで重大な指摘・失敗が残っている場合は、次の手順へ自動で進まず、結果を確認してから判断する。

ネイティブ処理に必要なOS別パッケージをoptionalDependenciesから取得するため、`--omit=optional` や `optional=false` は使わない。ビルド・起動で依存のコードが動くため、脆弱性・署名検査の後に行う。

devDependenciesも必要（起動に `tsx` を使う）。`npm ci --omit=dev` は使わない。`--include=dev` を付け、`NODE_ENV=production` が設定された環境でも起動に必要な開発用依存を取得する。

依存を追加・変更する場合は `npm ci` ではなく、[依存管理方針](dependency-policy.md)の「導入の順序」に従う。

Guard経由でも、この検証ではauditと署名の検証が通った。ただし `Fetching verification keys using TUF failed` と出た後、Guardから鍵を直接取得する経路が使われた。警告だけで合否を判断せず、最終結果と終了コードを確認する。検証失敗を無視したり、設定を外して検査済みと扱ったりしない。auditでは依存の一覧が設定先のレジストリへ送られ、署名・provenanceの検証はnpm本来のレジストリ等にも通信することがある。

### 3. ビルドして開始する

```sh
npm run build
npm start
```

`npm start` は起動前に確認を行い、問題があれば案内を表示する。起動すると `owndapp: http://127.0.0.1:4310` と表示されるので、ブラウザで開く。サーバーは127.0.0.1だけで待ち受ける。

初回はデータの保存先（既定はプロジェクトディレクトリの `.owndapp/`）にデータベースが作られる。

### 4. 使い始める

「ホーム」から「アプリを追加」へ進み、「フォルダを追加」でプロジェクトを置いている親フォルダを選ぶ。画面の操作は[使い方ガイド](usage.md)を参照。

Node.js 24.14.0では、起動時に `SQLite is an experimental feature` というNode.js側の警告が出る。この検証ではデータ作成・起動・再起動は成功した。警告を非表示にはせず、起動完了のURLやエラーの有無も確認する。

## 通常の開始

```sh
npm start
```

コードや依存を更新していなければ、再ビルドは不要。更新した場合は[運用の「更新」](operations.md#更新)に従う。

## 開発時の開始

```sh
npm run dev
```

ソースの変更を反映しながら起動する。`dist` は不要。`npm start` と同じポート・同じ保存先を使うため、両方を同時に起動しない。

## 設定

| 環境変数 | 内容 | 既定 |
| --- | --- | --- |
| `OWNDAPP_PORT` | 待ち受けるポート（1024〜65535） | `4310` |
| `OWNDAPP_DATA_DIR` | データの保存先。相対パスはプロジェクトディレクトリからの位置 | `.owndapp` |

```sh
OWNDAPP_PORT=4320 OWNDAPP_DATA_DIR="$HOME/owndapp-data/main" npm start
```

保存先を変えた場合は、以後の起動・バックアップ・復元で同じ指定を使う。

## 確認済みの導入環境

macOS / Apple Silicon、Node.js24.14.0と同梱npmで、空キャッシュからの取得・署名検証・ビルド・初回起動・再起動を確認した。[検証結果と未確認の範囲](install-verification.md)を参照。
