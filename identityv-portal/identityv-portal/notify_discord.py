#!/usr/bin/env python3
"""新着ニュースを Discord に通知するスクリプト（任意機能）

更新前と更新後の news.json を比べて、新しく増えた記事だけを Discord の Webhook に送ります。
Python の標準ライブラリだけで動きます（追加のインストールは不要）。

使い方:
    # Webhook URL は環境変数で渡します（コードやファイルに直接書かないこと）
    #   Windows PowerShell:  $env:DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/..."
    #   macOS / Linux:       export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
    python notify_discord.py --test                                   # 接続テスト（テストメッセージを1通送る）
    python notify_discord.py --old old.json --new data/news.json      # 差分を通知
    python notify_discord.py --old old.json --new data/news.json --dry-run  # 送らずに内容だけ表示

環境変数（どれも任意。GitHub Actions では Secrets / Variables から渡します）
    DISCORD_WEBHOOK_URL  送信先の Webhook URL（必須。未設定なら何もせず終了）
    PORTAL_URL           公開サイトのURL。設定すると、通知のリンク先がサイトの詳細表示（?id=…）になる
    NOTIFY_CATEGORIES    通知するカテゴリをカンマ区切りで（例: maintenance,update）。空なら全部
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

USER_AGENT = "IdentityVNewsPortal-Notifier/1.0"
MAX_EMBEDS_PER_MESSAGE = 10   # Discord の上限
MAX_NOTIFY = 20               # 1回の実行で通知する最大件数（それ以上は「ほか N 件」にまとめる）
BOT_NAME = "荘園新報"

# script.js / style.css のカテゴリ色と揃えています
CATEGORIES = {
    "maintenance": ("メンテナンス", 0xDCBB7C),
    "update": ("アプデ情報", 0xB8323C),
    "event": ("イベント/コラボ", 0xD297BB),
    "other": ("その他", 0xA89D8F),
}


def load_items(path: Path) -> tuple[dict, list[dict]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, []
    if isinstance(data, list):
        return {}, [d for d in data if isinstance(d, dict)]
    return data.get("meta", {}) or {}, [d for d in data.get("items", []) if isinstance(d, dict)]


def find_new_items(old_path: Path, new_path: Path, categories: set[str]) -> tuple[list[dict], str | None]:
    """（新着記事のリスト, 通知しない理由）を返す"""
    old_meta, old_items = load_items(old_path)
    _, new_items = load_items(new_path)
    if not old_items or old_meta.get("source") == "sample":
        # 初回はすべてが「新着」になってしまうので通知しない
        return [], "初回の取得（サンプルからの置き換え）のため通知しません"

    known = {item.get("id") for item in old_items}
    fresh = [
        item for item in new_items
        if item.get("id") not in known
        and not item.get("is_sample")
        and (not categories or item.get("category") in categories)
    ]
    fresh.sort(key=lambda i: str(i.get("date", "")), reverse=True)
    return fresh, None


def item_link(item: dict, portal_url: str) -> str:
    if portal_url:
        return f"{portal_url.rstrip('/')}/?{urlencode({'id': item['id']})}"
    return str(item.get("url", ""))


def clip(text: str, limit: int) -> str:
    text = str(text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def build_embed(item: dict, portal_url: str) -> dict:
    label, color = CATEGORIES.get(item.get("category"), CATEGORIES["other"])
    tags = " ".join(f"#{t}" for t in item.get("tags", []) if t)
    lines = [clip(item.get("summary", ""), 300)]
    if portal_url and item.get("url"):
        lines.append(f"[公式の元記事]({item['url']})")
    embed = {
        "title": clip(item.get("title", "(無題)"), 256),
        "url": item_link(item, portal_url) or None,
        "description": "\n".join(l for l in lines if l) or None,
        "color": color,
        "fields": [{"name": "カテゴリ", "value": label, "inline": True},
                   {"name": "掲載日", "value": str(item.get("date", "-")), "inline": True}],
        "footer": {"text": clip(f"{item.get('source', '')}  {tags}".strip(), 2048) or BOT_NAME},
    }
    return {k: v for k, v in embed.items() if v is not None}


def build_messages(items: list[dict], portal_url: str) -> list[dict]:
    shown, rest = items[:MAX_NOTIFY], len(items) - MAX_NOTIFY
    messages = []
    for start in range(0, len(shown), MAX_EMBEDS_PER_MESSAGE):
        chunk = shown[start:start + MAX_EMBEDS_PER_MESSAGE]
        message = {
            "username": BOT_NAME,
            "embeds": [build_embed(item, portal_url) for item in chunk],
            "allowed_mentions": {"parse": []},  # 記事タイトル中の @everyone などで誤ってメンションしない
        }
        if start == 0:
            message["content"] = f"📰 第五人格の新着ニュースが {len(items)} 件あります"
        messages.append(message)
    if rest > 0:
        more = f"ほか {rest} 件の新着があります。"
        if portal_url:
            more += f" 一覧: {portal_url}"
        messages.append({"username": BOT_NAME, "content": more, "allowed_mentions": {"parse": []}})
    return messages


def post(webhook_url: str, payload: dict, retries: int = 3) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    for attempt in range(retries + 1):
        request = urllib.request.Request(
            webhook_url, data=body, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            with urllib.request.urlopen(request, timeout=15):
                return
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < retries:  # 送りすぎ。指定された秒数だけ待って再送
                try:
                    wait = float(json.loads(exc.read().decode("utf-8")).get("retry_after", 2))
                except (ValueError, AttributeError):
                    wait = 2.0
                time.sleep(min(wait, 30) + 0.5)
                continue
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"Discord がエラーを返しました（HTTP {exc.code}）: {detail}") from exc
        except urllib.error.URLError as exc:
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Discord に接続できませんでした: {exc.reason}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="新着ニュースを Discord に通知します。")
    parser.add_argument("--old", type=Path, help="更新前の news.json")
    parser.add_argument("--new", type=Path, default=Path("data/news.json"), help="更新後の news.json")
    parser.add_argument("--test", action="store_true", help="テストメッセージを1通送って設定を確認する")
    parser.add_argument("--dry-run", action="store_true", help="送信せずに内容を表示する")
    args = parser.parse_args(argv)

    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    portal_url = os.environ.get("PORTAL_URL", "").strip()
    categories = {c.strip() for c in os.environ.get("NOTIFY_CATEGORIES", "").split(",") if c.strip()}

    if not webhook_url and not args.dry_run:
        print("DISCORD_WEBHOOK_URL が設定されていないため、通知はしません。")
        return 0
    if webhook_url and not webhook_url.startswith(("https://discord.com/api/webhooks/",
                                                   "https://discordapp.com/api/webhooks/")):
        print("DISCORD_WEBHOOK_URL の形式が正しくありません（https://discord.com/api/webhooks/ で始まるURL）。")
        return 1

    if args.test:
        messages = [{"username": BOT_NAME, "content": "✅ 荘園新報の通知テストです。この設定で新着ニュースが届きます。"}]
    else:
        if args.old is None:
            parser.error("--old（更新前の news.json）を指定してください")
        items, reason = find_new_items(args.old, args.new, categories)
        if reason:
            print(reason)
            return 0
        if not items:
            print("通知する新着ニュースはありません。")
            return 0
        messages = build_messages(items, portal_url)
        print(f"新着 {len(items)} 件を通知します。")

    for message in messages:
        if args.dry_run:
            print(json.dumps(message, ensure_ascii=False, indent=2))
            continue
        post(webhook_url, message)
        time.sleep(1)  # 連投で制限にかからないよう少し待つ
    print("完了しました。" if not args.dry_run else "--dry-run のため送信していません。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
