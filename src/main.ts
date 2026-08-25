/**
 * 縦書き小説エディタ tauri-tate-editor
 *
 * 画面の組み立てとイベント配線。
 * 組版まわりの知見は editor/grid.ts、
 * マーカーの制約は editor/marker.ts のコメントを参照。
 */

import { Session } from "./editor/session";
import { MarkerLayer } from "./editor/marker";
import { SearchLayer } from "./editor/search";
import { bodyChars, buildOutline, parseHeading } from "./editor/outline";
import type { Heading } from "./editor/outline";
import { VerticalScroller } from "./editor/scroll";
import {
  DEFAULT_LAYOUT,
  FONTS,
  PRESETS,
  applyLayout,
  charsPerPage,
  countNormalizable,
  isGridSafeFont,
  normalizeText,
} from "./editor/grid";
import {
  autosave,
  baseName,
  currentPath,
  openWithDialog,
  saveToCurrent,
  saveWithDialog,
  takeAutosave,
} from "./editor/files";
import type { Layout, MarkStyle, PosTag } from "./editor/types";

const SAMPLE = [
  // 見出し記号は全角。半角の # だと、その行だけ升からずれる
  "＃第一章　雪の夜",
  "",
  "＃＃一　硝子戸",
  "",
  "　夜半の風が硝子戸を鳴らしていた。まだ午前二時、原稿はわずか十二枚しか進んでいない。",
  "　わたしはふと顔を上げた。しばらくのあいだ、その音に耳を澄ませていた。とても静かな夜だった。ずいぶん長く、同じ行を書いては消していたように思う。",
  "　「まだ起きていたのか」",
  "　背後で声がした。振り返ると、兄が立っている。ずいぶん久しぶりに見る顔だった……ように思えたが、実際には昨日も会っている。",
  "　「ええ。少しだけ」",
  "　わたしはそう答えて、机の上の原稿用紙を裏返した。まだ誰にも見せたくなかった。",
  "　兄はゆっくりと近づいてきて、窓の外を眺めた。暗い庭に、白いものがちらついている。",
  "　「雪だな」",
  "　「そうですね」",
  "　やがて雪は激しくなり、庭木の輪郭を静かに消していった。とても長い夜だ――と、わたしは思った。",
  "",
  "＃＃二　万年筆",
  "",
  "　わたしは決してあきらめないと決めていた。けれど、その決意はひどく脆く、かすかな物音にさえ揺らいでしまう。",
  "　窓辺の空気は冷たく、指先の感覚が鈍くなっていく。それでもわたしは、ゆっくりと万年筆を握り直した。",
].join("\n");

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素が見つかりません: #${id}`);
  return el as T;
}

/**
 * 本文を入れる要素。
 *
 * Session は undo 履歴を捨てるためにこの要素を作り直すことがある。
 * 参照を握りっぱなしにすると古い要素を操作してしまうので、
 * 差し替えの通知（onElementReplaced）で更新する。
 */
let paper = $<HTMLElement>("paper");
const viewport = $<HTMLElement>("viewport");
const statusCount = $<HTMLElement>("status-count");
const statusPage = $<HTMLElement>("status-page");
const statusMark = $<HTMLElement>("status-mark");
const statusMsg = $<HTMLElement>("status-msg");

const layout: Layout = { ...DEFAULT_LAYOUT };

/* ---------- 書体の選択肢 ---------- */
const fontSel = $<HTMLSelectElement>("font");
for (const f of FONTS) {
  const o = document.createElement("option");
  o.value = f.value;
  o.textContent = f.label;
  fontSel.appendChild(o);
}
fontSel.value = layout.font;

/* ---------- セッション ---------- */
const session = new Session(paper, {
  onStatus: (msg, isError) => {
    statusMsg.textContent = msg;
    statusMsg.classList.toggle("err", Boolean(isError));
  },
  onSynced: () => updateStatus(),
  onEdit: () => {
    markDirty();
    // 本文が変わるとヒットの位置がずれるので、検索し直す
    if (!findbar.hidden) scheduleFind();
  },
  onElementReplaced: (el) => {
    paper = el;
    search.rebind(el);
  },
});

const scroller = new VerticalScroller(viewport, () => layout.lines * layout.step);

/* ---------- ステータス ---------- */
function updateStatus(): void {
  const lines = session.text().split("\n");
  // 見出し行は分量に数えない。原稿の実量はこちらが近い
  const chars = bodyChars(lines);
  const perPage = charsPerPage(layout);
  statusCount.textContent = `${chars.toLocaleString()} 字　${(chars / 400).toFixed(1)} 枚`;
  statusPage.textContent = `${perPage} 字/ページ　全 ${Math.max(1, Math.ceil(chars / perPage))} ページ`;
  statusMark.textContent = MarkerLayer.supported
    ? `マーカー ${session.marker.lastCount}`
    : "マーカー非対応";

  const text = lines.join("\n");
  const n = countNormalizable(text);
  const btn = $<HTMLButtonElement>("btnNormalize");
  btn.textContent = n ? `正規化 (${n})` : "正規化";
  btn.disabled = n === 0;

  markHeadings(lines);
  renderOutline(lines);
}

/* ---------- 組版設定 ---------- */

/** 書体とマス目の組み合わせが噛み合っているかを知らせる。 */
function checkFontWarning(): void {
  const gridOn = paper.classList.contains("grid-full") || paper.classList.contains("grid-rules");
  if (gridOn && !isGridSafeFont(layout.font)) {
    statusMsg.textContent = "この書体は約物が詰まるため、升目とは揃いません";
    statusMsg.classList.add("err");
  } else if (statusMsg.classList.contains("err")) {
    // 自分が出した警告だけを消す
    statusMsg.textContent = "";
    statusMsg.classList.remove("err");
  }
}

/* ---------- 用紙を画面高さに合わせる ----------
   1行の字数が多い判型（文庫の 42 字など）では、用紙の高さが
   ウィンドウを超えて下が見切れる。文字サイズを下げて収める。
   実際の文庫本も、1行が長い分だけ文字が小さい。 */
const cellRange = $<HTMLInputElement>("cell");
const fitCheck = $<HTMLInputElement>("fitHeight");

function fitCellToViewport(): void {
  if (!fitCheck.checked) return;
  const style = getComputedStyle(viewport);
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = 2; // 用紙の枠線
  const usable = viewport.clientHeight - pad - border;
  const cell = Math.floor(usable / layout.chars);
  const clamped = Math.max(Number(cellRange.min), Math.min(Number(cellRange.max), cell));
  if (clamped === layout.cell) return;
  layout.cell = clamped;
  cellRange.value = String(clamped);
  applyLayout(layout);
}

function refreshLayout(): void {
  applyLayout(layout);
  fitCellToViewport();
  checkFontWarning();
  updateStatus();
}

fitCheck.addEventListener("change", () => {
  cellRange.disabled = fitCheck.checked;
  refreshLayout();
});
new ResizeObserver(() => fitCellToViewport()).observe(viewport);

const presetSel = $<HTMLSelectElement>("preset");
const charsInput = $<HTMLInputElement>("chars");
const linesInput = $<HTMLInputElement>("lines");

presetSel.addEventListener("change", () => {
  const p = PRESETS[presetSel.value];
  if (!p) return;
  layout.chars = p.chars;
  layout.lines = p.lines;
  charsInput.value = String(p.chars);
  linesInput.value = String(p.lines);
  refreshLayout();
});

charsInput.addEventListener("input", () => {
  layout.chars = Number(charsInput.value) || layout.chars;
  presetSel.value = "custom";
  refreshLayout();
});
linesInput.addEventListener("input", () => {
  layout.lines = Number(linesInput.value) || layout.lines;
  presetSel.value = "custom";
  refreshLayout();
});
cellRange.addEventListener("input", () => {
  layout.cell = Number(cellRange.value);
  applyLayout(layout);
  updateStatus();
});
$<HTMLInputElement>("step").addEventListener("input", (e) => {
  layout.step = Number((e.target as HTMLInputElement).value);
  refreshLayout();
});
fontSel.addEventListener("change", () => {
  layout.font = fontSel.value;
  refreshLayout();
});

$<HTMLSelectElement>("gridMode").addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  paper.classList.remove("grid-full", "grid-rules", "grid-page");
  if (v) paper.classList.add(v);
  checkFontWarning();
});

/* ---------- マーカー ---------- */
$<HTMLSelectElement>("markStyle").addEventListener("change", (e) => {
  session.marker.setOptions({ style: (e.target as HTMLSelectElement).value as MarkStyle });
  session.renderMarks();
  updateStatus();
});

for (const cb of Array.from(
  document.querySelectorAll<HTMLInputElement>(".pos-toggles input[data-pos]"),
)) {
  cb.addEventListener("change", () => {
    const visible = new Set<PosTag>();
    for (const el of Array.from(
      document.querySelectorAll<HTMLInputElement>(".pos-toggles input[data-pos]"),
    )) {
      if (el.checked) visible.add(el.dataset.pos as PosTag);
    }
    session.marker.setOptions({ visible });
    session.renderMarks();
    updateStatus();
  });
}

const btnMarker = $<HTMLButtonElement>("btnMarker");
btnMarker.addEventListener("click", () => {
  const on = !session.marker.options.enabled;
  session.marker.setOptions({ enabled: on });
  btnMarker.classList.toggle("is-on", on);
  session.renderMarks();
  updateStatus();
});

/* ---------- 正規化 ---------- */
$<HTMLButtonElement>("btnNormalize").addEventListener("click", () => {
  void session.setText(normalizeText(session.text()));
});

/* ---------- ファイル ---------- */
const statusFile = $<HTMLElement>("status-file");

/** 保存されていない変更があるか。ウィンドウを閉じる前の確認に使う。 */
let dirty = false;

function setStatusFile(path: string | null): void {
  statusFile.textContent = path ? baseName(path) : "新規";
  statusFile.title = path ?? "";
}

function markDirty(): void {
  if (dirty) return;
  dirty = true;
  if (!statusFile.textContent?.endsWith(" *")) {
    statusFile.textContent = `${statusFile.textContent} *`;
  }
}

async function doOpen(): Promise<void> {
  try {
    const loaded = await openWithDialog();
    if (!loaded) return;

    // 前回の自動保存が残っていれば、そちらを使うか尋ねる
    const rescued = await takeAutosave(loaded.path);
    let text = loaded.text;
    if (rescued !== null && rescued !== loaded.text) {
      const useIt = window.confirm(
        "前回の自動保存が残っています。保存されずに終了した可能性があります。\n" +
          "自動保存の内容を読み込みますか？（いいえ＝ファイルの内容を読み込む）",
      );
      if (useIt) text = rescued;
    }

    await session.setText(text);
    setStatusFile(loaded.path);
    dirty = false;
    statusMsg.textContent = `${baseName(loaded.path)} を開きました（${loaded.encoding}）`;
    statusMsg.classList.remove("err");
    scroller.toHead();
  } catch (err) {
    statusMsg.textContent = `開けません: ${String(err)}`;
    statusMsg.classList.add("err");
  }
}

async function doSave(forceDialog: boolean): Promise<void> {
  try {
    const text = session.text();
    const res = forceDialog ? await saveWithDialog(text) : await saveToCurrent(text);
    if (!res) {
      // 保存先が未定なら、名前を付けて保存に回す
      if (!forceDialog) return doSave(true);
      return;
    }
    setStatusFile(res.path);
    dirty = false;
    statusMsg.textContent = `${baseName(res.path)} に保存しました`;
    statusMsg.classList.remove("err");
  } catch (err) {
    statusMsg.textContent = `保存できません: ${String(err)}`;
    statusMsg.classList.add("err");
  }
}

$<HTMLButtonElement>("btnOpen").addEventListener("click", () => void doOpen());
$<HTMLButtonElement>("btnSave").addEventListener("click", () => void doSave(false));
$<HTMLButtonElement>("btnSaveAs").addEventListener("click", () => void doSave(true));

/* 自動保存。開いているファイルの隣に .autosave を置く。
   保存先が未定の新規原稿では何も起きない（Rust 側で null を返す）。 */
const AUTOSAVE_MS = 60_000;
window.setInterval(() => {
  if (!dirty) return;
  void autosave(session.text())
    .then((path) => {
      if (path) statusMsg.textContent = `自動保存しました（${new Date().toLocaleTimeString()}）`;
    })
    .catch(() => {
      /* 自動保存の失敗は本作業を邪魔しない */
    });
}, AUTOSAVE_MS);

window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
});

/* ---------- 目次 ---------- */
const outline = $<HTMLElement>("outline");
const outlineList = $<HTMLElement>("outlineList");
let headings: Heading[] = [];

/**
 * 見出し行に印を付ける。
 *
 * 本文そのものには触らない。textContent を変えるとモデル側と
 * 食い違い、マーカーの位置がずれる。属性だけを足す。
 */
function markHeadings(lines: string[]): void {
  const els = Array.from(paper.children) as HTMLElement[];
  els.forEach((el, i) => {
    const h = lines[i] !== undefined ? parseHeading(lines[i]) : null;
    if (h) el.dataset.heading = String(h.level);
    else delete el.dataset.heading;
  });
}

function renderOutline(lines: string[]): void {
  headings = buildOutline(lines);
  if (outline.hidden) return;

  outlineList.replaceChildren();
  if (headings.length === 0) {
    const li = document.createElement("li");
    li.className = "outline-empty";
    li.textContent = "見出しがありません";
    outlineList.appendChild(li);
    return;
  }

  for (const h of headings) {
    const li = document.createElement("li");
    li.className = `lv${h.level}`;
    li.dataset.index = String(h.index);

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = h.title;
    title.title = h.title;

    const chars = document.createElement("span");
    chars.className = "chars";
    chars.textContent = `${h.chars.toLocaleString()} 字`;

    li.append(title, chars);
    li.addEventListener("click", () => jumpToParagraph(h.index));
    outlineList.appendChild(li);
  }
}

/** 指定した段落へスクロールし、行頭にキャレットを置く。 */
function jumpToParagraph(index: number): void {
  const el = paper.children[index] as HTMLElement | undefined;
  if (!el) return;
  scroller.reveal(el.getBoundingClientRect());

  const node = el.firstChild;
  const range = document.createRange();
  if (node && node.nodeType === Node.TEXT_NODE) range.setStart(node, 0);
  else range.setStart(el, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  paper.focus();

  for (const li of Array.from(outlineList.children)) {
    li.classList.toggle("is-current", (li as HTMLElement).dataset.index === String(index));
  }
}

function toggleOutline(show?: boolean): void {
  const next = show ?? outline.hidden;
  outline.hidden = !next;
  if (next) renderOutline(session.text().split("\n"));
  // 幅が変わるので、用紙の大きさとスクロール量を測り直す
  fitCellToViewport();
  scroller.calibrate();
}

$<HTMLButtonElement>("btnOutline").addEventListener("click", () => toggleOutline());
$<HTMLButtonElement>("outlineClose").addEventListener("click", () => toggleOutline(false));

/* ---------- 検索と置換 ---------- */
const findbar = $<HTMLElement>("findbar");
const findQuery = $<HTMLInputElement>("findQuery");
const findReplace = $<HTMLInputElement>("findReplace");
const findCount = $<HTMLElement>("findCount");
const findRegex = $<HTMLInputElement>("findRegex");
const findCase = $<HTMLInputElement>("findCase");

const search = new SearchLayer(paper);
let findTimer: number | null = null;

function findOptions() {
  return { regex: findRegex.checked, caseSensitive: findCase.checked };
}

/** 検索し直して件数表示を更新する。 */
function runFind(): void {
  const n = search.run(findQuery.value, findOptions());
  findQuery.classList.toggle("invalid", n < 0);
  if (n < 0) {
    findCount.textContent = "正規表現が不正";
  } else if (n === 0) {
    findCount.textContent = findQuery.value ? "見つかりません" : "—";
  } else {
    findCount.textContent = `${search.position} / ${n} 件`;
  }
}

/** 入力のたびに検索すると重いので少し待つ。 */
function scheduleFind(): void {
  if (findTimer !== null) window.clearTimeout(findTimer);
  findTimer = window.setTimeout(() => {
    findTimer = null;
    runFind();
  }, 180);
}

/** 次／前のヒットへ移り、見えるところまでスクロールする。 */
function stepFind(dir: number): void {
  const range = search.step(dir);
  if (!range) return;
  scroller.revealRange(range);
  findCount.textContent = `${search.position} / ${search.count} 件`;
}

function openFind(): void {
  findbar.hidden = false;
  // 本文を選択していたら、それを検索語の初期値にする
  const sel = window.getSelection()?.toString() ?? "";
  if (sel && !sel.includes("\n")) findQuery.value = sel;
  findQuery.focus();
  findQuery.select();
  runFind();
}

function closeFind(): void {
  findbar.hidden = true;
  search.clear();
  findCount.textContent = "—";
  paper.focus();
}

findQuery.addEventListener("input", scheduleFind);
findRegex.addEventListener("change", runFind);
findCase.addEventListener("change", runFind);

findQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
findReplace.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});

$<HTMLButtonElement>("findNext").addEventListener("click", () => stepFind(1));
$<HTMLButtonElement>("findPrev").addEventListener("click", () => stepFind(-1));
$<HTMLButtonElement>("findClose").addEventListener("click", closeFind);
$<HTMLButtonElement>("btnFind").addEventListener("click", openFind);

$<HTMLButtonElement>("findReplaceOne").addEventListener("click", () => {
  if (search.count === 0) return;
  if (search.position === 0) stepFind(1);
  const range = search.currentRange();
  if (range) scroller.revealRange(range);
  if (search.replaceCurrent(findReplace.value)) {
    markDirty();
    // 置換で本文が変わったので、位置を取り直す
    window.setTimeout(runFind, 0);
  }
});

$<HTMLButtonElement>("findReplaceAll").addEventListener("click", () => {
  const n = search.count;
  if (n === 0) return;
  if (!window.confirm(`${n} 件を「${findReplace.value}」に置き換えます。よろしいですか。`)) return;
  const done = search.replaceAll(findReplace.value);
  markDirty();
  statusMsg.textContent = `${done} 件を置き換えました`;
  statusMsg.classList.remove("err");
  window.setTimeout(runFind, 0);
});

/* ---------- ページ送り ---------- */
window.addEventListener("keydown", (e) => {
  // ファイル操作は本文にフォーカスがあっても効かせる
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "o") {
      e.preventDefault();
      void doOpen();
      return;
    }
    if (k === "s") {
      e.preventDefault();
      void doSave(e.shiftKey);
      return;
    }
    if (k === "f") {
      e.preventDefault();
      openFind();
      return;
    }
    if (k === "h") {
      e.preventDefault();
      openFind();
      findReplace.focus();
      return;
    }
    if (k === "g") {
      e.preventDefault();
      toggleOutline();
      return;
    }
  }

  // F3 は本文にフォーカスがあっても効かせる
  if (e.key === "F3" && !findbar.hidden) {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "Escape" && !findbar.hidden) {
    e.preventDefault();
    closeFind();
    return;
  }

  if (e.target === paper) return;
  if (e.key === "PageDown") {
    scroller.movePage(1);
    e.preventDefault();
  } else if (e.key === "PageUp") {
    scroller.movePage(-1);
    e.preventDefault();
  } else if (e.key === "Home" && e.ctrlKey) {
    scroller.toHead();
    e.preventDefault();
  } else if (e.key === "End" && e.ctrlKey) {
    scroller.toTail();
    e.preventDefault();
  }
});

/* ---------- 起動 ---------- */
cellRange.disabled = fitCheck.checked;
applyLayout(layout);
fitCellToViewport();
void currentPath().then(setStatusFile).catch(() => setStatusFile(null));
if (!MarkerLayer.supported) {
  statusMsg.textContent = "CSS Custom Highlight API が使えないため、マーカーは表示されません";
  statusMsg.classList.add("err");
}
void session.setText(SAMPLE).then(() => {
  // 本文が入ってからでないとスクロール量を測れない
  scroller.calibrate();
  scroller.toHead();
  paper.focus();
});
