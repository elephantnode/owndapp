# Windowsで使う（パス入力版）

Windows向け第一段階の実装です。**Windows実機での導入・起動は未検証です。** 現在の確認はmacOS上でのWindowsパス処理と、Windowsの機能情報を模擬したAPI・画面のテストです。

## インストールと起動

Node.js 24.14以降とnpmを用意し、取得したowndappのフォルダをPowerShellで開きます。次を1行ずつ実行し、結果を確認してから進めます。

```powershell
node --version
npm.cmd run doctor
npm.cmd audit --package-lock-only --audit-level=high
npm.cmd ci --ignore-scripts --include=dev
npm.cmd audit signatures
npm.cmd run build
npm.cmd start
```

初回のdoctorは依存・ビルド結果がなく終了コード1になります。この2項目だけなら次の依存検査へ進めます。Node.jsなどの問題は先に直します。重大な指摘や検証失敗が残る場合は先へ進まず、結果を確認してください。各検査の意味は[導入手順](getting-started.md)を参照してください。

`npm.cmd`を直接呼ぶため、PowerShellのスクリプト実行ポリシーを変更する必要はありません。この手順では管理者権限やグローバル設定の変更を求めません。

起動したら http://127.0.0.1:4310 を開きます。2回目以降は`npm.cmd start`。停止は起動したPowerShellで`Ctrl+C`を押します。

## フォルダを追加する

「アプリを追加」→「探索フォルダをパスで追加」に、例のようなパスを入力します。

```text
C:\Users\名前\Projects
D:\開発プロジェクト
~\Projects
```

スペース・日本語を含むパスをそのまま入力できます。エクスプローラーの「パスのコピー」で付く外側の二重引用符も受け付けます。`C:Projects`や`\Projects`のように現在のドライブ・フォルダに依存する指定は受け付けません。

候補を選んで登録したら、チェックの確認画面へ進みます。脆弱性の照会はパッケージの種類・名前・版だけを送る既存の確認方式です。ソースやパスは送りません。操作全体は[使い方](usage.md)を参照してください。

除外フォルダも「除外フォルダをパスで追加」から入力します。フォルダ別表示はドライブや共有ごとに分かれます。UNCの構文（`\\server\share\folder`）も処理しますが、実際のネットワーク共有は未検証です。

フォルダ選択ダイアログ、Finder表示、エディタ・ターミナルの登録/起動は表示しません。修正作業は、普段使うエディタなどから対象フォルダを開いて行ってください。

## ポート・保存先を変える

既定の保存先はowndappの`.owndapp`です。必要な場合だけ、起動前に指定します。

```powershell
$env:OWNDAPP_PORT = "4320"
$env:OWNDAPP_DATA_DIR = "$HOME\owndapp-data\main"
npm.cmd start
```

同じ記録を使うには、次回も同じ保存先を指定します。macOSのカタログを移しても元のパスはWindowsのパスに自動変換されません。

## バックアップと復元

サーバーを停止してから、保存先フォルダ全体をコピーします。起動中の`catalog.sqlite`だけをコピーしないでください。

既定の`.owndapp`をバックアップする例（owndappのフォルダで実行）:

```powershell
$backupRoot = Join-Path $HOME "owndapp-backups"
$backupPath = Join-Path $backupRoot ("owndapp-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
if (Test-Path -LiteralPath $backupPath) { throw "同じ保存先が存在します" }
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
Copy-Item -LiteralPath ".owndapp" -Destination $backupPath -Recurse -ErrorAction Stop
```

保存先を変更している場合は、コピー元をそのフォルダに置き換えます。コピーに失敗した場合は完全なバックアップとして扱わないでください。

復元は、現在の記録も保全したうえで、バックアップの内容を新しい空のフォルダへコピーし、`$env:OWNDAPP_DATA_DIR`でその復元先を指定して起動します。既存DBへ上書きしたり、別の時点のWAL/SHMを混ぜたりしません。

## 実機で確認が残ること

- 空の環境での取得・audit・署名検証・ビルド・初回起動。
- 日本語/空白/別ドライブの探索、除外、登録、依存読み取り、確認付き照会。
- データの保存、停止/再起動、バックアップ/復元。
- ACLによる読み取り拒否、ジャンクションやsymlink、UNC共有・長いパス。
- Guardの設定書き込み、ネットワークや署名検証の実際の挙動。

ここにある手順のPowerShell実行とWindows実ファイルシステムでの動作は未検証です。開発課題は[課題一覧](roadmap.md)にまとめています。
