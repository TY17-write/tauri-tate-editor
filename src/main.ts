/**
 * 縦書き小説エディタ tauri-tate-editor
 *
 * 画面の組み立てとイベント配線。
 * 組版まわりの知見は editor/grid.ts、
 * マーカーの制約は editor/marker.ts のコメントを参照。
 */

import { Session } from "./editor/session";
import { MarkerLayer } from "./editor/marker";
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
  onEdit: () => markDirty(),
  onElementReplaced: (el) => {
    paper = el;
  },
});

const scroller = new VerticalScroller(viewport, () => layout.lines * layout.step);

/* ---------- ステータス ---------- */
function updateStatus(): void {
  const text = session.text();
  const chars = text.replace(/\n/g, "").length;
  const perPage = charsPerPage(layout);
  statusCount.textContent = `${chars.toLocaleString()} 字　${(chars / 400).toFixed(1)} 枚`;
  statusPage.textContent = `${perPage} 字/ページ　全 ${Math.max(1, Math.ceil(chars / perPage))} ページ`;
  statusMark.textContent = MarkerLayer.supported
    ? `マーカー ${session.marker.lastCount}`
    : "マーカー非対応";

  const n = countNormalizable(text);
  const btn = $<HTMLButtonElement>("btnNormalize");
  btn.textContent = n ? `正規化 (${n})` : "正規化";
  btn.disabled = n === 0;
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
  scroller.toHead();
  paper.focus();
});
