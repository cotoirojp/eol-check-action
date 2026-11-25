# EOL check アクション

依存関係のファイル（`composer.json`・`package-lock.json` など）と README だけを EOL check に送り、サポート終了などを検査する GitHub Actions のアクションです。ソースコードは送りません。

## 使い方

必ず **コミットの SHA で固定**して使ってください。`@v1` のようなタグは付け替えられるため、使わないでください。SHA の横に版をコメントで書くと、Dependabot が SHA を更新する PR を出してくれます。

```yaml
name: EOL check
on:
  push:
    branches: [main]
    paths:
      - '**/composer.json'
      - '**/package.json'
  schedule:
    - cron: '17 4 * * 2'
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  send:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: cotoirojp/eol-check-action@<40 桁のコミット SHA> # v1.0.1
        with:
          app-url: https://eolcheck.cotoiro.jp
```

`on:` の書き方は EOL check の「リポジトリ」画面で、リポジトリごとのものを確認できます。

## 仕組み

1. `actions/checkout`（SHA 固定）で、ファイルの中身を取得しないチェックアウト（`filter: blob:none`）をします。チェックアウトするパターン（依存関係のファイルと README だけ）は `action.yml` に書き込み済みで、実行時にサービスから取ることはありません。パターンは、固定したコミットのコードの一部です。
2. 同梱の `send.mjs` が、同梱の `catalog.json`（送るファイルの規則を、このアクションを作った時点で固定したもの）でファイルを選び、チェックアウトしたファイルを gzip して `/api/workflow/upload` に送ります。選ぶ規則も実行時には取得しないため、サービス側のデータが壊れても、送る範囲は広がりません。
3. 本人確認には GitHub の OIDC トークン（`id-token: write`）を使います。

サービスの送るファイルの定義が変わると、このアクションは古いものになります。EOL check の「リポジトリ」で案内が出たら、Dependabot の PR を取り込むか、SHA を新しいものに替えてください。古いままでも動きますが、新しい読み取り対象には対応しません。

## このリポジトリについて

次のファイルは手で書き換えません。EOL check のリポジトリから、`npm run generate` が作ったものです。

- `send.mjs`：`workflow/send.mjs` のコピーで、ひな形 A（1 ファイル）に埋め込むスクリプトと常に同じ内容です。
- `action.yml`：チェックアウトのパターンと、ひな形の版を書き込んだものです。
- `catalog.json`：送るファイルの規則の固定版です（EOL check の `/files.json` と同じ形）。EOL check のテストが、`/files.json` の内容と一致することを確かめます。

## ライセンス

MIT ライセンスです。[LICENSE](LICENSE) を参照してください。
