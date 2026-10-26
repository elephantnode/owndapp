# Third-party notices

owndapp自身のコードは[MIT License](LICENSE)で提供します。依存ライブラリには、それぞれのライセンスが適用されます。

## UI components

`src/components/ui/`はshadcn/uiの形式とコンポーネントを参考にした実装です。上流の著作権表示とMITライセンスを保持します。

Source: https://github.com/shadcn-ui/ui

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Bundled dependencies

`npm run build`は、バンドルした依存のライセンス一覧を`dist/third-party-licenses.md`へ出力します。ビルド成果物を配布するときは、このファイルも含めてください。ソースだけを配布する場合の依存一覧と版は`package-lock.json`、各パッケージのライセンスは取得したパッケージ内のLICENSEを参照してください。

ここでの一覧は依存コードの安全性を保証するものではありません。
