# owndappへの貢献

owndappに関心を持っていただきありがとうございます。不具合報告・要望・プルリクエストを受け付けています。

**セキュリティ上の問題（脆弱性）は公開Issueやプルリクエストに書かないでください。** 報告方法は[SECURITY.md](SECURITY.md)を参照してください。

## はじめに

- 不具合報告と要望は、Issueのフォームから送ってください。
- 大きい変更（新しい依存形式・画面構成・データ形式・外部通信の変更など）は、実装前にIssueで相談してください。
- 次は対象範囲外です。提案いただいても採用しない場合があります。
  - 依存パッケージの自動更新・自動修正（`npm audit fix`相当の実行など）
  - 登録したアプリのソースを自動で変更する機能

## 開発の流れ

1. リポジトリをforkし、作業用のブランチを作ります（例: `fix/discovery-pause`、`docs/windows-setup`）。
2. 下記の手順で依存を取得し、変更します。
3. テスト・ビルドを実行し、プルリクエストを作成します。テンプレートの確認項目を埋めてください。

## 依存の取得と変更

[npm依存管理の方針](docs/dependency-policy.md)に従います。要点は次のとおりです。

- install時のライフサイクルスクリプトは`.npmrc`の`ignore-scripts=true`で無効にしています。`--ignore-scripts=false`や一括rebuildで迂回しないでください。
- 既存のlockを再現するときは、次を1行ずつ実行し、結果を確認してから進めます。

  ```sh
  npm audit --package-lock-only --audit-level=high
  npm ci --ignore-scripts --include=dev
  npm audit signatures
  ```

- 依存を追加・変更する場合は、直接依存を具体的な版で指定し（`--save-exact`）、lockの差分・取得元・integrityを確認してください。理由をプルリクエストに書いてください。
- `npm audit fix --force`は実行しないでください。overridesは根拠と互換性の検証がある個別対応に限ります。
- グローバルのnpm設定を変更する手順は求めません。

## テストとビルド

```sh
npm test
npm run build
npm run test:e2e
```

- E2EテストはmacOSにインストール済みのGoogle Chromeを使います。
- テストは一時フォルダに生成したサンプルと別のSQLiteを使います。**実際のプロジェクト・カタログ（`.owndapp/`）・認証情報を使ったテストや、それらの添付はしないでください。**
- 詳細は[開発者向け資料](docs/development.md)を参照してください。

## Windowsについて

Windows対応はフォルダ選択とパス入力の試験的な実装で、**Windows実機での導入・起動・テストは未検証です。** 現在の確認はmacOS上での模擬テストに限られます。

- 手順と未確認の項目は[Windowsで使う](docs/windows.md)を参照してください。
- Windowsに関わる変更では、実機で確認したかどうか（確認した場合はWindowsとNode.jsの版）をプルリクエストに明記してください。実機で確認していない場合は「未検証」と書いてください。

## ドキュメントの置き場所

| 内容 | 置き場所 |
| --- | --- |
| 利用者向けの概要・導入・使い方 | [README.md](README.md)、`docs/getting-started.md`・`docs/usage.md`など |
| 実装済み機能と対応範囲 | [docs/features.md](docs/features.md) |
| 未対応・今後の課題 | [docs/roadmap.md](docs/roadmap.md) |
| 開発・検証の手順と設計の経緯 | [docs/development.md](docs/development.md) |

READMEは利用者向けに保ち、実装の詳細は上記の各資料へ書いてください。機能を変更した場合は、対応する資料も更新してください。
