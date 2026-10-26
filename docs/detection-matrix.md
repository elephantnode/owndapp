# 検出・診断の対応表

更新日: 2026-10-19
状態: 初版の実装仕様案。下記は予定する対応範囲であり、実装・実データ検証済みという意味ではない。

## 対応段階

| 段階 | できること | できないこと |
| --- | --- | --- |
| A: 発見・登録 | 設定ファイルから候補を発見し、名前・技術・設定の根拠を保存 | 依存関係の全体把握や脆弱性の断定 |
| B: ローカル診断 | Git、宣言された要件、対応するロックファイルの解決済み依存を取得・検索 | 実際の配置先やインストール状態の確認 |
| C: 保守診断 | 外部照会による脆弱性・更新候補・サポート期限と対応記録 | 未検査項目を含む安全性の保証 |

A→B→Cの順で作る。対象を発見できることと、詳細診断に対応することを別々に表示する。

## 言語・パッケージ管理の対象

表の「後続」は、候補には登録できるが初版Bの詳細解析には含めない。

| ID | 対象と根拠ファイル | A: 発見時 | B: ローカル診断 | 制限・後続 |
| --- | --- | --- | --- | --- |
| JS-01 | `package.json` | 名前、説明、Node.js系、依存からフレームワーク候補 | `engines`、`packageManager`、直接依存の指定、`workspaces` | scriptsは実行しない。Node.js・Bun・Denoの区別は根拠を併記 |
| JS-02 | `package-lock.json` / `npm-shrinkwrap.json` | npm管理の根拠 | 形式1・2・3を対象に解決済みパッケージ名・版を取得 | 不明形式は未対応。同居時はshrinkwrapを有効候補とし根拠を表示。同名の複数版を保持 |
| JS-03 | `pnpm-lock.yaml` / `pnpm-workspace.yaml` | pnpm、workspace候補 | workspaceの静的な対象パス、直接依存の指定はJS-01から取得 | 解決済み版と依存グラフの解析は後続。importer単位の帰属を扱ってから対応 |
| JS-04 | `yarn.lock` / `bun.lock` / `bun.lockb` | 管理ツール候補 | 直接依存の指定はJS-01から取得 | 解決済み版の解析は後続。バイナリlockを文字列解析しない |
| JS-05 | `deno.json` / `deno.jsonc` / `deno.lock` | Deno候補、静的に取得可能な名前 | importの静的指定を根拠付きで保持 | 解決済み依存グラフは後続。JSR/npm/URLを混同しない |
| PY-01 | `pyproject.toml` / `.python-version` | Python候補、静的な名前・説明 | `[project]`の依存指定・`requires-python`、Python版指定 | dynamic項目とtool固有の依存構文は不明または未対応とする [S2] |
| PY-02 | `requirements*.txt` | Python候補 | 静的な名前・指定・環境条件を取得。`==`の固定指定も宣言値として保存 | 全依存が列挙されているとは判定しない。`-r`/`-c`は探索範囲内のみ、循環・深さを制限 |
| PY-03 | `uv.lock` / `poetry.lock` / `Pipfile` / `Pipfile.lock` | 管理ツール候補 | ロックファイルの存在と対応状況を表示 | 解決済み依存の解析は後続。uvのロックは環境横断の情報を含むため、そのまま現在環境のインストール一覧にしない [S3] |
| PY-04 | `setup.py` / `setup.cfg` | Python候補 | ファイルの存在を根拠として保存 | setup.pyを実行しない。メタデータの評価は後続 |
| PHP-01 | `composer.json` / `composer.lock` | PHP候補、名前、依存からフレームワーク候補 | `require`/`require-dev`、PHP要件、lockのパッケージ名・版・依存指定 | platformの指定やエミュレーションはホストPHPの実測値と区別。開発ブランチ版は通常の数値版に変換しない [S4] |
| PHP-02 | WordPressコア構造 / テーマの`style.css` / プラグインPHPヘッダー | サイト・テーマ・プラグイン候補 | コアの版のリテラル、ヘッダーの静的な名前・版・要件 | PHPやWP-CLIを実行しない。テーマ・プラグインの自動更新照会はC以降の別対応 |
| GO-01 | `go.mod` / `go.work` / `go.sum` | Goモジュールとworkspace候補 | module、go/toolchain、require/replace、workspaceの静的参照 | requireは宣言、go.sumは検証用の記録。実際に選択された全モジュールと断定しない [S5] |
| RS-01 | `Cargo.toml` / `Cargo.lock` / `rust-toolchain.toml` | Rust候補、名前、workspace | Rust指定と依存指定、lockのパッケージ名・版・sourceを取得 | 初版はパッケージ一覧まで。features・targetごとの到達可能性は不明。lockの形式対応は実装時のfixtureで明示 [S6] |
| OTHER-01 | `Gemfile` / `pom.xml` / `build.gradle*` / `*.csproj` / `Package.swift` | ファイル名から技術候補 | ファイルの存在のみ | 名前の静的取得・依存解析は後続。ユーザーが手動登録・訂正できる |

Vue・Next.jsなどは直接依存の宣言や対応lockを根拠としてラベル付けする。設定ファイル名だけを根拠とする場合は「候補」と表示する。Reactを使うだけでNext.jsとは判定しない。

解決済み一覧と、各Componentから到達可能な依存グラフは別能力とする。workspaceの共通lockにしか帰属を特定できないパッケージは、Project全体の依存として表示し、全Componentが使うとは表示しない。

JS-02の形式1はworkspace情報が不足する場合がある。lockの読み取り結果とmanifestの対応に矛盾があれば、宣言と解決済み情報を併記して「整合性未確認」とする。パッケージマネージャーを起動して解決し直さない。

## ランタイム指定の補助ファイル

`.nvmrc`、`.node-version`、`.tool-versions`、`mise.toml`、`rust-toolchain`、`.python-version`などは既存候補の属性を補う。補助ファイルだけで大量の独立プロジェクトを作らない。

複数の指定があればすべて根拠を保持する。`lts/*`や環境変数を含む値を勝手に現在の具体的な版へ置き換えない。範囲の重なりを評価できない場合は「比較未対応」とする。

ホストのランタイム版、仮想環境内の版、Docker内の版の実測は別の機能として後続にする。初版Bの主対象はファイルからの静的な指定取得である。

## 配置先・実行環境の設定

| ID | 根拠 | 初版で扱う情報 | 扱わない情報 |
| --- | --- | --- | --- |
| ENV-01 | `Dockerfile*` / `compose.yaml` / `compose.yml` / `docker-compose*.yml` / `docker-compose*.yaml` | Docker設定あり。静的なFROM・image・サービス名と根拠 | ビルド、pull、コンテナ起動・照会。imageタグから内部言語版を断定しない |
| CLOUD-01 | SAM/CloudFormationのYAML・JSON、`samconfig.toml` | `template.yaml` 等の resource type / Transform、`samconfig.toml` とそれが指すテンプレートから Lambda・SAM 候補 | stack実在、環境変数の値、認証情報、デプロイ済み版。Globalsによる継承は解釈できる範囲だけ [S7] |
| CLOUD-02 | `serverless.yml` / `serverless.yaml` / `serverless.json` / `serverless.ts` | Serverless設定あり。YAML/JSONは静的provider名のみ抽出 | 変数解決、プラグイン実行、TSの評価、関数実在 |
| CLOUD-03 | `cdk.json` / `Pulumi.yaml` / `Pulumi.yml` / `*.tf` / `*.tf.json` | IaCの種類と根拠パス | CDK synth、Pulumi実行、Terraform実行・state読取。CDKがあるだけでLambdaとは判定しない [S8] |
| CLOUD-04 | `vercel.json` / `netlify.toml` / `wrangler.toml` / `wrangler.json*` / `firebase.json` / `supabase/config.toml` | 配置・サービス設定の候補と根拠パス | サービスへの接続・ログイン・資源照会 |

一般的な`template.yaml`だけでAWSと判定せず、内容の型宣言などを検証する。補間式、参照、条件分岐を解決できない場合は「動的指定」とする。設定がないことから「クラウド未使用」とも判定しない。

## 探索・グルーピングのルール

1. 探索範囲は利用者が入力したローカルの絶対パスとする。フォルダ選択UIは将来の補助とし、ブラウザが任意の絶対パスを返す前提にしない。
2. `.git`はディレクトリとworktree用ファイルの両方を認識する。Git内部を再帰探索しない。
3. 一つの場所に複数言語のmanifestがあれば、混在構成としてまとめる。
4. workspaceの明示的なmember指定を優先して親Project・子Componentの候補を作る。すべての子manifestを機械的に独立Projectへ登録しない。
5. workspaceに含まれないネストしたmanifestやネストしたGitルートは、独立・子Componentを選べる候補にする。ファイルの近さだけで自動統合しない。
6. Gitのremoteが一致する別パスは「関連候補」とする。remote未設定や同一remoteの別用途もあるため、自動で重複扱いしない。
7. 同じ実パスの再登録は一意制約で防ぐ。再探索で用途・タグ・管理状態を上書きしない。
8. `.gitignore`だけで探索を除外しない。未追跡の個人アプリも見つけられるようにする。
9. `.git`、`node_modules`、`vendor`、`.venv`、`venv`、`__pycache__`、`dist`、`build`、`.next`、`.nuxt`、`target`、`.terraform`、`.aws-sam`、`cdk.out`、`.serverless`などを既定で除外する。除外名は調整可能とし、除外件数を表示する。
10. `.github`、`.config`などを含む隠しフォルダを一律除外しない。ただし秘密情報用ファイルは検出・記録の対象外にする。
11. シンボリックリンクは既定で辿らない。外部パスを指すworkspace/CodeUri/requirements参照は存在する参照として報告し、探索範囲外へアクセスしない。

探索上限は、深さ12、1回100万エントリー、manifest 2 MiB、lock 20 MiB、実行1200秒とする。上限到達は「一部未探索」として返し、探索範囲の分割や上限変更を案内する。キャンセル時も確認済みの候補を残す。性能値は実装後に調整する。

YAML/JSON/TOMLなどはデータとして読み、任意のタグや補間を実行しない。深さ、別名展開、入力長を制限する。エラー出力に原文や秘密情報の値を含めない。

## 依存検索と診断の見せ方

| 情報 | 表示・検索の扱い |
| --- | --- |
| 宣言された依存指定のみ | 「該当する可能性」を提示。脆弱性該当確定とは表示しない |
| 対応lockから取得した具体的な版 | 「記録された版」を根拠に対象候補を抽出。インストール済み・配置済みと表現しない |
| 未対応lock / Git・URL・ローカル依存 | 名前・種別・未確認理由を保持し、診断範囲からの欠落を表示 |
| lockなし / 破損 / 競合する複数lock | 状況を表示し、勝手にlockを生成・優先選択しない。JS-02の公式優先ルールは例外として根拠付きで適用 |
| workspace共通lock | Project単位の一致を提示。Componentへの帰属不明を明記 |
| アーカイブ | 検索で含めるか選択可能。診断の鮮度と管理状態は別表示 |

パッケージ名だけでなくecosystemも指定できる。バージョン指定の解釈はecosystemごとに分ける。初版では完全一致検索を必須とし、範囲検索は対応する文法を明示して追加する。

Cで脆弱性照会を実装する際は、照会元・送信範囲・取得時点・対象snapshotを明示し、スキャン中にファイルが変わった場合は古い入力への結果として残す。どのサービスを使うかは別途選定する。

## Gitの初版範囲

**実装済み（オンデマンド・静的）**: 登録済みプロジェクトに対し、`.git`（ディレクトリまたは worktree の `gitdir:`）を辿り、現在ブランチ／detached と remote 名・URL を読む。`git` CLI・fetch・status は使わない。認証付き URL は userinfo を除去して保存する。Gitなし・読めない・壊れた設定を区別する。

**後続**: 未コミット・未追跡・競合件数、追跡先、ローカルに保存された追跡先との差。detached HEAD、コミットなし、追跡先なし、Git未導入を個別に扱う。

Gitの比較はライブのremote照会ではない。remote更新日時を確実に取得できない場合は「リモート鮮度不明」とする。owndappの確認日時をfetch日時の代わりに使わない。Git statusの機械処理形式は公式仕様に従う [S9]。

## 実装時の受入例

- workspaceにNext.jsとAPIがある場合、親1件と子Componentを示し、共通lock由来の依存を両方に誤配分しない。
- `vue`の宣言はあるがlockがない場合、Vueの構成を示し、解決済み版と脆弱性診断は未確認にする。
- Goのgo.sumに複数版がある場合、全版を現在使用中としない。
- setup.py、next.config.js、serverless.ts、CDKのコードがあっても評価しない。
- サポート外lockでも候補登録・宣言依存の検索を可能にし、「異常なし」と表示しない。
- 依存物、worktree、ネストしたGit、壊れたmanifest、権限不足、循環参照、巨大lock、探索中のファイル消失をfixtureで検証する。
- 初版Bのfixture対象はnpm形式1/2/3、Composer、Cargoの代表形式。具体的なfixture一覧とCargo対応形式番号は実装開始時に固定し、ここへ追記する。

## 確認した一次資料

確認日: 2026-10-19。対応範囲そのものはowndappの設計判断。

- S1: [npm package-lock.json](https://docs.npmjs.com/files/package-lock.json/) / [npm-shrinkwrap.json](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/) / [package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) — 指定と解決済み版、lock形式と優先順位。[pnpm設定](https://pnpm.io/settings) — workspaceの根拠。
- S2: [Python pyproject.toml仕様](https://packaging.python.org/en/latest/specifications/pyproject-toml/) — 静的メタデータとPython要件。
- S3: [uvの構成ファイル](https://docs.astral.sh/uv/concepts/projects/layout/) — lockとプロジェクト環境の区別。
- S4: [Composer基本仕様](https://getcomposer.org/doc/01-basic-usage.md) / [platform依存](https://getcomposer.org/doc/articles/composer-platform-dependencies.md)。
- S5: [Go Modules Reference](https://go.dev/ref/mod) / [Go Modules Wiki](https://go.dev/wiki/Modules) — go.modとgo.sumの役割。
- S6: [Cargo.tomlとCargo.lock](https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html)。
- S7: [AWS SAM Function](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-function.html) — RuntimeとCodeUriなどの設定。
- S8: [Terraformファイル構成](https://developer.hashicorp.com/terraform/language/files)。
- S9: [Git status](https://git-scm.com/docs/git-status)。

## 2026-10-26 実装追記

Rust/Cargoの静的依存取り込みと既知の未対応形式の表示を追加。[対応範囲](dependency-coverage.md)に形式・取得元・workspace・検索の限界を記載。この追記は上記マトリクス全項目の実装完了を意味しない。
