/**
 * 荘園新報 — フロントエンド
 *
 * data/news.json を読み込み、カテゴリタブ・高度な検索・タグ/期間の絞り込み・
 * お気に入り（ブラウザの localStorage に保存）・詳細ポップアップを扱います。
 * 絞り込み状態と開いている記事は URL（?cat=update&tag=コラボ&id=…）にも反映されるので、そのまま共有できます。
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // 設定
  // ------------------------------------------------------------------
  const CONFIG = {
    dataUrl: 'data/news.json',
    pageSize: 12,      // 一度に表示する件数（「さらに表示」で追加）
    newBadgeDays: 3,   // 掲載から何日以内を「新着」にするか
    debounceMs: 150,   // 検索入力の待ち時間
    cardTags: 3,       // カードに表示するタグの最大数
    storageKey: 'shoen-shinpo:bookmarks:v1', // お気に入りの保存先（localStorage のキー）
  };

  // カテゴリ定義。キーは fetcher.py の CATEGORIES と揃えてください。
  // seal は封蝋（カテゴリ印）に入れる一文字です。
  const CATEGORIES = {
    maintenance: { label: 'メンテナンス', seal: '整' },
    update: { label: 'アプデ情報', seal: '新' },
    event: { label: 'イベント/コラボ', seal: '祭' },
    other: { label: 'その他', seal: '報' },
  };

  // 掲載日の絞り込み（days: 今日から何日前まで）
  const PERIODS = {
    all: { label: 'すべて', days: null },
    7: { label: '1週間以内', days: 7 },
    30: { label: '1か月以内', days: 30 },
    90: { label: '3か月以内', days: 90 },
    365: { label: '1年以内', days: 365 },
  };

  const ALL = 'all';
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  const state = {
    items: [],
    byId: new Map(),
    tagOrder: [],          // 件数の多い順のタグ一覧
    loaded: false,
    category: ALL,
    query: '',
    tags: new Set(),
    tagMode: 'all',        // 'all' = すべて含む / 'any' = どれかを含む
    period: ALL,
    sort: 'new',
    favOnly: false,
    limit: CONFIG.pageSize,
    results: [],           // いま表示対象になっている記事（ポップアップの前後移動に使う）
    terms: [],             // ハイライトする語
    openId: null,          // ポップアップで開いている記事
  };

  const $ = (selector) => document.querySelector(selector);
  const els = {
    grid: $('#news'),
    tablist: $('[role="tablist"]'),
    tabs: Array.from(document.querySelectorAll('[role="tab"]')),
    search: $('#search-input'),
    clear: $('#search-clear'),
    status: $('#result-status'),
    empty: $('#empty-state'),
    emptyTitle: $('#empty-title'),
    emptyMessage: $('#empty-message'),
    reset: $('#reset-filters'),
    error: $('#error-state'),
    errorMessage: $('#error-message'),
    retry: $('#retry'),
    more: $('#load-more'),
    updatedAt: $('#updated-at'),
    sampleNotice: $('#sample-notice'),
    template: $('#card-template'),
    // 絞り込み
    filterToggle: $('#filter-toggle'),
    filterBadge: $('#filter-badge'),
    filterPanel: $('#filter-panel'),
    favToggle: $('#fav-toggle'),
    favCount: $('#fav-count'),
    sortSelect: $('#sort-select'),
    tagList: $('#tag-list'),
    tagModeInputs: Array.from(document.querySelectorAll('input[name="tag-mode"]')),
    periodList: $('#period-list'),
    activeFilters: $('#active-filters'),
    activeFilterList: $('#active-filter-list'),
    clearAll: $('#clear-all'),
    // ポップアップ
    modal: $('#detail'),
    modalSeal: $('#detail .seal'),
    modalCategory: $('#detail .modal__category'),
    modalDate: $('#detail .modal__date'),
    modalNew: $('#detail .modal__new'),
    modalTitle: $('#modal-title'),
    modalTags: $('#detail .modal__tags'),
    modalBody: $('#detail .modal__body'),
    modalMeta: $('#detail .modal__meta'),
    modalBookmark: $('#detail .bookmark'),
    modalLink: $('#detail .modal__link'),
    modalPrev: $('#modal-prev'),
    modalNext: $('#modal-next'),
    modalPosition: $('#modal-position'),
    copyLink: $('#copy-link'),
    toast: $('#toast'),
  };

  // ------------------------------------------------------------------
  // 文字列・日付ユーティリティ
  // ------------------------------------------------------------------

  /** 検索用の正規化：全角/半角・大文字/小文字・カタカナ/ひらがなの違いを吸収する */
  function toSearchable(text) {
    return String(text ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }

  /** "YYYY-MM-DD" をローカル日付として解釈する */
  function parseDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function toIsoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatDate(d) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
  }

  function formatDateTime(d) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function startOfToday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }

  function isRecent(d, days) {
    return (startOfToday() - d) / 86400000 <= days;
  }

  /** http(s) 以外のリンク（javascript: など）は表示しない */
  function safeUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function hashString(text) {
    let h = 0;
    for (const ch of text) h = (Math.imul(31, h) + ch.codePointAt(0)) | 0;
    return (h >>> 0).toString(36);
  }

  function debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  // ------------------------------------------------------------------
  // 検索語の解析
  //   スペース区切り = AND / OR か | = OR / -語 = 除外 / "語句" = そのまま / #タグ = タグ
  // ------------------------------------------------------------------
  function parseQuery(query) {
    const parsed = { groups: [], excludes: [], tags: [], highlights: [] };
    const text = String(query ?? '').normalize('NFKC');
    const tokenRe = /(-?)"([^"]+)"|(\S+)/g;
    let joinNext = false;

    for (const m of text.matchAll(tokenRe)) {
      let word;
      let negative;
      let quoted = false;
      if (m[2] !== undefined) {
        word = m[2];
        negative = m[1] === '-';
        quoted = true;
      } else {
        word = m[3];
        if (word === 'OR' || word === '|') {
          joinNext = parsed.groups.length > 0;
          continue;
        }
        negative = word.length > 1 && word.startsWith('-');
        if (negative) word = word.slice(1);
      }

      if (!quoted && !negative && word.startsWith('#') && word.length > 1) {
        parsed.tags.push(toSearchable(word.slice(1)));
        joinNext = false;
        continue;
      }

      const alternatives = (quoted ? [word] : word.split('|'))
        .map((w) => toSearchable(w).trim())
        .filter(Boolean);
      if (!alternatives.length) continue;

      if (negative) {
        parsed.excludes.push(...alternatives);
      } else {
        if (joinNext) parsed.groups[parsed.groups.length - 1].push(...alternatives);
        else parsed.groups.push(alternatives);
        parsed.highlights.push(...alternatives);
      }
      joinNext = false;
    }
    return parsed;
  }

  function isEmptyQuery(parsed) {
    return !parsed.groups.length && !parsed.excludes.length && !parsed.tags.length;
  }

  function matchesQuery(item, parsed) {
    return parsed.groups.every((group) => group.some((t) => item.haystack.includes(t))) &&
      !parsed.excludes.some((t) => item.haystack.includes(t)) &&
      parsed.tags.every((t) => item.tagKeys.some((k) => k.includes(t)));
  }

  // ------------------------------------------------------------------
  // お気に入り（localStorage に保存。消えた記事も表示できるよう中身ごと控える）
  // ------------------------------------------------------------------
  const bookmarks = (() => {
    let map = read();

    function read() {
      try {
        const data = JSON.parse(window.localStorage.getItem(CONFIG.storageKey) || 'null');
        return data && typeof data.items === 'object' && data.items ? data.items : {};
      } catch {
        return {};
      }
    }

    function write() {
      try {
        window.localStorage.setItem(CONFIG.storageKey, JSON.stringify({ version: 1, items: map }));
        return true;
      } catch {
        return false; // プライベートモードや容量不足。表示中だけは覚えておく
      }
    }

    return {
      has: (id) => has(map, id),
      count: () => Object.keys(map).length,
      snapshots: () => Object.values(map),
      reload() { map = read(); },
      /** 追加/削除して、{ saved: 追加されたか, persisted: 保存できたか } を返す */
      toggle(item) {
        if (has(map, item.id)) {
          delete map[item.id];
        } else {
          map[item.id] = {
            id: item.id,
            title: item.title,
            date: toIsoDate(item.date),
            category: item.category,
            summary: item.summary,
            detail: item.detail,
            url: item.url,
            source: item.source,
            tags: item.tags,
            saved_at: new Date().toISOString(),
          };
        }
        return { saved: has(map, item.id), persisted: write() };
      },
    };
  })();

  // ------------------------------------------------------------------
  // データ読み込み
  // ------------------------------------------------------------------

  /** JSON の1件を画面用の形に整える。必須項目が欠けていれば null */
  function normalizeItem(raw, index, { saved = false } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title ?? '').trim();
    const date = parseDate(raw.date);
    if (!title || !date) return null;

    const category = has(CATEGORIES, raw.category) ? raw.category : 'other';
    const summary = String(raw.summary ?? '').trim();
    const detail = String(raw.detail ?? '').trim();
    const source = String(raw.source ?? '').trim();
    const url = safeUrl(raw.url);
    const tags = Array.isArray(raw.tags)
      ? [...new Set(raw.tags.map((t) => String(t).trim()).filter(Boolean))]
      : [];
    const id = String(raw.id ?? '').trim() || `x${hashString(url || title)}`;

    return {
      id,
      order: index,
      title,
      summary,
      detail,
      category,
      date,
      source,
      url,
      tags,
      tagKeys: tags.map(toSearchable),
      isSample: raw.is_sample === true,
      isSaved: saved, // 一覧から消えて、お気に入りの控えから復元した記事
      haystack: toSearchable([title, summary, detail, CATEGORIES[category].label, source, ...tags].join(' ')),
    };
  }

  async function loadNews() {
    els.grid.setAttribute('aria-busy', 'true');
    els.error.hidden = true;

    try {
      // 更新直後の古いキャッシュを避ける
      const response = await fetch(`${CONFIG.dataUrl}?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      const rawItems = Array.isArray(data) ? data : data?.items;
      if (!Array.isArray(rawItems)) throw new Error('items 配列が見つかりません');

      state.items = rawItems
        .map((raw, i) => normalizeItem(raw, i))
        .filter(Boolean)
        .sort((a, b) => b.date - a.date || a.order - b.order);
      state.byId = new Map(state.items.map((item) => [item.id, item]));
      state.tagOrder = countTags(state.items);
      state.loaded = true;

      renderMeta(Array.isArray(data) ? {} : data.meta ?? {});
      render();
      if (state.openId) openModal(state.openId, { fromUrl: true });
    } catch (error) {
      console.error('[news] 読み込みに失敗しました:', error);
      showError(error);
    } finally {
      els.grid.setAttribute('aria-busy', 'false');
    }
  }

  function countTags(items) {
    const counts = new Map();
    items.forEach((item) => item.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).map(([t]) => t);
  }

  function renderMeta(meta) {
    const updated = meta.updated_at ? new Date(meta.updated_at) : null;
    if (updated && !Number.isNaN(updated.getTime())) {
      els.updatedAt.textContent = `${formatDateTime(updated)} 更新`;
    } else {
      els.updatedAt.textContent = '';
    }
    els.sampleNotice.hidden = !(meta.source === 'sample' || state.items.some((item) => item.isSample));
  }

  function showError(error) {
    els.grid.replaceChildren();
    els.grid.hidden = true;
    els.status.textContent = '';
    els.more.hidden = true;
    els.empty.hidden = true;
    els.updatedAt.textContent = '';

    if (window.location.protocol === 'file:') {
      els.errorMessage.textContent =
        'index.html をファイルとして直接開くと、ブラウザの制限で data/news.json を読み込めません。' +
        'このフォルダで「python -m http.server 8000」を実行し、http://localhost:8000 を開いてください。';
    } else {
      els.errorMessage.textContent =
        `data/news.json の取得または解析に失敗しました（${error.message}）。` +
        'ファイルの場所と JSON の書式を確認してください。';
    }
    els.error.hidden = false;
  }

  // ------------------------------------------------------------------
  // 絞り込み
  // ------------------------------------------------------------------

  /** お気に入りだけを表示するときの対象。一覧から消えた記事は控えから復元する */
  function favoritePool() {
    const pool = state.items.filter((item) => bookmarks.has(item.id));
    bookmarks.snapshots().forEach((snap, i) => {
      if (state.byId.has(snap.id)) return;
      const item = normalizeItem(snap, 100000 + i, { saved: true });
      if (item) pool.push(item);
    });
    return pool.sort((a, b) => b.date - a.date || a.order - b.order);
  }

  function periodStart(period) {
    const days = PERIODS[period]?.days;
    if (!days) return null;
    const start = startOfToday();
    start.setDate(start.getDate() - days);
    return start;
  }

  function matchesTags(item) {
    if (!state.tags.size) return true;
    const selected = [...state.tags];
    return state.tagMode === 'any'
      ? selected.some((t) => item.tags.includes(t))
      : selected.every((t) => item.tags.includes(t));
  }

  function computeResults() {
    const parsed = parseQuery(state.query);
    const since = periodStart(state.period);
    const pool = state.favOnly ? favoritePool() : state.items;

    const base = pool.filter((item) => matchesQuery(item, parsed) && (!since || item.date >= since));
    const tagged = base.filter(matchesTags);
    const inCategory = (list) => (state.category === ALL ? list : list.filter((i) => i.category === state.category));

    let results = inCategory(tagged);
    if (state.sort === 'old') results = [...results].reverse();

    // タグごとの件数（タグ以外の条件に一致する記事のうち、そのタグが付いたもの）
    const tagCounts = new Map();
    inCategory(base).forEach((item) => item.tags.forEach((t) => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)));

    return { parsed, results, tagged, tagCounts, pool };
  }

  function hasAnyFilter(parsed) {
    return !isEmptyQuery(parsed) || state.tags.size > 0 || state.period !== ALL || state.favOnly;
  }

  // ------------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------------

  function render() {
    if (!state.loaded) return;

    const { parsed, results, tagged, tagCounts, pool } = computeResults();
    state.results = results;
    state.terms = parsed.highlights;
    updateCounts(tagged);
    renderTagList(tagCounts, pool);
    renderActiveFilters(parsed);
    updateFavoriteUi();

    const visible = results.slice(0, state.limit);

    // 何も絞り込んでいないときは、先頭（最新）の1件を大きく見せる
    const featureFirst = !hasAnyFilter(parsed) && state.category === ALL && state.sort === 'new';
    const fragment = document.createDocumentFragment();
    visible.forEach((item, i) => fragment.append(createCard(item, state.terms, featureFirst && i === 0)));
    els.grid.replaceChildren(fragment);
    els.grid.hidden = visible.length === 0;

    renderEmpty(results.length, parsed);

    const rest = results.length - visible.length;
    els.more.hidden = rest <= 0;
    if (rest > 0) els.more.textContent = `さらに表示（残り${rest}件）`;

    els.status.textContent = buildStatus(results.length, visible.length);
    if (state.openId) updateModalNav();
    syncUrl();
  }

  function updateCounts(list) {
    const counts = { [ALL]: list.length };
    Object.keys(CATEGORIES).forEach((key) => { counts[key] = 0; });
    list.forEach((item) => { counts[item.category] += 1; });
    document.querySelectorAll('[data-count]').forEach((el) => {
      el.textContent = String(counts[el.dataset.count] ?? 0);
    });
  }

  function renderTagList(tagCounts, pool) {
    const order = [...state.tagOrder];
    // お気に入りの控えにだけあるタグ・URL で指定されたタグも並べる
    countTags(pool).forEach((t) => { if (!order.includes(t)) order.push(t); });
    state.tags.forEach((t) => { if (!order.includes(t)) order.push(t); });

    if (!order.length) {
      const note = document.createElement('p');
      note.className = 'filter-group__hint';
      note.textContent = 'タグの付いた記事はまだありません。';
      els.tagList.replaceChildren(note);
      return;
    }

    const fragment = document.createDocumentFragment();
    order.forEach((tag) => {
      const selected = state.tags.has(tag);
      const count = tagCounts.get(tag) ?? 0;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip';
      chip.dataset.tag = tag;
      chip.setAttribute('aria-pressed', String(selected));
      if (!selected && count === 0) chip.classList.add('is-empty');
      chip.append(`#${tag}`);
      const num = document.createElement('span');
      num.className = 'tag-chip__count';
      num.textContent = String(count);
      chip.append(num);
      fragment.append(chip);
    });
    els.tagList.replaceChildren(fragment);
  }

  function renderPeriodList() {
    const fragment = document.createDocumentFragment();
    Object.entries(PERIODS).forEach(([value, { label }]) => {
      const wrap = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'period';
      input.value = value;
      input.checked = value === state.period;
      const span = document.createElement('span');
      span.textContent = label;
      wrap.append(input, span);
      fragment.append(wrap);
    });
    els.periodList.replaceChildren(fragment);
  }

  /** 適用中の条件を「×」で外せるチップとして並べる */
  function renderActiveFilters(parsed) {
    const chips = [];
    const query = state.query.trim();
    if (query) chips.push({ label: `検索「${query}」`, remove: () => clearSearch() });
    state.tags.forEach((tag) => chips.push({ label: `#${tag}`, remove: () => toggleTag(tag) }));
    if (state.tags.size > 1) {
      chips.push({ label: state.tagMode === 'any' ? 'タグ：どれかを含む' : 'タグ：すべて含む', remove: null });
    }
    if (state.period !== ALL) chips.push({ label: PERIODS[state.period].label, remove: () => setPeriod(ALL) });
    if (state.favOnly) chips.push({ label: 'お気に入りだけ', remove: () => setFavOnly(false) });

    const panelCount = state.tags.size + (state.period !== ALL ? 1 : 0);
    els.filterBadge.hidden = panelCount === 0;
    els.filterBadge.textContent = String(panelCount);

    els.activeFilters.hidden = chips.length === 0 && state.category === ALL;
    const fragment = document.createDocumentFragment();
    chips.forEach(({ label, remove }) => {
      const li = document.createElement('li');
      if (remove) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'active-chip';
        button.setAttribute('aria-label', `${label} の条件を外す`);
        button.append(label);
        const x = document.createElement('span');
        x.className = 'active-chip__x';
        x.setAttribute('aria-hidden', 'true');
        x.textContent = '×';
        button.append(x);
        button.addEventListener('click', remove);
        li.append(button);
      } else {
        li.className = 'active-chip active-chip--static';
        li.textContent = label;
      }
      fragment.append(li);
    });
    els.activeFilterList.replaceChildren(fragment);
  }

  function buildStatus(total, shown) {
    const scope = [];
    if (state.favOnly) scope.push('お気に入り');
    if (state.category !== ALL) scope.push(CATEGORIES[state.category].label);
    if (state.tags.size) scope.push([...state.tags].map((t) => `#${t}`).join(state.tagMode === 'any' ? ' または ' : ' '));
    if (state.period !== ALL) scope.push(PERIODS[state.period].label);
    if (state.query.trim()) scope.push(`「${state.query.trim()}」`);
    const head = scope.length ? `${scope.join(' × ')}：` : 'すべてのニュース：';
    const order = state.sort === 'old' ? '古い順' : '新しい順';
    const tail = total > shown ? `（${order}に${shown}件を表示中）` : '';
    return `${head}${total}件${tail}`;
  }

  function renderEmpty(total, parsed) {
    els.empty.hidden = total > 0;
    if (total > 0) return;

    const label = state.category === ALL ? '' : CATEGORIES[state.category].label;
    const filtered = hasAnyFilter(parsed);

    if (state.favOnly && bookmarks.count() === 0) {
      els.emptyTitle.textContent = 'お気に入りはまだありません';
      els.emptyMessage.textContent = 'カードの「☆ 保存」を押すと、この端末のブラウザに記事を保存できます。';
    } else if (state.items.length === 0 && !state.favOnly) {
      els.emptyTitle.textContent = 'まだニュースがありません';
      els.emptyMessage.textContent = 'fetcher.py を実行すると、公式サイトのお知らせが data/news.json に保存されます。';
    } else if (filtered) {
      els.emptyTitle.textContent = '条件に一致するニュースはありません';
      els.emptyMessage.textContent =
        '条件を減らすか、別の言葉で探してください。上の「×」で条件を1つずつ外せます。';
    } else {
      els.emptyTitle.textContent = `${label}のニュースはまだありません`;
      els.emptyMessage.textContent = '新しいお知らせが出ると、ここに表示されます。';
    }
    els.reset.hidden = !(filtered || state.category !== ALL);
  }

  function createCard(item, terms, featured) {
    const card = els.template.content.firstElementChild.cloneNode(true);
    const category = CATEGORIES[item.category];

    card.dataset.category = item.category;
    card.dataset.id = item.id;
    if (featured) card.classList.add('card--featured');

    card.querySelector('.seal').textContent = category.seal;
    card.querySelector('.card__category').textContent = category.label;

    const time = card.querySelector('.card__date');
    time.dateTime = toIsoDate(item.date);
    time.textContent = formatDate(item.date);
    card.querySelector('.card__new').hidden = !isRecent(item.date, CONFIG.newBadgeDays);

    const open = card.querySelector('.card__open');
    open.id = `title-${item.id}`;
    open.dataset.open = item.id;
    open.append(highlight(item.title, terms));
    card.setAttribute('aria-labelledby', open.id);

    const summary = card.querySelector('.card__summary');
    if (item.summary) {
      summary.append(highlight(item.summary, terms));
    } else {
      summary.remove();
    }

    const tagRow = card.querySelector('.card__tags');
    if (item.tags.length) {
      tagRow.append(...item.tags.slice(0, CONFIG.cardTags).map((t) => tagButton(t)));
    } else {
      tagRow.remove();
    }

    const bookmark = card.querySelector('.bookmark');
    bookmark.dataset.bookmark = item.id;
    setBookmarkButton(bookmark, bookmarks.has(item.id), { short: true });

    const link = card.querySelector('.card__link');
    if (item.url) {
      link.href = item.url;
      link.setAttribute('aria-describedby', open.id);
    } else {
      link.remove();
    }

    card.querySelector('.card__sample').hidden = !item.isSample;
    card.querySelector('.card__saved').hidden = !item.isSaved;
    return card;
  }

  function tagButton(tag) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tag';
    button.dataset.tag = tag;
    button.textContent = `#${tag}`;
    button.setAttribute('aria-pressed', String(state.tags.has(tag)));
    button.title = state.tags.has(tag) ? `#${tag} の絞り込みを外す` : `#${tag} で絞り込む`;
    li.append(button);
    return li;
  }

  function setBookmarkButton(button, saved, { short = false } = {}) {
    button.setAttribute('aria-pressed', String(saved));
    button.querySelector('.bookmark__label').textContent = saved
      ? (short ? '保存済み' : 'お気に入り登録済み')
      : (short ? '保存' : 'お気に入りに追加');
    button.title = saved ? 'お気に入りから外す' : 'お気に入りに追加する（この端末に保存）';
  }

  function updateFavoriteUi() {
    els.favCount.textContent = String(bookmarks.count());
    els.favToggle.setAttribute('aria-pressed', String(state.favOnly));
  }

  /**
   * 検索語に一致した部分を <mark> で囲んだ DocumentFragment を返す。
   * innerHTML を使わず、テキストノードとして組み立てるので安全。
   */
  function highlight(text, terms) {
    const fragment = document.createDocumentFragment();
    if (!terms.length) {
      fragment.append(text);
      return fragment;
    }

    // 正規化後の文字位置 → 元の文字位置 の対応表を作る
    let normalized = '';
    const starts = [];
    const ends = [];
    let pos = 0;
    for (const ch of text) {
      const n = toSearchable(ch);
      for (let i = 0; i < n.length; i += 1) {
        starts.push(pos);
        ends.push(pos + ch.length);
      }
      normalized += n;
      pos += ch.length;
    }

    const ranges = [];
    terms.forEach((term) => {
      let from = 0;
      let at = normalized.indexOf(term, from);
      while (at !== -1) {
        ranges.push([starts[at], ends[at + term.length - 1]]);
        from = at + term.length;
        at = normalized.indexOf(term, from);
      }
    });
    if (!ranges.length) {
      fragment.append(text);
      return fragment;
    }

    // 重なった範囲をまとめる
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    ranges.forEach(([s, e]) => {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    });

    let cursor = 0;
    merged.forEach(([s, e]) => {
      if (s > cursor) fragment.append(text.slice(cursor, s));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(s, e);
      fragment.append(mark);
      cursor = e;
    });
    if (cursor < text.length) fragment.append(text.slice(cursor));
    return fragment;
  }

  // ------------------------------------------------------------------
  // 詳細ポップアップ
  // ------------------------------------------------------------------
  let returnFocusId = null;

  function findItem(id) {
    if (state.byId.has(id)) return state.byId.get(id);
    return state.results.find((item) => item.id === id) ?? favoritePool().find((item) => item.id === id) ?? null;
  }

  function openModal(id, { fromUrl = false } = {}) {
    const item = findItem(id);
    if (!item) {
      state.openId = null;
      if (fromUrl) syncUrl();
      return;
    }
    state.openId = item.id;
    fillModal(item);
    if (!els.modal.open) {
      els.modal.showModal();
      document.documentElement.classList.add('has-modal');
    }
    els.modal.querySelector('.modal__scroll').scrollTop = 0;
    syncUrl();
  }

  function fillModal(item) {
    const category = CATEGORIES[item.category];
    els.modal.dataset.category = item.category;
    els.modalSeal.textContent = category.seal;
    els.modalCategory.textContent = category.label;
    els.modalDate.dateTime = toIsoDate(item.date);
    els.modalDate.textContent = formatDate(item.date);
    els.modalNew.hidden = !isRecent(item.date, CONFIG.newBadgeDays);

    els.modalTitle.replaceChildren(highlight(item.title, state.terms));
    els.modalTags.replaceChildren(...item.tags.map((t) => tagButton(t)));
    els.modalTags.hidden = item.tags.length === 0;

    // 本文抜粋（無ければ要約）。段落ごとに <p> にする
    const text = item.detail || item.summary;
    const paragraphs = text ? text.split(/\n+/).filter(Boolean) : [];
    if (paragraphs.length) {
      els.modalBody.replaceChildren(...paragraphs.map((line) => {
        const p = document.createElement('p');
        p.append(highlight(line, state.terms));
        return p;
      }));
    } else {
      const p = document.createElement('p');
      p.className = 'modal__empty';
      p.textContent = 'この記事の本文の抜粋はありません。公式の元記事でご確認ください。';
      els.modalBody.replaceChildren(p);
    }

    const meta = [];
    if (item.source) meta.push(`出典：${item.source}`);
    if (item.isSample) meta.push('表示確認用のサンプルデータです');
    if (item.isSaved) meta.push('一覧から消えた記事を、お気に入りの控えから表示しています');
    if (item.detail) meta.push('本文は冒頭の抜粋です。正確な内容は元記事でご確認ください');
    els.modalMeta.textContent = meta.join('　/　');

    setBookmarkButton(els.modalBookmark, bookmarks.has(item.id));
    els.modalBookmark.dataset.bookmark = item.id;

    if (item.url) {
      els.modalLink.href = item.url;
      els.modalLink.hidden = false;
    } else {
      els.modalLink.removeAttribute('href');
      els.modalLink.hidden = true;
    }
    updateModalNav();
  }

  function updateModalNav() {
    const index = state.results.findIndex((item) => item.id === state.openId);
    els.modalPrev.disabled = index <= 0;
    els.modalNext.disabled = index === -1 || index >= state.results.length - 1;
    els.modalPosition.textContent = index === -1 ? '' : `${index + 1} / ${state.results.length}`;
  }

  function moveModal(step) {
    const index = state.results.findIndex((item) => item.id === state.openId);
    const next = state.results[index + step];
    if (index === -1 || !next) return;
    // 表示件数の外まで進んだら、一覧も追いつかせる（閉じたときにカードへ戻れるように）
    if (index + step >= state.limit) {
      state.limit = Math.ceil((index + step + 1) / CONFIG.pageSize) * CONFIG.pageSize;
      render();
    }
    returnFocusId = next.id;
    openModal(next.id);
  }

  function onModalClosed() {
    state.openId = null;
    document.documentElement.classList.remove('has-modal');
    syncUrl();
    const target = returnFocusId && document.getElementById(`title-${returnFocusId}`);
    if (target) {
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    }
    returnFocusId = null;
  }

  async function copyCurrentLink() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      showToast('この記事のリンクをコピーしました');
    } catch {
      window.prompt('このリンクをコピーしてください', url);
    }
  }

  // ------------------------------------------------------------------
  // 小さなお知らせ表示
  // ------------------------------------------------------------------
  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    els.toast.classList.remove('is-leaving');
    toastTimer = setTimeout(() => {
      els.toast.classList.add('is-leaving');
      toastTimer = setTimeout(() => { els.toast.hidden = true; }, 250);
    }, 2400);
  }

  // ------------------------------------------------------------------
  // 操作
  // ------------------------------------------------------------------

  function selectCategory(category, { focus = false } = {}) {
    state.category = category;
    state.limit = CONFIG.pageSize;

    els.tabs.forEach((tab) => {
      const active = tab.dataset.category === category;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) {
        els.grid.setAttribute('aria-labelledby', tab.id);
        revealTab(tab);
        if (focus) tab.focus();
      }
    });
    render();
  }

  /** スマホで横スクロールしているタブを、選ばれたものが見える位置まで動かす */
  function revealTab(tab) {
    const list = els.tablist;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: Math.max(0, left - 24), behavior: 'smooth' });
    }
  }

  function setQuery(value) {
    state.query = value;
    state.limit = CONFIG.pageSize;
    els.clear.hidden = !value;
    render();
  }

  function clearSearch() {
    els.search.value = '';
    setQuery('');
  }

  function toggleTag(tag) {
    if (state.tags.has(tag)) state.tags.delete(tag);
    else state.tags.add(tag);
    state.limit = CONFIG.pageSize;
    render();
  }

  function setTagMode(mode) {
    state.tagMode = mode === 'any' ? 'any' : 'all';
    els.tagModeInputs.forEach((input) => { input.checked = input.value === state.tagMode; });
    state.limit = CONFIG.pageSize;
    render();
  }

  function setPeriod(period) {
    state.period = has(PERIODS, period) ? period : ALL;
    els.periodList.querySelectorAll('input').forEach((input) => { input.checked = input.value === state.period; });
    state.limit = CONFIG.pageSize;
    render();
  }

  function setFavOnly(on) {
    state.favOnly = on;
    state.limit = CONFIG.pageSize;
    render();
  }

  function setSort(sort) {
    state.sort = sort === 'old' ? 'old' : 'new';
    els.sortSelect.value = state.sort;
    state.limit = CONFIG.pageSize;
    render();
  }

  function setPanelOpen(open) {
    els.filterPanel.hidden = !open;
    els.filterToggle.setAttribute('aria-expanded', String(open));
  }

  function resetAll() {
    els.search.value = '';
    state.query = '';
    els.clear.hidden = true;
    state.tags.clear();
    state.period = ALL;
    state.favOnly = false;
    state.sort = 'new';
    els.sortSelect.value = 'new';
    setTagMode('all');
    renderPeriodList();
    selectCategory(ALL);
  }

  function toggleBookmark(id) {
    const item = findItem(id);
    if (!item) return;
    const { saved, persisted } = bookmarks.toggle(item);

    document.querySelectorAll(`[data-bookmark="${CSS.escape(id)}"]`).forEach((button) => {
      setBookmarkButton(button, saved, { short: !button.classList.contains('bookmark--large') });
    });
    updateFavoriteUi();

    if (!persisted) {
      showToast('このブラウザでは保存できません（プライベートモードなど）。ページを閉じると消えます');
    } else {
      showToast(saved ? 'お気に入りに追加しました' : 'お気に入りから外しました');
    }
    // お気に入りだけ表示中に外したときは、一覧から消す
    if (state.favOnly && !saved) render();
  }

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    const category = params.get('cat');
    if (category && has(CATEGORIES, category)) state.category = category;
    state.query = params.get('q') ?? '';
    state.tags = new Set(params.getAll('tag').map((t) => t.trim()).filter(Boolean));
    state.tagMode = params.get('tagmode') === 'any' ? 'any' : 'all';
    const period = params.get('period');
    state.period = period && has(PERIODS, period) ? period : ALL;
    state.sort = params.get('sort') === 'old' ? 'old' : 'new';
    state.favOnly = params.get('fav') === '1';
    state.openId = params.get('id') || null;
  }

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.category !== ALL) params.set('cat', state.category);
    if (state.query.trim()) params.set('q', state.query.trim());
    state.tags.forEach((t) => params.append('tag', t));
    if (state.tags.size > 1 && state.tagMode === 'any') params.set('tagmode', 'any');
    if (state.period !== ALL) params.set('period', state.period);
    if (state.sort !== 'new') params.set('sort', state.sort);
    if (state.favOnly) params.set('fav', '1');
    if (state.openId) params.set('id', state.openId);
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next === current) return;
    try {
      window.history.replaceState(null, '', next);
    } catch {
      // file:// など URL を書き換えられない環境では何もしない
    }
  }

  function isTypingTarget(target) {
    return target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  }

  function bindEvents() {
    // タブ：クリック
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => selectCategory(tab.dataset.category));
    });

    // タブ：矢印キー / Home / End で移動（WAI-ARIA のタブの作法）
    els.tablist.addEventListener('keydown', (event) => {
      const index = els.tabs.findIndex((tab) => tab.dataset.category === state.category);
      const last = els.tabs.length - 1;
      const keyMap = {
        ArrowRight: index === last ? 0 : index + 1,
        ArrowLeft: index === 0 ? last : index - 1,
        Home: 0,
        End: last,
      };
      if (!(event.key in keyMap)) return;
      event.preventDefault();
      selectCategory(els.tabs[keyMap[event.key]].dataset.category, { focus: true });
    });

    // 検索：入力（日本語入力の変換中は待つ）
    const onInput = debounce(() => setQuery(els.search.value), CONFIG.debounceMs);
    els.search.addEventListener('input', (event) => {
      els.clear.hidden = !els.search.value;
      if (event.isComposing) return;
      onInput();
    });
    els.search.addEventListener('compositionend', onInput);
    els.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.search.value) {
        event.preventDefault();
        clearSearch();
      }
    });
    els.clear.addEventListener('click', () => {
      clearSearch();
      els.search.focus();
    });

    // 「/」キーで検索窓へ
    document.addEventListener('keydown', (event) => {
      if (els.modal.open) return;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        els.search.focus();
      }
    });

    // 絞り込みパネル
    els.filterToggle.addEventListener('click', () => setPanelOpen(els.filterPanel.hidden));
    els.favToggle.addEventListener('click', () => setFavOnly(!state.favOnly));
    els.sortSelect.addEventListener('change', () => setSort(els.sortSelect.value));
    els.tagModeInputs.forEach((input) => input.addEventListener('change', () => setTagMode(input.value)));
    els.periodList.addEventListener('change', (event) => {
      if (event.target.name === 'period') setPeriod(event.target.value);
    });
    els.clearAll.addEventListener('click', resetAll);
    els.reset.addEventListener('click', resetAll);

    // カード・パネル・ポップアップ内のボタン（イベントをまとめて受ける）
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const tag = target.closest('[data-tag]');
      if (tag) {
        toggleTag(tag.dataset.tag);
        if (els.modal.open && tag.closest('#detail')) {
          returnFocusId = null;
          els.modal.close();
          els.grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
      const bookmark = target.closest('[data-bookmark]');
      if (bookmark) {
        toggleBookmark(bookmark.dataset.bookmark);
        return;
      }
      const open = target.closest('[data-open]');
      if (open) {
        returnFocusId = open.dataset.open;
        openModal(open.dataset.open);
      }
    });

    // ポップアップ：閉じる・背景クリック・前後移動・キー操作
    els.modal.addEventListener('click', (event) => {
      if (event.target === els.modal || event.target.closest('[data-close]')) els.modal.close();
    });
    els.modal.addEventListener('close', onModalClosed);
    els.modal.addEventListener('keydown', (event) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); moveModal(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); moveModal(1); }
    });
    els.modalPrev.addEventListener('click', () => moveModal(-1));
    els.modalNext.addEventListener('click', () => moveModal(1));
    els.copyLink.addEventListener('click', copyCurrentLink);

    // 別のタブでお気に入りを変えたときも反映する
    window.addEventListener('storage', (event) => {
      if (event.key !== CONFIG.storageKey) return;
      bookmarks.reload();
      if (state.openId) setBookmarkButton(els.modalBookmark, bookmarks.has(state.openId));
      render();
    });

    els.retry.addEventListener('click', () => {
      els.grid.hidden = false;
      loadNews();
    });

    // さらに表示：追加された最初のカードへフォーカスを移す
    els.more.addEventListener('click', () => {
      const before = els.grid.children.length;
      state.limit += CONFIG.pageSize;
      render();
      els.grid.children[before]?.querySelector('.card__open')?.focus();
    });
  }

  // ------------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------------
  readUrl();
  els.search.value = state.query;
  els.clear.hidden = !state.query;
  els.sortSelect.value = state.sort;
  els.tagModeInputs.forEach((input) => { input.checked = input.value === state.tagMode; });
  renderPeriodList();
  // URL でタグや期間が指定されていたら、パネルを開いておく
  setPanelOpen(state.tags.size > 0 || state.period !== ALL);
  selectCategory(state.category); // 読み込み前なので描画はされない（タブ状態だけ反映）
  bindEvents();
  loadNews();
})();
