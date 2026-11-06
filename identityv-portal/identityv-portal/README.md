# 荘園新報 — 第五人格（Identity V）ニュースポータル（非公式）

公式サイトのお知らせを `fetcher.py` で集めて `data/news.json` に保存し、静的ページ（`index.html`）で表示します。
GitHub Actions が毎日自動で取得・コミットし、Vercel が自動で公開し直します。新着は Discord にも通知できます。

```
 GitHub Actions（毎日 9:17 / 18:17）
   fetcher.py → data/news.json を更新 → コミット＆プッシュ
                                      ├→ Vercel が自動で再デプロイ（サイトに反映）
                                      └→ notify_discord.py が新着だけ Discord に通知（任意）
```

## ファイル構成

```
identityv-portal/                 ← このフォルダをそのまま GitHub リポジトリにします
├─ index.html                     ページの骨組み（カード・詳細ポップアップの雛形）
├─ style.css                      デザイン（色・書体は :root で管理）
├─ script.js                      表示・検索・絞り込み・お気に入り・詳細ポップアップ
├─ data/
│   └─ news.json                  表示データ（最初はサンプル。自動で置き換わる）
├─ fetcher.py                     ニュース取得スクリプト
├─ notify_discord.py              Discord 通知スクリプト（任意機能・追加インストール不要）
├─ requirements.txt               Python の依存パッケージ
├─ vercel.json                    Vercel の設定（news.json をキャッシュさせない）
├─ .vercelignore                  Vercel に公開しないファイル（Python スクリプトなど）
├─ .gitignore                     Git に入れないファイル
└─ .github/
    └─ workflows/
        └─ update-news.yml        GitHub Actions の自動実行設定
```

> `.github` や `.vercelignore` のように「.」で始まるファイルは、Windows のエクスプローラーや macOS の Finder で
> 隠しファイル扱いになることがあります。消さないように注意してください。

## サイトの機能

| 機能 | 使い方 |
| --- | --- |
| 詳細ポップアップ | カードのどこかを押すと詳細が開きます。`←` `→` キーまたは「前の記事／次の記事」で移動、`Esc` か背景クリックで閉じます。「リンクをコピー」でその記事を開いた状態のURLを共有できます。 |
| お気に入り | カードの「☆ 保存」かポップアップの「お気に入りに追加」。「お気に入りだけ」で保存した記事だけを表示します。保存先はブラウザの localStorage なので、**端末・ブラウザごと**に別々です。一覧から消えた古い記事も保存した内容で表示できます。 |
| タグ絞り込み | 「詳細な絞り込み」でタグを選びます。複数選んだときは「すべて含む／どれかを含む」を切り替えられます。カード上のタグを押しても絞り込めます。 |
| 掲載日 | 1週間以内／1か月以内／3か月以内／1年以内 |
| 並び順 | 新しい順／古い順 |
| キーワード検索 | `コラボ 衣装`（AND）、`コラボ OR 大会`・`コラボ\|大会`（OR）、`-サンプル`（除外）、`"11月5日"`（語句）、`#補填`（タグ）。ひらがな/カタカナ・全角/半角は区別しません。`/` キーで検索窓へ移動。 |

絞り込みの状態はURL（例：`?cat=event&tag=コラボ&period=30`）に反映されるので、そのままブックマークや共有ができます。

---

# 公開までの手順（初めての人向け）

全部で 6 ステップです。上から順に進めてください。

## ステップ 0：手元で表示を確認する（任意）

`fetch()` で JSON を読むため、`index.html` をダブルクリックで開くのではなく、ローカルサーバー経由で開きます。
このフォルダ（`index.html` がある場所）でターミナル（Windows なら PowerShell）を開いて実行します。

```bash
python -m http.server 8000
```

ブラウザで http://localhost:8000 を開きます。終了は `Ctrl + C`。

最新ニュースを手元で取得してみる場合：

```bash
pip install -r requirements.txt
python fetcher.py --dry-run
```

`--dry-run` は保存せずに結果だけ表示します。外すと `data/news.json` が更新されます。

## ステップ 1：GitHub にリポジトリを作ってアップロードする

1. https://github.com にログインし、右上の「＋」→「New repository」。
2. Repository name に `identityv-portal` など好きな名前を入れます。
   - **Public（公開）を推奨**します。GitHub Actions が無料で使い放題になり、Vercel の無料プランとも相性が良いためです。
3. 「Create repository」を押します（README などの追加はチェックしないでおきます）。

### アップロード方法 A：Git コマンド（おすすめ）

Git をインストール（https://git-scm.com ）してから、このフォルダで実行します。
`あなたのユーザー名` と `リポジトリ名` は自分のものに置き換えてください。

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "first commit"
```

```bash
git branch -M main
```

```bash
git remote add origin https://github.com/あなたのユーザー名/リポジトリ名.git
```

```bash
git push -u origin main
```

### アップロード方法 B：ブラウザでドラッグ＆ドロップ

リポジトリ画面の「uploading an existing file」から、**フォルダの中身**（`index.html` などが一番上に来るように）をドラッグします。
※ `.github` フォルダはドラッグで上がらないことがあります。その場合は「Add file」→「Create new file」でファイル名に
`.github/workflows/update-news.yml` と入力し、中身を貼り付けて作成してください。

アップロード後、リポジトリのトップに `index.html` と `.github` フォルダが並んでいればOKです
（`identityv-portal/index.html` のように一段深くなっていたら、置き場所が違います）。

## ステップ 2：GitHub Actions にコミットの権限を与える

自動実行がニュースをコミットできるようにします。

1. リポジトリの「Settings」→ 左メニュー「Actions」→「General」。
2. 一番下の「Workflow permissions」で **「Read and write permissions」** を選び「Save」。

## ステップ 3：自動更新を手動で1回動かしてみる

1. リポジトリの「Actions」タブを開きます（「I understand my workflows…」と出たら有効化ボタンを押します）。
2. 左の「Update news」→ 右の「Run workflow」→ 緑の「Run workflow」。
3. 1〜3分ほどで緑のチェックになれば成功です。リポジトリのコミット履歴に `Update news.json (…)` が増えます。
   - 初回はサンプルデータが公式サイトの記事に置き換わり、記事の本文を開くので少し時間がかかります。
   - 赤い × になったら、その実行を開いてログを確認します。よくある原因は下の「困ったとき」へ。

以後は**毎日 9:17 と 18:17（日本時間）に自動で実行**されます（GitHub の混雑で数分〜数十分遅れることがあります）。
時刻を変えたいときは `update-news.yml` の `cron` を編集します（UTC なので日本時間から 9 時間引いた値を書きます）。

## ステップ 4：Vercel で公開する

1. https://vercel.com に「Continue with GitHub」でログインします。
2. 「Add New…」→「Project」→ ステップ1のリポジトリの「Import」。
3. 設定画面はそのままで構いません。
   - Framework Preset：**Other**
   - Root Directory：`./`（リポジトリのトップに `index.html` がある場合）
   - Build Command / Output Directory：空欄のまま
4. 「Deploy」を押します。1分ほどで `https://リポジトリ名-xxxx.vercel.app` のようなURLが発行されます。

これで、GitHub Actions が `news.json` をコミットするたびに **Vercel が自動で再デプロイ**し、サイトが最新になります。
（Vercel の「Deployments」画面で、コミットのたびにデプロイが増えていれば動いています）

### 自動デプロイされないとき（Deploy Hook を使う）

リポジトリが非公開（Private）の場合などに、ボットのコミットでデプロイが始まらないことがあります。そのときは：

1. Vercel のプロジェクト →「Settings」→「Git」→「Deploy Hooks」で、名前 `github-actions`、ブランチ `main` を入れて「Create Hook」。
2. 表示されたURLをコピーします。
3. GitHub のリポジトリ →「Settings」→「Secrets and variables」→「Actions」→「New repository secret」。
   Name に `VERCEL_DEPLOY_HOOK_URL`、Secret にコピーしたURLを貼って保存。

次回から、ニュースが更新されたときにワークフローが Deploy Hook を呼んで再デプロイします。

## ステップ 5：公開URLを登録する（おすすめ）

1. GitHub のリポジトリ →「Settings」→「Secrets and variables」→「Actions」→「Variables」タブ →「New repository variable」。
2. Name：`PORTAL_URL`、Value：Vercel のURL（例：`https://identityv-portal-xxxx.vercel.app`。末尾の `/` は不要）。

Discord の通知を押したときに、公式サイトではなく**このサイトの詳細ポップアップ**が開くようになります。

また、`fetcher.py` の `USER_AGENT` の `https://example.com/` も公開URLに書き換えてコミットしておきましょう（取得先の管理者が連絡できるようにするマナーです）。

## ステップ 6：Discord に新着を通知する（任意）

新しい記事が増えたときだけ、Discord のチャンネルに記事カードを送ります。

### 6-1. Webhook URL を作る

1. Discord で通知を送りたいサーバーを開き、チャンネル名の横の ⚙（チャンネルの編集）を押します。
   （サーバーの「ウェブフックの管理」権限が必要です）
2. 「連携サービス」→「ウェブフック」→「新しいウェブフック」。
3. 名前（例：荘園新報）を付け、「ウェブフックURLをコピー」。

> Webhook URL は「そのチャンネルに誰でも投稿できる鍵」です。コードやファイルに書いたり、人に見せたりしないでください。

### 6-2. GitHub に Secret として登録する

GitHub のリポジトリ →「Settings」→「Secrets and variables」→「Actions」→「Secrets」タブ →「New repository secret」。

- Name：`DISCORD_WEBHOOK_URL`
- Secret：コピーした Webhook URL

これだけで、次回から新着があれば自動で通知されます。

### 6-3. 動作確認（任意）

手元のパソコンでテストメッセージを送れます（Python の追加インストールは不要です）。

Windows（PowerShell）：

```powershell
$env:DISCORD_WEBHOOK_URL = "ここにWebhook URL"
python notify_discord.py --test
```

macOS / Linux：

```bash
export DISCORD_WEBHOOK_URL="ここにWebhook URL"
python notify_discord.py --test
```

Discord に「✅ 荘園新報の通知テストです」と届けば設定は正しいです。

### 通知のしくみと細かい設定

- ワークフローが取得の前に `news.json` を控えておき、取得後と比べて**新しく増えた記事だけ**を送ります。
- 初回（サンプルデータからの置き換え）は全件が新着扱いになるため、通知しません。
- 1回に最大 20 件まで記事カードを送り、それ以上は「ほか N 件」にまとめます。
- 記事タイトルに `@everyone` などが含まれていても、メンションは飛ばないようにしています。
- **カテゴリを絞る**：Variables に `NOTIFY_CATEGORIES` を作り、`maintenance,update` のように書くと、その種類だけ通知します
  （`maintenance` メンテナンス／`update` アプデ情報／`event` イベント・コラボ／`other` その他）。
- 通知に失敗しても、ニュースの更新自体は止まりません（ログに記録されます）。

---

## 設定・Secrets の一覧

| 種類 | 名前 | 必須 | 内容 |
| --- | --- | --- | --- |
| 設定 | Workflow permissions | ✅ | Read and write permissions |
| Secret | `DISCORD_WEBHOOK_URL` | 任意 | Discord の Webhook URL |
| Secret | `VERCEL_DEPLOY_HOOK_URL` | 任意 | 自動デプロイされないときだけ |
| Variable | `PORTAL_URL` | 任意 | 公開サイトのURL |
| Variable | `NOTIFY_CATEGORIES` | 任意 | 通知するカテゴリ（カンマ区切り） |

## 困ったとき

| 症状 | 確認すること |
| --- | --- |
| Actions が `Permission denied` / `403` で失敗する | ステップ2の「Read and write permissions」 |
| Actions が「ニュースを1件も取得できませんでした」で失敗する | 公式サイトの一時的な不調か、ページ構造の変更。何度も続くなら `fetcher.py` の `IdentityVOfficialSource` の `BASE_URL`・`ARTICLE_PATH_RE` を確認 |
| 予定の時刻に動かない | GitHub の混雑で遅れることがあります。また、60日間リポジトリに動きがないと定期実行が止まるので、Actions 画面から再度有効にします |
| サイトが更新されない | Vercel の「Deployments」を確認。増えていなければ「Deploy Hook を使う」の手順へ |
| Discord に届かない | Secret 名が `DISCORD_WEBHOOK_URL` と完全に一致しているか、`--test` で届くか。新着がない回は送られません |
| お気に入りが消えた | ブラウザのデータ（Cookie とサイトデータ）を消すと消えます。シークレットモードでは保存されません |

## 拡張のしかた

- **取得元を増やす**：`NewsSource` を継承したクラスを作り、`build_sources()` に追加します。RSS なら同梱の `RssSource` がそのまま使えます。
- **タグを増やす・変える**：`fetcher.py` の `TAG_RULES` を編集します。次の実行で過去の記事にも付け直されます。
- **カテゴリ判定を変える**：`fetcher.py` の `CATEGORY_KEYWORDS` を編集します。
- **カテゴリを増やす**：`fetcher.py` の `CATEGORIES`、`script.js` の `CATEGORIES`、`notify_discord.py` の `CATEGORIES`、`index.html` のタブ、`style.css` のカテゴリ色に同じキーを追加します。
- **公式サイトの構造が変わったら**：`IdentityVOfficialSource` の `BASE_URL`・`SECTIONS`・`ARTICLE_PATH_RE` を直します。

## 自前のサーバーで動かす場合

cron に登録します（GitHub Actions を使うなら不要です）。

```cron
17 0,9 * * * cd /path/to/identityv-portal && /usr/bin/python3 fetcher.py >> fetch.log 2>&1
```

## 注意

非公式のファンサイトです。取得頻度は1日数回程度にとどめ、取得先サイトの利用規約と robots.txt を守ってください
（`fetcher.py` は robots.txt を確認し、アクセス間隔を空けて取得します）。
