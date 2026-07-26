#!/usr/bin/env bash
# ローカルで動かしているゲームを Cloudflare Tunnel で外に出す。
#
#   bash scripts/tunnel.sh              # 使い捨ての公開URL（要ログインなし）
#   CLOUDFLARE_TUNNEL_TOKEN=... bash scripts/tunnel.sh   # 固定ドメインの名前付きトンネル
#
# 使い捨てトンネルの URL は起動のたびに変わり、プロセスを止めると消える。
# 名前付きトンネルを使う場合は、Cloudflare のダッシュボードで
# ingress の向き先を http://127.0.0.1:$PORT に設定しておくこと。

set -euo pipefail

PORT="${PORT:-8000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared が見つかりません。以下のいずれかで入れてください:"
  echo "  macOS   : brew install cloudflared"
  echo "  Linux   : https://github.com/cloudflare/cloudflared/releases から取得"
  echo "  Windows : winget install --id Cloudflare.cloudflared"
  exit 1
fi

echo "静的サーバを :$PORT で起動します"
node "$ROOT/scripts/serve.mjs" --port "$PORT" --host 127.0.0.1 --root "$ROOT" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# 起動を待つ
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/index.html" -o /dev/null; then break; fi
  sleep 0.25
done

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  # 名前付きトンネルの向き先は Cloudflare 側の ingress 設定で決まる。
  # ダッシュボードで http://127.0.0.1:$PORT を指しておくこと。
  echo "名前付きトンネルで公開します（向き先は Cloudflare 側の設定に従う）"
  exec cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"
else
  echo "使い捨てトンネルで公開します（URL は毎回変わります）"
  exec cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate
fi
