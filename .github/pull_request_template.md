<!--
セキュリティ上の問題（脆弱性）の修正は、公開のプルリクエストを作る前に SECURITY.md の手順で報告してください。
実際のプロジェクトのパス・DB・.env・認証情報・個人情報を含めないでください。
-->

## 概要

<!-- 何を・なぜ変更したか -->

関連Issue: #

## 確認したこと

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e`（macOS・Google Chrome）
- [ ] テストや確認にサンプルのみを使い、実際のプロジェクト・カタログ・認証情報を使っていない

Windowsに関わる変更の場合（該当しなければ削除）:

- [ ] Windows実機で確認した（Windowsの版: / Node.jsの版: ）
- [ ] Windows実機では未検証（macOS上の模擬テストのみ）

## 依存の変更（該当しなければ削除）

- [ ] 直接依存を具体的な版で指定し、変更理由を上に書いた
- [ ] lockの差分・取得元・integrityを確認した
- [ ] `npm audit --package-lock-only --audit-level=high` と `npm audit signatures` の結果を確認した
- [ ] ライフサイクルスクリプトを有効化していない／`npm audit fix --force` を実行していない

## ドキュメント

- [ ] 必要に応じて更新した（利用者向け: README・docs/usage.md など／実装範囲: docs/features.md／課題: docs/roadmap.md／開発: docs/development.md）
