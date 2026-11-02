# npm依存管理の方針

2026-10-19。利用者が提示した[記事](https://qiita.com/miruky/items/fcab851c5351f79b481d)を考慮し、npm公式仕様を確認してowndappに適用する。

## 導入の順序

1. 必要なパッケージ名、用途、保守状況、取得元、候補版を確認する。直接依存は具体的な版で固定する。
2. `.npmrc` の `ignore-scripts=true` を維持し、`npm install --package-lock-only --ignore-scripts --save-exact ...` でまずlockだけを解決する。キャッシュ使用時も安全性の証明とは扱わない。
3. lockの追加・変更、取得元、integrity、ライフサイクルスクリプトを持つ依存を確認する。lock-onlyの段階ではパッケージ本体が未取得のため、スクリプト内容の確認は取得後にも行う。
4. `npm audit --package-lock-only --audit-level=high` でdevDependenciesを含めて既知脆弱性を検査する。high未満の指摘も結果に残し、無視を既定にしない。照会に失敗した場合は検査済みとしない。
5. `npm ci --ignore-scripts --include=dev` でlockどおりに取得し、`npm audit signatures` でレジストリ署名と対応するprovenanceを検証する。署名未対応・取得失敗・検証失敗は区別して報告する。
6. 検査結果を確認してから型検査・テスト・ビルド・開発サーバーを実行する。例外が必要なら、対象・理由・実行内容を具体化してから判断する。

既存lockを再現する場合はinstallではなくciを使う。依存変更を伴う場合のみinstallでlockを更新する。ciは既存のnode_modulesを置き換えるため、開発サーバーや検証中のプロセスがある場合は先に状態を確認する。

## 限界と例外

- auditは既知の脆弱性を検査するものであり、未知のマルウェアがないことを保証しない。
- 署名・provenanceは出所と整合性の検証であり、コードの無害性の証明ではない。
- ignore-scriptsはinstall時などの自動スクリプト実行を抑える。明示的な `npm run` やimport時のコード実行まで禁止するものではない。
- ネイティブバイナリなどに追加手順が必要でも、全パッケージのスクリプトをまとめて有効化しない。対象を限定し、ソースと必要性を確認する。
- overridesは脆弱性と親依存の関係を調べ、根拠とテストのある個別対応に限る。自動的な強制修正はしない。
- 公開からの日数は候補版の確認事項とする。日数だけで安全とは判定せず、未確認のnpm設定キーを追加して防御できたと扱わない。

## 適用範囲

このプロジェクトの `.npmrc`、AGENTS.md、導入・検証記録に適用する。グローバル設定は変更しない。

Dependabot、Dependency Review、CI audit、ActionsのSHA固定は、GitHubリポジトリを用意する段階で導入を検討する。ローカルに設定案があるだけでGitHub上の防御が有効とは報告しない。外部の解析サービスは自動で追加しない。

## 一次資料

- [npm ignore-scripts設定](https://docs.npmjs.com/cli/v11/using-npm/config/#ignore-scripts)
- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
- [npmレジストリ署名](https://docs.npmjs.com/about-registry-signatures/)

## Takumi Guard

利用者の明示指示により、プロジェクトの取得先を `https://npm.flatt.tech/` に設定する。匿名の悪意あるパッケージのブロックを追加し、上記の検査は維持する。既存lockは変更しない。後日通知は未設定。詳細は[Guardの運用](takumi-guard.md)。グローバル設定や他プロジェクトを一括で変更しない。
