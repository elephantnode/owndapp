# owndapp のデザイントークン

2026-10-19。実体は `src/tokens.css`。新規のCSS方式は標準CSSを採用。

2026-10-19 追記: 利用者の指示でUIを shadcn/ui（Tailwind CSS v4・Radix UI）へ移行した。`src/tokens.css` の primitive・semantic 層は維持し、`src/index.css` で shadcn の変数（`--background` `--primary` など）と Tailwind の `@theme inline` に対応づける。角丸は `rounded-md`=入力6、`rounded-lg`=面10、`rounded-xl`=ダイアログ14。等幅フォントの変数は Tailwind との衝突を避けるため `--font-code` に改名した。

- 色: 明るいニュートラル、深い緑をアクセント。警告・エラーには意味のある色と文言を併用。
- 文字: macOSを含むシステムフォント。パスや数値にはシステム等幅フォント。
- 間隔: 4 / 8 / 12 / 16 / 24 / 32 / 48 px。
- 文字サイズ: 12 / 14 / 16 / 20 / 28 / 36 px。
- 角丸: 入力6、面10、ダイアログ14 px。
- 影: 控えめな2段の影。表を影で囲まない。
- 動き: 120msの色変化のみ。reduced-motionで無効化。
- 重なり: 通常0、固定要素10、ダイアログ20。

primitive → semantic → componentのCSS変数を定義。明るいテーマを初期表示とし、暗いテーマの意味変数も用意する。テーマ切替UIは今回の対象外。
