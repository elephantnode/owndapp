# owndapp

自分で作ったアプリをまとめて管理し、使っているパッケージに既知の脆弱性がないかをチェックするツールです。この Mac の中で動き、ブラウザで操作します。

## できること

- **探して登録する**：フォルダを探して、自分のアプリを一覧にします。
- **脆弱性をチェックする**：使っているパッケージを脆弱性データベース（OSV）に照会し、重大なものから並べます。
- **直して確かめる**：更新の手順をまとめた対策メモを作り、直したあとにもう一度チェックして解消を確かめます。
- **パッケージから探す**：特定のパッケージを使っているアプリを探せます。

## はじめかた

Mac と Node.js 24.14 以降が必要です（Windows は試験的な対応です）。

```sh
git clone https://github.com/elephantnode/owndapp.git
cd owndapp
npm run doctor
npm audit --package-lock-only --audit-level=high
npm ci --ignore-scripts --include=dev
npm audit signatures
npm run build
npm start
```

起動したら **http://127.0.0.1:4310** を開きます。1行ずつの説明は[マニュアル](docs/manual/01-getting-started.md)にあります。

## マニュアル

1. [はじめる](docs/manual/01-getting-started.md)
2. [アプリを登録する](docs/manual/02-register.md)
3. [脆弱性をチェックして対応する](docs/manual/03-check-and-fix.md)
4. [アプリを整理する・探す](docs/manual/04-organize.md)
5. [困ったとき](docs/manual/05-troubleshooting.md)
6. [アンインストール](docs/manual/06-uninstall.md)

## データと送信について

- 記録はこの Mac の中（owndapp のフォルダの `.owndapp`）にだけ保存します。
- チェックのときに送るのは、パッケージの種類・名前・版だけです。送る前に確認画面が出ます。フォルダのパス、アプリ名、ソースは送りません。
- パッケージの自動更新や、ソースの移動・削除はしません。
- インストール時の owndapp 自身のパッケージは、[Takumi Guard](docs/reference/takumi-guard.md)（`npm.flatt.tech`）を経由して取得します。

## 開発者向け

仕様・対応範囲・検証の記録は [docs/](docs) にあります。入口は[機能と対応範囲](docs/reference/features.md)と[開発者向け資料](docs/reference/development.md)です。開発に参加する場合は[貢献ガイド](CONTRIBUTING.md)を読んでください。

## ライセンス・問い合わせ

[MIT License](LICENSE)で公開しています。第三者のコードについては[Third-party notices](THIRD_PARTY_NOTICES.md)を参照してください。

不具合や要望は [Issues](https://github.com/elephantnode/owndapp/issues) へ。owndapp 自身の脆弱性は、公開 Issue に詳細を書かず[セキュリティ報告の手順](SECURITY.md)に従ってください。
