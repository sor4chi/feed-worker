# feed-worker

Cloudflare Workers + KV + Cron で RSS/Atom を定期取得し、Discord に投稿するボットです。

## セットアップ概要

1. 依存関係のインストール

   ```
   pnpm install
   ```

2. KV を作成して `wrangler.toml` の `kv_namespaces` を更新

   ```
   pnpm wrangler kv:namespace create FEED_KV
   ```

   `wrangler.toml` の `kv_namespaces` を更新

   ```
   kv_namespaces = [
     { binding = "FEED_KV", id = "<KV_NAMESPACE_ID>" }
   ]
   ```

3. Discord のアプリ/ボットを用意し、
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_APPLICATION_ID`
   を準備
4. デプロイ

   ```
   pnpm run deploy
   ```

5. シークレットを設定

   ```
   pnpm wrangler secret put DISCORD_PUBLIC_KEY
   pnpm wrangler secret put DISCORD_BOT_TOKEN
   ```
6. コマンド登録（このリポジトリのルートで実行）

   - 必須: `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN`
   - 任意: `DISCORD_GUILD_ID`（指定するとそのサーバー限定。未指定はグローバル）

   ```
   # ギルドに登録（即時反映されやすい）
   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
     pnpm run register:commands

   # グローバルに登録（反映に時間がかかることがあります）
   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... \
     pnpm run register:commands
   ```

   取得場所の例:
   - Application ID: Discord Developer Portal → General Information
   - Bot Token: Discord Developer Portal → Bot
   - Guild ID: Discord クライアントで開発者モードを有効化してサーバーの ID をコピー
7. Discord Developer Portal で Interactions Endpoint URL に
   Worker の `/interactions` を設定

## Discord OAuth2 招待 URL（必要な権限）

- Scopes: `bot`, `applications.commands`
- Bot Permissions:
  - View Channels（必須。見えないチャンネルには送信できません）
  - Send Messages
  - Use Application Commands
  - （任意）Embed Links
  - （必要に応じて）Send Messages in Threads

## 使い方

- `/feed subscribe <url>`: このチャンネルにフィード購読を追加
- `/feed list`: サーバー内の購読一覧
- `/feed unsubscribe <subscribed_id>`: 購読解除

初回購読時は過去記事を投稿せず、最新記事を既読として扱います。

## トラブルシューティング

- `subscribe` 直後に `list` が空になる場合は、KV の反映に少し時間がかかることがあります。数十秒待って再実行してください。
- RSS/Atom ではない URL を指定すると「フィードを検出できない」エラーになります。公開フィードの URL を指定してください。

## Cron

`wrangler.toml` の `triggers` で 10 分おきに巡回する設定になっています。
必要に応じて調整してください。
