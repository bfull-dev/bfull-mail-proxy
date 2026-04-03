# Bfull 注文書メール送信プロキシAPIサーバー

## 概要

kintone カスタマイズ（`mail-send.js`）からの `kintone.proxy()` 経由のリクエストを受け取り、
lolipop.jp の SMTP サーバー経由でメールを送信するプロキシAPIサーバーです。

---

## セットアップ

### 1. パッケージインストール

```bash
cd proxy-server
npm install
```

### 2. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、各値を設定してください。

```bash
cp .env.example .env
```

`.env` の設定項目：

| 変数名 | 説明 |
|--------|------|
| `SMTP_HOST` | `smtp.lolipop.jp` |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` |
| `SMTP_USER` | `shipping@be-full.jp` |
| `SMTP_PASS` | SMTPパスワード |
| `API_KEY` | 任意の強力なランダム文字列 |
| `PORT` | サーバーポート（デフォルト：3000） |

> ⚠️ `.env` は絶対に Git にコミットしないでください（`.gitignore` で除外済み）。

### 3. サーバー起動

```bash
npm start
```

---

## デプロイ手順（Railway / Render / VPS など）

1. リポジトリに `proxy-server/` ディレクトリを含む形でプッシュ
2. デプロイ先のサービスで環境変数（`.env` の内容）を設定
3. `npm start` でサーバーを起動
4. デプロイ先のURLを確認する（例：`https://your-app.railway.app`）

---

## kintone 管理画面の設定

### プロキシURLの許可登録

kintone の `kintone.proxy()` を使用するには、送信先URLを許可リストに登録する必要があります。

1. kintone 管理画面 → 「システム管理」 → 「セキュリティ」 → 「JavaScriptとCSSのカスタマイズ」
2. 「許可するリクエスト先（ドメインベースURL）」にプロキシサーバーのURLを追加
   - 例：`https://your-app.railway.app`

### カスタマイズJSの設定

`customize/mail-send.js` の冒頭にある以下の定数を設定してください。

```javascript
const PROXY_URL = 'https://your-app.railway.app';  // デプロイ先URL
const API_KEY   = 'your-api-key-here';              // .env の API_KEY と同じ値
```

---

## API仕様

### POST /api/send-mail

**ヘッダー**

| ヘッダー名 | 値 |
|------------|-----|
| `Content-Type` | `application/json` |
| `X-Api-Key` | 設定した API_KEY |

**リクエストボディ**

```json
{
  "from": "shipping@be-full.jp",
  "to": ["pr@be-full.jp"],
  "bcc": ["example1@example.com", "example2@example.com"],
  "subject": "【商品名】 新製品のご案内 【株式会社Bfull 浪岡】",
  "text": "メール本文..."
}
```

**レスポンス（成功）**

```json
{ "success": true, "messageId": "<xxx@smtp.lolipop.jp>" }
```

**レスポンス（失敗）**

```json
{ "success": false, "error": "エラーメッセージ" }
```

### GET /health

サーバーの稼働確認用エンドポイント。

```json
{ "status": "ok", "timestamp": "2026-04-03T00:00:00.000Z" }
```
