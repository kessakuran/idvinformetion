#!/usr/bin/env python3
"""第五人格（Identity V）ニュース収集スクリプト

公式サイトのお知らせ一覧から記事を集め、カテゴリを判定して data/news.json に保存します。

使い方:
    pip install -r requirements.txt
    python fetcher.py                # 取得して data/news.json を更新
    python fetcher.py --dry-run      # 保存せずに取得結果だけ表示
    python fetcher.py --pages 3      # 各一覧を3ページ分さかのぼる
    python fetcher.py --no-detail    # 記事本文を開かない（サマリーなし・高速）

取得元を増やすときは NewsSource を継承したクラスを作り、build_sources() に追加します。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import time
import unicodedata
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterator
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup, Tag
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    import lxml  # noqa: F401  （速くて壊れたHTMLに強い。無ければ標準パーサを使う）

    HTML_PARSER = "lxml"
except ImportError:
    HTML_PARSER = "html.parser"

# ===========================================================================
# 設定
# ===========================================================================
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT = BASE_DIR / "data" / "news.json"
JST = timezone(timedelta(hours=9))

# 公開運用するときは、取得先の管理者が連絡できるよう自分のサイトURLに書き換えてください。
USER_AGENT = "IdentityVNewsPortal/1.0 (+https://example.com/)"

REQUEST_DELAY_SEC = 1.5   # 同じサイトへ続けてアクセスするときの間隔（秒）
REQUEST_TIMEOUT_SEC = 15
SUMMARY_MAX_CHARS = 110  # カードに出す要約の長さ
DETAIL_MAX_CHARS = 1200  # 詳細ポップアップに出す本文抜粋の長さ
MAX_ITEMS = 200           # news.json に残す最大件数

# フロントエンド（script.js の CATEGORIES）と同じキー
CATEGORIES = ("maintenance", "update", "event", "other")

# タイトルに含まれる語でカテゴリを判定する。上から順に評価し、最初に当たったものを採用。
CATEGORY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("maintenance", ("メンテナンス", "メンテ", "障害", "不具合", "お詫び", "補填", "補償")),
    ("event", ("コラボ", "イベント", "キャンペーン", "記念", "開催", "生放送", "大会", "フェス")),
    ("update", ("アップデート", "アプデ", "更新", "実装", "新キャラ", "新ハンター", "新サバイバー", "バランス調整")),
]

# タグ（絞り込み用）。タイトルと要約に語が含まれていれば付く。1記事に複数付いてもよい。
# 毎回すべての記事に付け直すので、ここを編集すれば次の実行で過去の記事にも反映されます。
TAG_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("コラボ", ("コラボ",)),
    ("新キャラ", ("新キャラ", "新ハンター", "新サバイバー")),
    ("衣装・ガチャ", ("衣装", "ガチャ", "真髄", "コスチューム", "アクセサリ")),
    ("バランス調整", ("バランス調整", "上方修正", "下方修正", "キャラクター調整")),
    ("不具合", ("不具合", "障害", "バグ")),
    ("補填・お詫び", ("補填", "補償", "お詫び")),
    ("キャンペーン", ("キャンペーン", "プレゼント", "募集", "抽選", "コンテスト")),
    ("ゲームモード", ("モード", "1V4", "2V8")),
    ("ランク戦", ("ランク戦", "ランクマッチ", "段位")),
    ("大会・eスポーツ", ("大会", "IVL", "COA", "IJL", "リーグ", "eスポーツ")),
    ("生放送", ("生放送", "番組", "配信")),
    ("違反処罰", ("違反", "処罰", "BAN")),
]

# サマリーに入れない定型文（あいさつ・日付だけの行など）
BOILERPLATE_PATTERNS = [
    re.compile(p)
    for p in (
        r"^いつも.*ありがとうございま",
        r"^.{0,20}(ご利用|ご愛顧|お楽しみ).*ありがとうございま",
        r"運営(チーム|事務局)?です。?$",
        r"^平素より",
        r"^(詳細|詳しく)は.*(ご確認|ご覧)ください",
        r"^(親愛なる)?(荘園の)?(探偵|プレイヤー|ユーザー)?の?(皆様|皆さん|みなさま)",
        r"^20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?$",
        r"^(TOP|トップ|ホーム|お知らせ|ニュース|戻る|一覧へ戻る|シェア|前へ|次へ)$",
    )
]

log = logging.getLogger("fetcher")


# ===========================================================================
# データ構造
# ===========================================================================
@dataclass
class NewsItem:
    id: str
    category: str
    title: str
    date: str          # YYYY-MM-DD
    summary: str
    url: str
    source: str
    detail: str = ""   # 詳細ポップアップ用の本文抜粋（段落は改行で区切る）
    tags: list[str] = field(default_factory=list)
    is_sample: bool = False

    @classmethod
    def from_dict(cls, data: dict) -> NewsItem | None:
        try:
            raw_tags = data.get("tags") or []
            item = cls(
                id=str(data["id"]),
                category=data.get("category") if data.get("category") in CATEGORIES else "other",
                title=str(data["title"]).strip(),
                date=str(data["date"]),
                summary=str(data.get("summary", "")),
                url=str(data["url"]),
                source=str(data.get("source", "")),
                detail=str(data.get("detail", "")),
                tags=[str(t) for t in raw_tags] if isinstance(raw_tags, list) else [],
                is_sample=bool(data.get("is_sample", False)),
            )
        except (KeyError, TypeError):
            return None
        return item if item.title and item.url else None

    def to_dict(self) -> dict:
        data = asdict(self)
        if not self.is_sample:
            data.pop("is_sample")
        return data


# ===========================================================================
# 共通ユーティリティ
# ===========================================================================
DATE_RE = re.compile(r"(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})")
COMPACT_DATE_RE = re.compile(r"^(20\d{2})(\d{2})(\d{2})$")
TRAILING_DATE_RE = re.compile(r"\s*20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s*$")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?])\s*")
INLINE_TAGS = ["span", "strong", "b", "em", "i", "u", "a", "font", "small", "mark", "sup", "sub", "ruby", "rt", "rp", "label"]
GENERIC_LINK_TEXT = {"詳細", "詳しく見る", "詳細を見る", "続きを読む", "もっと見る", "more", "MORE", "READ MORE"}


def make_id(key: str) -> str:
    """URL などから安定した短いIDを作る（同じ記事なら毎回同じID）"""
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def parse_date(text: str | None) -> str | None:
    """'2026-10-28' / '2026/10/28' / '2026年10月28日' / '20261028' を YYYY-MM-DD に"""
    if not text:
        return None
    match = COMPACT_DATE_RE.match(text.strip()) or DATE_RE.search(text)
    if not match:
        return None
    try:
        return date(int(match[1]), int(match[2]), int(match[3])).isoformat()
    except ValueError:
        return None


def squash_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def truncate(text: str, max_chars: int) -> str:
    text = squash_spaces(text)
    return text if len(text) <= max_chars else text[: max_chars - 1].rstrip() + "…"


def classify(title: str, fallback: str | None = None) -> str:
    """タイトルのキーワード → 取得元の区分（fallback）→ その他、の順で判定"""
    for category, keywords in CATEGORY_KEYWORDS:
        if any(keyword in title for keyword in keywords):
            return category
    return fallback if fallback in CATEGORIES else "other"


def _nfkc_upper(text: str) -> str:
    return unicodedata.normalize("NFKC", text).upper()


def compute_tags(item: NewsItem) -> list[str]:
    """TAG_RULES に従ってタイトルと要約からタグを付ける（全角/半角・大文字/小文字は区別しない）"""
    text = _nfkc_upper(f"{item.title} {item.summary}")
    return [tag for tag, keywords in TAG_RULES if any(_nfkc_upper(k) in text for k in keywords)]


def _is_boilerplate(sentence: str) -> bool:
    return any(p.search(sentence) for p in BOILERPLATE_PATTERNS)


def extract_article(soup: BeautifulSoup, title: str = "", selectors: tuple[str, ...] = (),
                    summary_chars: int = SUMMARY_MAX_CHARS,
                    detail_chars: int = DETAIL_MAX_CHARS) -> tuple[str, str]:
    """記事ページから（カード用の要約, 詳細ポップアップ用の本文抜粋）を取り出す（あいさつ文は飛ばす）"""
    meta = soup.find("meta", attrs={"name": "description"}) or soup.find("meta", attrs={"property": "og:description"})
    meta_text = squash_spaces(meta.get("content", "")) if meta else ""

    for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "button"]):
        tag.decompose()

    container = None
    for selector in selectors:
        node = soup.select_one(selector)
        if node and len(node.get_text(strip=True)) >= 40:
            container = node
            break
    container = container or soup.body or soup

    # 文中の <strong> や <span> で文が途切れないよう、インライン要素を外してから行に分ける
    for br in container.find_all("br"):
        br.replace_with("\n")
    for tag in container.find_all(INLINE_TAGS):
        tag.unwrap()
    container.smooth()

    # 行（段落）ごとに、定型文の文だけを取り除いて残す
    title_key = re.sub(r"\s", "", title)
    lines: list[str] = []
    for raw_line in container.get_text("\n").splitlines():
        line = squash_spaces(raw_line)
        if not line or re.sub(r"\s", "", line) == title_key:
            continue
        kept = [s.strip() for s in SENTENCE_SPLIT_RE.split(line) if s.strip() and not _is_boilerplate(s.strip())]
        if kept:
            lines.append("".join(kept))

    # 要約：6文字以上の行から、文単位で先頭から詰める
    summary = ""
    sentences = (s.strip() for line in lines if len(line) >= 6 for s in SENTENCE_SPLIT_RE.split(line))
    for sentence in filter(None, sentences):
        if len(summary) + len(sentence) > summary_chars:
            if not summary:
                summary = truncate(sentence, summary_chars)
            break
        summary += sentence
    summary = summary or truncate(meta_text, summary_chars)

    # 本文抜粋：段落を保ったまま detail_chars 文字まで
    detail_lines: list[str] = []
    total = 0
    for line in lines:
        if total + len(line) > detail_chars:
            rest = detail_chars - total
            detail_lines.append(truncate(line, rest) if rest > 20 else "…")
            break
        detail_lines.append(line)
        total += len(line)
    detail = "\n".join(detail_lines) or summary
    return summary, detail


# ===========================================================================
# HTTP クライアント（リトライ・アクセス間隔・robots.txt の確認）
# ===========================================================================
class HttpClient:
    def __init__(self, delay: float = REQUEST_DELAY_SEC, timeout: float = REQUEST_TIMEOUT_SEC,
                 user_agent: str = USER_AGENT) -> None:
        self.delay = delay
        self.timeout = timeout
        self.user_agent = user_agent
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent, "Accept-Language": "ja,en;q=0.7"})
        retry = Retry(total=3, backoff_factor=1.0, status_forcelist=(429, 500, 502, 503, 504),
                      allowed_methods=("GET", "HEAD"), respect_retry_after_header=True)
        adapter = HTTPAdapter(max_retries=retry)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self._robots: dict[str, RobotFileParser] = {}
        self._last_request = 0.0

    def _wait(self) -> None:
        remaining = self.delay - (time.monotonic() - self._last_request)
        if remaining > 0:
            time.sleep(remaining)
        self._last_request = time.monotonic()

    def allowed(self, url: str) -> bool:
        """robots.txt で禁止されているURLには取りに行かない"""
        parts = urlparse(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            parser = RobotFileParser()
            try:
                self._wait()
                resp = self.session.get(f"{origin}/robots.txt", timeout=self.timeout)
                if resp.status_code in (401, 403):
                    parser.disallow_all = True
                elif resp.ok:
                    parser.parse(resp.text.splitlines())
                else:
                    parser.allow_all = True  # robots.txt が無い
            except requests.RequestException as exc:
                log.warning("robots.txt を確認できませんでした（%s）: %s", origin, exc)
                parser.allow_all = True
            self._robots[origin] = parser
        return self._robots[origin].can_fetch(self.user_agent, url)

    def get(self, url: str) -> requests.Response | None:
        if not self.allowed(url):
            log.warning("robots.txt で禁止されているため取得しません: %s", url)
            return None
        self._wait()
        try:
            resp = self.session.get(url, timeout=self.timeout)
            if resp.status_code == 404:
                log.info("ページがありません（404）: %s", url)  # 一覧の最終ページの先など、よくあること
                return None
            resp.raise_for_status()
        except requests.RequestException as exc:
            log.error("取得に失敗しました: %s（%s）", url, exc)
            return None
        if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
            resp.encoding = resp.apparent_encoding  # 文字化け対策
        return resp

    def soup(self, url: str) -> BeautifulSoup | None:
        resp = self.get(url)
        return BeautifulSoup(resp.text, HTML_PARSER) if resp is not None else None


# ===========================================================================
# 取得元（ソース）
# ===========================================================================
class NewsSource(ABC):
    """取得元の基底クラス。fetch() で NewsItem のリストを返す。"""

    name = "unknown"

    def __init__(self, client: HttpClient) -> None:
        self.client = client

    @abstractmethod
    def fetch(self, known: dict[str, NewsItem]) -> list[NewsItem]:
        """known は保存済みの記事（id → NewsItem）。本文の再取得を省くのに使う。"""


class IdentityVOfficialSource(NewsSource):
    """Identity V 第五人格 公式サイト（日本語版）のお知らせ一覧

    一覧ページのHTMLの細かい構造（class名）に依存しないよう、
    「記事URLの形 /jp/news/<区分>/<YYYYMMDD>/<番号>.html に一致するリンク」を拾います。
    サイトが変わったときは BASE_URL・SECTIONS・ARTICLE_PATH_RE を直せば対応できます。
    """

    name = "公式サイト"
    BASE_URL = "https://www.identityvgame.com/jp/news/"

    # 公式の区分 → このサイトのカテゴリ（タイトルで判定できなかったときの既定値）
    SECTIONS = {
        "announcement": "maintenance",  # メンテナンス
        "update": "update",             # アップデート
        "official": "other",            # お知らせ
    }
    ARTICLE_PATH_RE = re.compile(r"/jp/news/(?P<section>[a-z]+)/(?P<date>\d{8})/[\w-]+\.html$")
    CONTENT_SELECTORS = (
        ".article-content", ".news-content", ".news-detail", ".article", ".detail",
        "article", ".content", "#content", "main",
    )

    def __init__(self, client: HttpClient, pages: int = 1, fetch_detail: bool = True) -> None:
        super().__init__(client)
        self.pages = max(1, pages)
        self.fetch_detail = fetch_detail

    def list_urls(self, section: str) -> Iterator[str]:
        yield urljoin(self.BASE_URL, f"{section}/index.html")
        for page in range(2, self.pages + 1):
            yield urljoin(self.BASE_URL, f"{section}/index_{page}.html")

    def fetch(self, known: dict[str, NewsItem]) -> list[NewsItem]:
        found: dict[str, NewsItem] = {}
        for section in self.SECTIONS:
            for list_url in self.list_urls(section):
                soup = self.client.soup(list_url)
                if soup is None:
                    break
                items = self.parse_list(soup, list_url)
                if not items:
                    log.warning("記事リンクが見つかりません（ページ構造が変わった可能性）: %s", list_url)
                    break
                log.info("  %s: %d 件", list_url, len(items))
                for item in items:
                    found.setdefault(item.id, item)

        for item in found.values():
            previous = known.get(item.id)
            if previous and previous.summary and previous.detail:
                # 取得済みの記事は本文を開き直さない
                item.summary, item.detail = previous.summary, previous.detail
            elif self.fetch_detail:
                item.summary, item.detail = self.fetch_article(item)
        return list(found.values())

    def parse_list(self, soup: BeautifulSoup, base_url: str) -> list[NewsItem]:
        results: dict[str, NewsItem] = {}
        for anchor in soup.find_all("a", href=True):
            url = urljoin(base_url, anchor["href"].strip())
            path = urlparse(url).path
            match = self.ARTICLE_PATH_RE.search(path)
            if not match:
                continue

            title = link_title(anchor)
            if not title:
                continue
            item_date = parse_date(match["date"]) or parse_date(anchor.get_text(" "))
            if not item_date:
                continue

            # 同じ記事が複数ホスト（www.identityvgame.com / idv.163.com）に載るのでパスでIDを作る
            item_id = make_id(path)
            current = results.get(item_id)
            if current and len(current.title) >= len(title):
                continue  # 画像リンクとテキストリンクの重複などは長いタイトルを残す
            results[item_id] = NewsItem(
                id=item_id,
                category=classify(title, self.SECTIONS.get(match["section"])),
                title=title,
                date=item_date,
                summary="",
                url=url,
                source=self.name,
            )
        return list(results.values())

    def fetch_article(self, item: NewsItem) -> tuple[str, str]:
        soup = self.client.soup(item.url)
        if soup is None:
            return "", ""
        return extract_article(soup, item.title, self.CONTENT_SELECTORS)


DATE_CLASS_RE = re.compile(r"(?:.*[-_])?(?:date|datetime|time|day|pubdate|posted)(?:[-_].*)?", re.I)


def _in_date_element(node: Tag, stop: Tag) -> bool:
    """文字列が日付用の要素（<time> や class="date" / "news-date" など）の中にあるか
    ※ "update" のような語を誤って日付扱いしないよう、class 名の区切りで判定する"""
    while node is not None and node is not stop:
        if node.name == "time":
            return True
        if any(DATE_CLASS_RE.fullmatch(cls) for cls in node.get("class", [])):
            return True
        node = node.parent
    return False


def _title_from(element: Tag, exclude: Tag | None = None) -> str:
    titled = element.select_one('[class*="title"], [class*="tit"], h2, h3, h4')
    if titled and titled.get_text(strip=True):
        return squash_spaces(titled.get_text(" "))
    if element.get("title"):
        return squash_spaces(element["title"])
    parts = [
        s for s in element.find_all(string=True)
        if not _in_date_element(s.parent, element.parent)
        and not (exclude is not None and exclude in s.parents)  # 「詳しく見る」リンク自体の文字は除く
    ]
    return TRAILING_DATE_RE.sub("", squash_spaces(" ".join(parts)))


def link_title(anchor: Tag) -> str:
    """一覧のリンクから記事タイトルを取り出す。「詳しく見る」等のリンクなら親要素から探す。"""
    title = _title_from(anchor)
    if len(title) < 4 or title in GENERIC_LINK_TEXT:
        parent = anchor.find_parent(["li", "article", "tr", "div"])
        title = _title_from(parent, exclude=anchor) if parent is not None else ""
    return title if len(title) >= 4 and title not in GENERIC_LINK_TEXT else ""


class RssSource(NewsSource):
    """RSS / Atom フィードを読む汎用ソース（拡張用の例）

    keywords を渡すと、その語を含む記事だけを残します。
    ゲームメディアのフィードから第五人格の記事だけ拾う、といった使い方を想定しています。
    ※ フィードの解析には lxml が必要です。
    """

    def __init__(self, client: HttpClient, feed_url: str, name: str,
                 keywords: tuple[str, ...] = (), default_category: str | None = None) -> None:
        super().__init__(client)
        self.feed_url = feed_url
        self.name = name
        self.keywords = keywords
        self.default_category = default_category

    def fetch(self, known: dict[str, NewsItem]) -> list[NewsItem]:
        if HTML_PARSER != "lxml":
            log.warning("%s: RSS の解析には lxml が必要です（pip install lxml）", self.name)
            return []
        resp = self.client.get(self.feed_url)
        if resp is None:
            return []

        feed = BeautifulSoup(resp.content, "xml")
        items: list[NewsItem] = []
        for entry in feed.find_all(["item", "entry"]):
            title = squash_spaces(entry.title.get_text()) if entry.title else ""
            link = entry.find("link")
            url = (link.get("href") or link.get_text(strip=True)) if link else ""
            body = entry.find(["description", "summary", "content"])
            text = BeautifulSoup(body.get_text(), HTML_PARSER).get_text("") if body else ""
            if not title or not url:
                continue
            if self.keywords and not any(k in f"{title} {text}" for k in self.keywords):
                continue
            published = entry.find(["pubDate", "published", "updated"])
            item_date = parse_feed_date(published.get_text(strip=True) if published else "")
            if not item_date:
                continue
            items.append(NewsItem(
                id=make_id(url),
                category=classify(title, self.default_category),
                title=title,
                date=item_date,
                summary=truncate(text, SUMMARY_MAX_CHARS),
                url=url,
                source=self.name,
                detail=truncate(text, DETAIL_MAX_CHARS),
            ))
        return items


def parse_feed_date(text: str) -> str | None:
    if not text:
        return None
    try:
        return parsedate_to_datetime(text).astimezone(JST).date().isoformat()  # RSS（RFC 822 形式）
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(JST).date().isoformat()  # Atom
    except ValueError:
        return parse_date(text)


def build_sources(client: HttpClient, args: argparse.Namespace) -> list[NewsSource]:
    """使う取得元の一覧。ここに追加すれば main() から自動で呼ばれます。"""
    sources: list[NewsSource] = [
        IdentityVOfficialSource(client, pages=args.pages, fetch_detail=not args.no_detail),
    ]
    # 例：ゲームメディアのRSSから第五人格の記事だけを追加する
    # sources.append(RssSource(client, "https://example.com/feed.xml", name="Example",
    #                          keywords=("第五人格", "Identity V", "IdentityV")))
    return sources


# ===========================================================================
# 保存（既存データとのマージ・重複排除・安全な書き込み）
# ===========================================================================
class NewsStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> tuple[dict, list[NewsItem]]:
        if not self.path.exists():
            return {}, []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("%s を読み込めませんでした（%s）。新しく作り直します。", self.path, exc)
            return {}, []
        raw_items = data.get("items", []) if isinstance(data, dict) else data
        items = [NewsItem.from_dict(d) for d in raw_items if isinstance(d, dict)]
        meta = data.get("meta", {}) if isinstance(data, dict) else {}
        return meta, [i for i in items if i is not None]

    @staticmethod
    def merge(existing: list[NewsItem], fresh: list[NewsItem], max_items: int) -> list[NewsItem]:
        """新しく取得した記事で上書きしつつ、一覧から消えた古い記事も残す"""
        merged = {item.id: item for item in existing}
        for item in fresh:
            previous = merged.get(item.id)
            if previous and not item.summary:
                item.summary = previous.summary
            if previous and not item.detail:
                item.detail = previous.detail
            merged[item.id] = item
        # 新しい順（同じ日付は取得順を保つ）
        ordered = sorted(merged.values(), key=lambda i: i.date, reverse=True)
        return ordered[:max_items]

    def save(self, items: list[NewsItem], sources: list[str]) -> None:
        payload = {
            "meta": {
                "updated_at": datetime.now(JST).isoformat(timespec="seconds"),
                "source": "live",
                "sources": sources,
                "count": len(items),
            },
            "items": [item.to_dict() for item in items],
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # 一時ファイルに書いてから置き換える（書き込み途中で読まれても壊れない）
        fd, tmp_path = tempfile.mkstemp(dir=self.path.parent, prefix=".news-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            os.chmod(tmp_path, 0o644)  # Webサーバーから読めるように
            os.replace(tmp_path, self.path)
        except BaseException:
            Path(tmp_path).unlink(missing_ok=True)
            raise


# ===========================================================================
# メイン
# ===========================================================================
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="第五人格の最新ニュースを取得して news.json に保存します。")
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT, help="保存先（既定: data/news.json）")
    parser.add_argument("--pages", type=int, default=1, help="各一覧を何ページさかのぼるか（既定: 1）")
    parser.add_argument("--max-items", type=int, default=MAX_ITEMS, help=f"保存する最大件数（既定: {MAX_ITEMS}）")
    parser.add_argument("--delay", type=float, default=REQUEST_DELAY_SEC, help="アクセス間隔の秒数")
    parser.add_argument("--no-detail", action="store_true", help="記事ページを開かない（サマリーなし）")
    parser.add_argument("--keep-samples", action="store_true", help="サンプルデータを消さずに残す")
    parser.add_argument("--force", action="store_true", help="内容に変化がなくても保存し直す")
    parser.add_argument("--dry-run", action="store_true", help="保存せずに結果を表示する")
    parser.add_argument("-v", "--verbose", action="store_true", help="詳しいログを出す")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    store = NewsStore(args.output)
    meta, existing = store.load()
    if not args.keep_samples:
        if meta.get("source") == "sample":
            existing = []  # 初回の取得でサンプルデータを丸ごと置き換える
        existing = [item for item in existing if not item.is_sample]
    known = {item.id: item for item in existing}

    client = HttpClient(delay=args.delay)
    fresh: list[NewsItem] = []
    succeeded: list[str] = []
    for source in build_sources(client, args):
        log.info("%s から取得しています…", source.name)
        try:
            items = source.fetch(known)
        except Exception:  # 1つの取得元が失敗しても他は続ける
            log.exception("%s の取得中にエラーが発生しました", source.name)
            continue
        log.info("%s: %d 件", source.name, len(items))
        if items:
            fresh.extend(items)
            succeeded.append(source.name)

    if not fresh:
        log.error("ニュースを1件も取得できませんでした。%s は変更しません。", args.output)
        return 1

    merged = NewsStore.merge(existing, fresh, args.max_items)
    for item in merged:
        item.tags = compute_tags(item)  # TAG_RULES の変更を過去の記事にも反映する
    new_ids = {item.id for item in fresh} - set(known)

    if args.dry_run:
        for item in merged:
            mark = "＋" if item.id in new_ids else "　"
            tags = f"  #{' #'.join(item.tags)}" if item.tags else ""
            print(f"{mark} {item.date} [{item.category:<11}] {item.title}{tags}")
        print(f"\n合計 {len(merged)} 件（新規 {len(new_ids)} 件）。--dry-run のため保存していません。")
        return 0

    before = [item.to_dict() for item in existing]
    after = [item.to_dict() for item in merged]
    if before == after and meta.get("source") == "live" and not args.force:
        log.info("変更はありません。%s はそのままです。", args.output)
        return 0

    store.save(merged, succeeded)
    log.info("保存しました: %s（%d 件、うち新規 %d 件）", args.output, len(merged), len(new_ids))
    return 0


if __name__ == "__main__":
    sys.exit(main())
