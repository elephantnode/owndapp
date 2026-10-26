# 運用

このページのシェルコマンド例はmacOS向けです。Windowsの起動・保存先指定・バックアップは[Windows向け手順](windows.md)を参照してください。


停止・更新・バックアップと復元・困ったときの手順。初回の導入は[はじめる](getting-started.md)を参照。

以降のコマンドは、owndappのプロジェクトディレクトリで実行する。

## データの保存先

データはSQLiteの `catalog.sqlite` に保存する。保存先は既定でプロジェクトディレクトリの `.owndapp/`、`OWNDAPP_DATA_DIR` を指定した場合はそのディレクトリ（相対パスはプロジェクトディレクトリからの位置）。`npm run doctor` でも確認できる。起動時だけ `OWNDAPP_DATA_DIR=... npm start` と指定した場合、その値は停止後のシェルに残らないため、doctorやバックアップにも同じ保存先を明示する。

SQLiteはWALモードで使うため、保存先には `catalog.sqlite` のほかに `catalog.sqlite-wal`・`catalog.sqlite-shm` ができることがある。これらは一組で扱い、`catalog.sqlite` だけを取り出したり、別の時点のファイルと混ぜたりしない。

`.owndapp` はGitの対象外。Gitの操作ではバックアップされない。

## 停止

サーバーを起動したターミナルで `Ctrl+C` を押す。サーバーは受付を止め、データベースを閉じてから終了する。

停止したことは、ポートで待ち受けているプロセスがないことで確認できる（`OWNDAPP_PORT` を指定している場合はその番号）。

```sh
lsof -nP -iTCP:4310 -sTCP:LISTEN
```

何も表示されなければ停止している。`npm start` と `npm run dev` のどちらで起動したものも同じ方法で止める。

## バックアップ

サーバーを停止してから、保存先のディレクトリ全体を別の場所へコピーする。起動中に `catalog.sqlite` だけをコピーしたものは、バックアップとして使えない。

1. [停止](#停止)し、停止を確認する。
2. 保存先を確認する（`OWNDAPP_DATA_DIR` を指定していればそちら）。
3. まだ存在しない新しいパスへコピーする。

```sh
DATA_DIR="${OWNDAPP_DATA_DIR:-.owndapp}"
BACKUP="$HOME/owndapp-backups/owndapp-$(date +%Y%m%d-%H%M%S)"
test -d "$DATA_DIR" && test ! -e "$BACKUP" && mkdir -p "$HOME/owndapp-backups" && cp -Rp "$DATA_DIR/." "$BACKUP" && ls -la "$BACKUP"
```

`test ! -e` で、既存のバックアップを上書きしないようにしている。コピー元の末尾の `/.` は、保存先がシンボリックリンクの場合もフォルダの中身をコピーするための指定。事前確認に失敗した場合はコピーを開始しない。コピーの途中で失敗した場合は不完全な保存先が残ることがあるため、成功したバックアップとして扱わず内容を確認する。保存先はプロジェクトディレクトリの外にする。必要なら外部ディスクなど別の場所にも置く。

## 復元

1. [停止](#停止)し、停止を確認する。
2. 現在の保存先の全体を、復元前の状態として[バックアップ](#バックアップ)と同じ手順で保全する。
3. 復元するバックアップを、空の（まだ存在しない）保存先へディレクトリごとコピーする。既存の保存先に上書きしない。古い `catalog.sqlite-wal`・`catalog.sqlite-shm` が残っている場所へ `catalog.sqlite` だけを置くと、別の時点のファイルが混ざる。

新しい保存先へ復元し、`OWNDAPP_DATA_DIR` で指定する方法（現在の保存先には触れない）:

```sh
BACKUP="$HOME/owndapp-backups/owndapp-20261025-120000"   # 復元するバックアップ
RESTORED="$HOME/owndapp-data/restored-$(date +%Y%m%d-%H%M%S)"
test -d "$BACKUP" && test ! -e "$RESTORED" && mkdir -p "$HOME/owndapp-data" && cp -Rp "$BACKUP/." "$RESTORED" && ls -la "$RESTORED" && \
OWNDAPP_DATA_DIR="$RESTORED" npm start
```

以後もこの保存先を使う場合は、起動のたびに同じ `OWNDAPP_DATA_DIR` を指定する。

既定の `.owndapp` に戻して使いたい場合は、手順2の保全を終えたうえで、現在の `.owndapp` を存在しない名前へ移してから、空いた `.owndapp` へコピーする（削除はしない）:

```sh
BACKUP="$HOME/owndapp-backups/owndapp-20261025-120000"   # 復元するバックアップ
ASIDE="$HOME/owndapp-data/before-restore-$(date +%Y%m%d-%H%M%S)"
test -d "$BACKUP" && test ! -e "$ASIDE" && mkdir -p "$HOME/owndapp-data" && mv .owndapp "$ASIDE" && test ! -e .owndapp && cp -Rp "$BACKUP/." .owndapp && ls -la .owndapp
```

4. 起動し、プロジェクトの件数・最近の記録など、復元したかった内容が表示されることを確認する。

プロジェクトの外へ移した `before-restore-*` は自動では消さない。不要と判断できるまで残す。

## 更新

ここでは[GitHub](https://github.com/elephantnode/owndapp)から取得したプロジェクトディレクトリをGitで更新する場合を示す。追跡先（upstream）のブランチが設定されていない場合、Gitの取得手順はまだ用意していない。

1. 起動中のサーバーを[停止](#停止)し、停止を確認する。
2. 現在の状態を記録する。

   ```sh
   git status --short
   git branch --show-current
   git rev-parse HEAD
   ```

   未コミットの変更がある場合は、先にコミットするなど自分で扱いを決める。`git reset --hard` や `git clean` で変更を捨てない。`git rev-parse HEAD` の値は、元に戻すときに使うので控えておく。
3. データの保存先を確認する（`npm run doctor` または `OWNDAPP_DATA_DIR` の指定）。
4. 停止したまま、保存先の全体を[バックアップ](#バックアップ)する。
5. 更新を取り込む。追跡先が設定されているかを確認し、設定されている場合だけ進める。

   ```sh
   git rev-parse --abbrev-ref --symbolic-full-name '@{u}' && git fetch && git merge --ff-only '@{u}'
   ```

   1行目がエラーになる場合は追跡先がない。早送りできない（`--ff-only` で止まる）場合は、手元の変更と更新内容を確認してから判断する。
6. 依存の変更を確認する。

   ```sh
   git diff <記録したコミット> HEAD -- package.json package-lock.json .npmrc
   ```

   lockが変わっていれば、[はじめる](getting-started.md#2-依存を導入する)と同じ順で検査してから再現する（`npm audit --package-lock-only --audit-level=high` → `npm ci --ignore-scripts --include=dev` → `npm audit signatures`）。重大な指摘・失敗が残っていれば先へ進まない。`npm ci` は `node_modules` を置き換えるため、サーバーや検証中のプロセスを止めてから行う。
7. ビルド・確認・開始する。

   ```sh
   npm run build
   npm run doctor
   npm start
   ```

8. 画面で、プロジェクトの件数や対応記録など、更新前の記録が残っていることを確認する。

### 元に戻す

コードは記録したコミットへ戻す（`git switch --detach <記録したコミット>` など。未コミットの変更がないことを確認してから行う）。依存とビルドは手順6・7をやり直す。

新しい版で使ったデータベースは古い版で開けないことがある（「このデータベースは新しいowndappで作成されています」と表示される）。その場合は、手順4のバックアップを[復元](#復元)して使う。

## 困ったとき

まず `npm run doctor` を実行し、表示された案内を確認する。doctorは読み取りだけを行い、何も修復しない。

| 症状 | 確認すること |
| --- | --- |
| Node.jsの版が足りない | `node --version` が24.14以降か。版の切り替え方法は各自の環境に従う |
| 依存がない・`tsx` が見つからない | [はじめる](getting-started.md#2-依存を導入する)の手順で導入する。`--omit=dev` で導入した場合はdevDependenciesが足りない |
| `npm start` で画面が出ない・`dist` がない | `npm run build` を実行する（`npm run dev` では不要） |
| 「ポート4310は使用中です」（`EADDRINUSE`） | 別のowndapp（`npm start` と `npm run dev` の同時起動を含む）や他のプロセスが同じポートを使っていないか。`lsof -nP -iTCP:4310 -sTCP:LISTEN` で確認し、別のポートを使う場合は `OWNDAPP_PORT` を指定する。プロセスを強制終了する前に、それが何かを確認する |
| 「OWNDAPP_PORTを確認してください」 | `OWNDAPP_PORT` が1024〜65535の整数か |
| 記録が見当たらない | `OWNDAPP_DATA_DIR` の指定が前回と同じか（doctorで保存先を確認） |
| 「このデータベースは新しいowndappで作成されています」 | 古い版のコードで新しい版のデータを開いている。[元に戻す](#元に戻す)を参照 |
| フォルダ選択ダイアログが出ない | ダイアログはサーバーを起動したMacの画面に出る。Windowsではパス入力を使う（フォルダ選択・外部アプリ起動は未対応） |
| auditや署名の検証が失敗する | 結果を読み、照会の失敗と指摘を区別する。[依存管理方針](dependency-policy.md)に従い、`npm audit fix --force` は使わない |

## 探索の一時停止・再開・整理

「発見・追加」の「一時停止」で途中経過を保存して止める。アプリを終了した場合も、次回起動後は「続きから再開」で進められる。ブラウザだけを閉じた場合はサーバーの探索は続く。

「保存した探索の履歴」から以前の探索を開ける。読み取り失敗・設定ファイルの解析失敗は問題一覧で確認し、修正や権限の確認後に「失敗したフォルダを再試行」を使う。再開は作成時の除外設定を使うため、除外を変更して探索し直したい場合は「再探索」を選ぶ。後から追加した除外は表示結果にも適用する。

不要になった停止中の探索は「探索記録を削除…」から整理できる。確認済み候補・途中経過・問題の記録を削除する操作で、登録済みプロジェクトと元のファイルは残る。SQLiteの再利用可能領域は空くが、DBファイルの見かけの大きさがすぐ縮むとは限らない。

この方式への変更前の探索履歴は表示・登録に利用できるが、旧方式で中断した記録は再開できない。新しく探索し直す。通常のバックアップ手順でDB全体を保存すれば、新しい探索の途中経過も含まれる。
