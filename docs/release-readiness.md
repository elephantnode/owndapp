# GitHub公開の準備

2026-10-27。公開先: https://github.com/elephantnode/owndapp

## 準備したもの

- MIT LICENSE、package.jsonのlicense/repository/問い合わせ先
- SECURITY.md（GitHubの非公開報告を使用。Private vulnerability reportingは有効）
- CONTRIBUTING.md、バグ/要望フォーム、Pull Requestテンプレート
- macOSの単体/API・ビルド・Chrome操作と、Windows experimentalの限定テストを行うCI
- Windowsのフォルダ選択・対応.exe起動（実機未検証）と初回の任意アプリ登録
- 第三者の著作権表示と、ビルドに含める依存ライセンス一覧
- GitHubからの取得手順と、[v0.1.0リリース](https://github.com/elephantnode/owndapp/releases/tag/v0.1.0)

## 公開用の履歴

作業用の履歴には個人用の設定パスと実フォルダの検証記録が含まれるため、元の履歴を保持したまま、公開用コピーから新しい履歴を作成する。公開用では検証記録を要約し、テスト内の例示パスを架空のものにする。AGENTS.mdもローカルのスキル配置に依存しない内容にする。

元のリポジトリへのforce pushや履歴書き換えは行わない。公開用のリポジトリだけをGitHubへpushする。初回コミットはGitHubの非公開メール形式を使う。

## 公開する前に確認すること

- [x] 公開用コピーの差分・LICENSE・表示内容を確認する
- [x] GitHubでPrivate vulnerability reportingを有効にし、報告窓口が表示されることを確認する
- [x] SECURITY.mdの「まだ有効になっていない」という案内を、確認後に更新する
- [x] 公開用のmainをpushし、macOSとWindows experimentalのCI結果を確認する（main `2d89ec6`、run [40525175190](https://github.com/elephantnode/owndapp/actions/runs/40525175190)）
- [x] GitHubから新規取得する手順を確認する（fresh clone → doctor → audit → ci → signatures → build → start、`/api/session`応答）
- [x] 初回リリースの説明とタグを確認して公開する（[v0.1.0](https://github.com/elephantnode/owndapp/releases/tag/v0.1.0)）

Windowsは試験的対応のまま公開した。実機受け入れは公開後の課題とし、完了前に「Windows対応完了」とは扱わない。

## 確認した範囲

ソースとローカルGit履歴に対して、選択した秘密情報パターンと、DB・環境ファイル等の追跡を確認した。既知のキー形式を検出しないことは、あらゆる秘密情報が存在しないことの保証ではない。画像の文字や未知のキー形式はこの機械的検査の対象外。テスト内の `_authToken=secret-value` はfixtureのみ。

npmのauditは確認時点で0件。アプリの検証方法と結果は[検証記録](verification.md)を参照する。実データを使う追加のOSV照会や、依存の更新はこの公開準備では行わない。
