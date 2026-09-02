/**
 * 縦書き小説エディタ tauri-tate-editor
 *
 * 画面の組み立てとイベント配線。
 * 組版まわりの知見は editor/grid.ts、
 * マーカーの制約は editor/marker.ts のコメントを参照。
 */

import { Session } from "./editor/session";
import type { CommandResult, EditMode } from "./editor/session";
import {
  NOTATIONS,
  convertNotation,
  countNotation,
  loadNotation,
  notationInfo,
  saveNotation,
} from "./editor/notation";
import type { Notation } from "./editor/notation";
import { MarkerLayer } from "./editor/marker";
import { SearchLayer } from "./editor/search";
import { bodyChars, buildOutline, parseHeading } from "./editor/outline";
import type { Heading } from "./editor/outline";
import {
  DEFAULT_OPTIONS,
  ISSUE_LABEL,
  fetchReport,
  loadOptions,
  per1000,
  saveOptions,
} from "./editor/style";
import type { Issue, IssueKind, StyleOptions, StyleReport } from "./editor/style";
import { VerticalScroller } from "./editor/scroll";
import {
  CELL_LIMITS,
  CURATED_FAMILIES,
  DEFAULT_LAYOUT,
  FONTS,
  PRESETS,
  STEP_RATIO,
  applyLayout,
  charsPerPage,
  countNormalizable,
  fontStack,
  isGridSafeFont,
  listInstalledFonts,
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
import {
  THEMES,
  applyTheme,
  loadSettings,
  presetFor,
  saveSettings,
} from "./editor/settings";
import type { GridMode, Settings, ThemeName } from "./editor/settings";
import type { Layout, MarkStyle, PosTag } from "./editor/types";

const SAMPLE = [
  // 見出し記号は全角。半角の # だと、その行だけ升からずれる
  "＃第一章　雪の夜",
  "",
  "＃＃一　硝子戸",
  "",
  "　夜半の風が|硝子戸《ガラスど》を鳴らしていた。まだ午前二時、原稿はわずか十二枚しか進んでいない。",
  "　わたしはふと顔を上げた。しばらくのあいだ、その音に耳を澄ませていた。とても静かな夜だった。ずいぶん長く、同じ行を書いては消していたように思う。",
  "　「まだ起きていたのか」",
  "　背後で声がした。振り返ると、兄が立っている。ずいぶん久しぶりに見る顔だった……ように思えたが、実際には昨日も会っている。",
  "　「ええ。少しだけ」",
  "　わたしはそう答えて、机の上の原稿用紙を裏返した。《《まだ誰にも見せたくなかった》》。",
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

/* ---------- 設定 ----------
   前に開いたときの見た目で始める。読み出したものは settings.ts が
   既定値に重ねて整えてあるので、ここでは素直に使ってよい。 */
const settings = loadSettings();
const layout: Layout = { ...settings.layout };
let theme: ThemeName = settings.theme;
applyTheme(theme);

/** いまの画面の状態を、そのまま設定の形にする。 */
function collect(): Settings {
  return {
    layout: { ...layout },
    preset: presetSel.value,
    grid: gridSel.value as GridMode,
    markStyle: markStyleSel.value as MarkStyle,
    markerOn: session.marker.options.enabled,
    pos: [...session.marker.options.visible],
    preview: session.editMode === "preview",
    theme,
  };
}

/**
 * 設定を書き出す。
 *
 * つまみを動かすたびに書くと無駄が多いので、少し置いてからまとめる。
 */
let saveTimer: number | null = null;
function scheduleSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveSettings(collect());
  }, 300);
}

/* ---------- 書体の選択肢 ----------
   まず標準の書体（升に乗ることを確かめてある顔ぶれ）を並べ、
   インストール済みの書体は Rust から取れてから後ろに足す。 */
const fontSel = $<HTMLSelectElement>("font");
{
  const g = document.createElement("optgroup");
  g.label = "標準";
  for (const f of FONTS) {
    const o = document.createElement("option");
    o.value = f.value;
    o.textContent = f.label;
    g.appendChild(o);
  }
  fontSel.appendChild(g);
}
fontSel.value = layout.font;

/**
 * インストール済みの書体を選択肢に足す。
 *
 * Rust が日本語のグリフを持つ書体だけに絞って返す。標準の欄と同じ
 * ファミリーは重ねて出さない。覚えていた書体がどこにも無ければ
 * （アンインストールされた、値の形式が変わった）既定に戻す。
 */
async function loadInstalledFonts(): Promise<void> {
  try {
    const fonts = await listInstalledFonts();
    const byJa = new Intl.Collator("ja");
    const extra = fonts
      .filter((f) => !CURATED_FAMILIES.has(f.name))
      .sort((a, b) => byJa.compare(a.label, b.label));
    if (extra.length > 0) {
      const g = document.createElement("optgroup");
      g.label = "インストール済み";
      for (const f of extra) {
        const o = document.createElement("option");
        o.value = fontStack(f.name);
        o.textContent = f.label;
        g.appendChild(o);
      }
      fontSel.appendChild(g);
    }
  } catch {
    /* 一覧が取れなくても標準の書体だけで動く */
  }
  if (!Array.from(fontSel.options).some((o) => o.value === layout.font)) {
    layout.font = DEFAULT_LAYOUT.font;
    refreshLayout();
  }
  fontSel.value = layout.font;
}

/* ---------- セッション ---------- */
const session = new Session(paper, {
  onStatus: (msg, isError) => {
    statusMsg.textContent = msg;
    statusMsg.classList.toggle("err", Boolean(isError));
  },
  onSynced: () => {
    updateStatus();
    // 解析結果は Rust 側で段落ごとにキャッシュされるので、
    // 編集のたびに調べ直しても再解析は変更のあった段落だけで済む
    if (!report.hidden) void refreshReport();
  },
  onEdit: () => {
    markDirty();
    // 本文が変わると位置がずれるので、検索し直して指摘の強調は解く
    if (!findbar.hidden) scheduleFind();
    clearIssueHighlight();
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
    statusMsg.textContent = "この書体は字幅が揃わないため、升目からずれます";
    statusMsg.classList.add("err");
  } else if (statusMsg.classList.contains("err")) {
    // 自分が出した警告だけを消す
    statusMsg.textContent = "";
    statusMsg.classList.remove("err");
  }
}

/* ---------- 文字サイズと行送りは字数から自動で決める ----------
   1行の字数が多い判型（文庫の 42 字など）ほど文字を小さくして、
   1行がちょうど画面の高さに収まるようにする。実際の文庫本も、
   1行が長い分だけ文字が小さい。行送りは字送りの STEP_RATIO 倍。
   ルビと傍点の場所（行間）はこの比で確保される（grid.ts を参照）。 */
/**
 * 印刷中は組版の自動計算を凍結する。
 *
 * 印刷（ダイアログのプレビューを含む）では画面が印刷レイアウトに
 * なり、ResizeObserver 経由で fitCellToViewport が走って字送りと
 * 行送り比が印刷ビューポート基準に書き換わってしまう。すると
 * beforeprint 時点の比で組んだマス目 SVG と本文の行送りが食い違い、
 * 升が狭くなって文字が升からはみ出す。値を凍結すれば、SVG と
 * 本文は同じ比のまま刷られる。
 */
let printing = false;

function fitCellToViewport(): void {
  if (printing) return;
  const style = getComputedStyle(viewport);
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = 2; // 用紙の枠線
  const usable = viewport.clientHeight - pad - border;

  // 端末画素の刻み。Windows の拡大率が 125% などのとき、CSS px の
  // 整数でも端末画素では半端になり、マス目の線の間隔が揺れて歪んで
  // 見える。字送りも行間もこの刻みに乗せる
  const q = 1 / (window.devicePixelRatio || 1);
  const snap = (v: number) => Math.round(v / q) * q;

  let cell = Math.floor(usable / layout.chars / q) * q;
  cell = Math.max(CELL_LIMITS[0], Math.min(CELL_LIMITS[1], cell));

  // 行間（字の箱の脇の空き、片側）。round(cell × 1.7) のような
  // 決め方だと行間が 5.5px など半端になり、マス目の 3 層の
  // グラデーションの境界が半画素ずつずれて歪む。行間そのものを
  // 刻みに乗せ、行送りは「字送り + 行間 × 2」で組み立てる
  const gutter = Math.max(snap(2), snap((cell * (STEP_RATIO - 1)) / 2));
  const step = cell + 2 * gutter;

  if (cell === layout.cell && step === layout.step) return;
  layout.cell = cell;
  layout.step = step;
  applyLayout(layout);
}

function refreshLayout(): void {
  applyLayout(layout);
  fitCellToViewport();
  checkFontWarning();
  // 行の長さが変わると折り返しが変わり、句読点のぶら下げの場所も
  // 変わる。マーカーごと引き直す
  session.renderMarks();
  updateStatus();
  scheduleSave();
}

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
fontSel.addEventListener("change", () => {
  layout.font = fontSel.value;
  refreshLayout();
});

const gridSel = $<HTMLSelectElement>("gridMode");

/** マス目の描き方を用紙に反映する。 */
function applyGrid(mode: GridMode): void {
  paper.classList.remove("grid-full", "grid-rules", "grid-page");
  if (mode) paper.classList.add(mode);
  checkFontWarning();
}

gridSel.addEventListener("change", () => {
  applyGrid(gridSel.value as GridMode);
  scheduleSave();
});

/* ---------- 配色 ---------- */
const themeSel = $<HTMLSelectElement>("theme");
for (const t of THEMES) {
  const o = document.createElement("option");
  o.value = t.value;
  o.textContent = t.label;
  themeSel.appendChild(o);
}
themeSel.addEventListener("change", () => {
  theme = themeSel.value as ThemeName;
  applyTheme(theme);
  scheduleSave();
});

/* ---------- マーカー ---------- */
const markStyleSel = $<HTMLSelectElement>("markStyle");
markStyleSel.addEventListener("change", () => {
  session.marker.setOptions({ style: markStyleSel.value as MarkStyle });
  session.renderMarks();
  updateStatus();
  scheduleSave();
});

/** 品詞のチェック箱。 */
const posChecks = Array.from(
  document.querySelectorAll<HTMLInputElement>(".pos-toggles input[data-pos]"),
);

for (const cb of posChecks) {
  cb.addEventListener("change", () => {
    const visible = new Set<PosTag>();
    for (const el of posChecks) {
      if (el.checked) visible.add(el.dataset.pos as PosTag);
    }
    session.marker.setOptions({ visible });
    session.renderMarks();
    updateStatus();
    scheduleSave();
  });
}

const btnMarker = $<HTMLButtonElement>("btnMarker");
btnMarker.addEventListener("click", () => {
  const on = !session.marker.options.enabled;
  session.marker.setOptions({ enabled: on });
  btnMarker.classList.toggle("is-on", on);
  session.renderMarks();
  updateStatus();
  scheduleSave();
});

/* ---------- 印刷用のマス目の下敷き ----------
   印刷でマス目を CSS の背景に任せてはいけない。実測で順に壊れた。
     ・ページに分割された要素の背景は、位相も周期も崩れて描かれる
     ・分割を避けてページごとの下敷き要素にしても、グラデーションや
       SVG タイルの「敷き詰め」が周期 2 倍に化ける
     ・下敷きをページ 1 枚ぶんの mm 寸法で並べても、実際のページの
       行数や行送りがエンジンの丸めでわずかに違い、本文が長くなる
       ほどマス目が滑っていく
   そこで罫線は**段落ごとのインライン SVG** で引く。SVG は段落の箱
   いっぱいに伸ばす（viewBox は行数×字数に比例）ので、段落の物理
   寸法——つまり本文そのものの行送り・字送り——にそのまま貼り付き、
   エンジン側の丸めや改ページがどうであっても本文と升がずれない。
   ベクタのまま PDF に乗るので大きさによる崩れもない。

   印刷前に各段落へ差し込み、印刷後に片付ける。段落の行数は画面で
   測る（1 行の字数が同じなので、折り返しは画面と印刷で一致する）。 */
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 段落 1 つぶんのマス目 SVG。
 *
 * 座標系は「字送り = 1」の単位で組む。行送りは比（step/cell）で
 * 効かせ、実寸は段落の箱に合わせた引き伸ばしで決まる。
 */
function paraGridSvg(mode: "grid-full" | "grid-rules", lines: number): SVGSVGElement {
  const chars = layout.chars;
  const S = layout.step / layout.cell; // 行送り（字送り単位）
  const g = (S - 1) / 2; // 行間（片側）
  const w = lines * S;
  const h = chars;
  const d: string[] = [];
  const f = (v: number) => v.toFixed(4);

  for (let j = 0; j < lines; j++) {
    if (mode === "grid-rules") {
      const x = w - j * S;
      d.push(`M${f(x)} 0V${f(h)}`);
      continue;
    }
    // 字の箱の左右の縦線と、箱の中だけの横線
    const xr = w - j * S - g;
    const xl = w - (j + 1) * S + g;
    d.push(`M${f(xl)} 0V${f(h)}`, `M${f(xr)} 0V${f(h)}`);
    for (let i = 0; i <= chars; i++) {
      d.push(`M${f(xl)} ${f(i)}H${f(xr)}`);
    }
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "printgrid");
  svg.setAttribute("viewBox", `0 0 ${f(w)} ${f(h)}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  // スタイルは print.css に頼らず直接焼き込む。WebView2 が
  // media="print" の CSS を古いままキャッシュすることがあり、
  // absolute が当たらないと SVG がインライン要素として流れに入り、
  // 段落が 1 行ぶん太って升が余る（実害）。
  // absolute で流れから外し、z-index: -1 で文字の下に敷く
  svg.setAttribute(
    "style",
    "display:block;position:absolute;inset:0;width:100%;height:100%;" +
      "z-index:-1;pointer-events:none",
  );
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d.join(""));
  path.setAttribute("fill", "none");
  // 1 単位 = 1 字送り。0.25mm 相当の線の太さを単位に直す。
  // 字送りの実寸は (210mm - 15mm×2) / 字数（print.css と揃える）
  const cellMM = (210 - 15 * 2) / chars;
  path.setAttribute("style", `stroke: var(--rule); stroke-width: ${(0.25 / cellMM).toFixed(4)}`);
  svg.appendChild(path);
  return svg;
}

function buildPrintGrids(): void {
  clearPrintGrids();
  const mode = gridSel.value;
  if (mode !== "grid-full" && mode !== "grid-rules") return;

  // 行数の同じ段落は SVG を使い回す（長編では大半が同じ行数）
  const cache = new Map<number, SVGSVGElement>();
  for (const p of Array.from(paper.children) as HTMLElement[]) {
    if (p.tagName !== "P") continue;
    // 行数 = 段落の幅 ÷ その段落のいまの行送り。
    // layout.step（画面の px）で割ってはいけない。WebView2 では
    // beforeprint が印刷レイアウトの適用後に届くことがあり、
    // 印刷寸法の幅を画面の行送りで割ると行数を倍近く数えてしまう
    // （升が半分に潰れて全段落ずれた。実害）。同じレイアウトの
    // 幅と行送りで割れば、どちらの順序でも正しい。
    const lineH = parseFloat(getComputedStyle(p).lineHeight) || layout.step;
    const lines = Math.max(1, Math.round(p.getBoundingClientRect().width / lineH));
    let svg = cache.get(lines);
    if (!svg) {
      svg = paraGridSvg(mode, lines);
      cache.set(lines, svg);
    }
    // 貼り付け先の段落側も print.css に頼らずここで整える。
    // relative + z-index: 0 で、SVG を自分の箱に敷けるようにする。
    // 空の段落は SVG を入れると :empty が外れて幅が消えるので、
    // 1 行ぶんの幅も最低保証する（afterprint で外す）
    p.style.position = "relative";
    p.style.zIndex = "0";
    p.style.minBlockSize = "var(--step)";
    p.appendChild(svg.cloneNode(true));
  }
}

function clearPrintGrids(): void {
  for (const el of Array.from(paper.querySelectorAll("svg.printgrid"))) el.remove();
  for (const p of Array.from(paper.children) as HTMLElement[]) {
    if (p.tagName !== "P") continue;
    p.style.removeProperty("position");
    p.style.removeProperty("z-index");
    p.style.removeProperty("min-block-size");
  }
}

/**
 * 【一時的な診断】印刷ページの左下に、升の計算に使った値を刷り込む。
 * 実機でだけ升がずれる問題の切り分け用。原因が取れたら外す。
 */
function printDiagnostics(): void {
  const d = document.createElement("div");
  d.id = "printDiag";
  d.style.cssText =
    "position:fixed;left:2mm;bottom:2mm;z-index:99;" +
    "font:3mm/1.5 Consolas,monospace;color:#333;background:#fff;" +
    "writing-mode:horizontal-tb;white-space:pre;";
  const cs = getComputedStyle(paper);
  const root = getComputedStyle(document.documentElement);
  const paras = (Array.from(paper.children) as HTMLElement[])
    .filter((p) => p.tagName === "P")
    .slice(0, 3);
  const rows = paras.map((p, i) => {
    const lh = parseFloat(getComputedStyle(p).lineHeight);
    const w = p.getBoundingClientRect().width;
    const svg = p.querySelector("svg.printgrid");
    return `p${i}: w=${w.toFixed(1)} lh=${lh.toFixed(2)} lines=${Math.round(w / lh)} vb=${svg?.getAttribute("viewBox") ?? "-"}`;
  });
  d.textContent = [
    `DIAG v2 ${matchMedia("print").matches ? "PRINT-LAYOUT" : "SCREEN-LAYOUT"} mode=${paper.dataset.mode ?? "?"}`,
    `dpr=${devicePixelRatio} chars=${layout.chars} cell=${layout.cell} step=${layout.step}`,
    `paperFont=${cs.fontSize} paperLineH=${cs.lineHeight}`,
    `--cell=${root.getPropertyValue("--cell").trim()} ratio=${root.getPropertyValue("--step-ratio").trim()}`,
    ...rows,
  ].join("\n");
  document.body.appendChild(d);
}

window.addEventListener("beforeprint", () => {
  printing = true;
  buildPrintGrids();
  printDiagnostics();
});
window.addEventListener("afterprint", () => {
  printing = false;
  clearPrintGrids();
  document.getElementById("printDiag")?.remove();
  // 凍結中に画面の大きさが変わっていたかもしれないので測り直す
  fitCellToViewport();
});

/* ---------- 印刷 ---------- */

/**
 * 印刷する。PDF は印刷ダイアログの「PDF として保存」で作る。
 *
 * 見た目は print.css が決める。用紙は A4 横で、1行の字数から
 * 文字の大きさを決め直すので、画面の文字サイズは関係しない。
 *
 * 検索や指摘の強調が残っていると刷り込まれてしまうので、先に消す。
 */
function doPrint(): void {
  closeFind();
  clearIssueHighlight();
  statusMsg.textContent = "印刷（PDF は印刷ダイアログの「PDF として保存」から）";
  statusMsg.classList.remove("err");
  window.print();
}

$<HTMLButtonElement>("btnPrint").addEventListener("click", doPrint);

/* ---------- 正規化 ---------- */
$<HTMLButtonElement>("btnNormalize").addEventListener("click", () => {
  void session.setText(normalizeText(session.text()));
});

/* ---------- 記法と表示モード ---------- */
const notationSel = $<HTMLSelectElement>("notation");
const modeSourceBtn = $<HTMLButtonElement>("modeSource");
const modePreviewBtn = $<HTMLButtonElement>("modePreview");
let notation: Notation = loadNotation();

for (const n of NOTATIONS) {
  const o = document.createElement("option");
  o.value = n.value;
  o.textContent = n.label;
  notationSel.appendChild(o);
}
notationSel.value = notation;

/** 記法の書き方と、ルビ・傍点のキーを吹き出しに出す。 */
function setNotationHint(): void {
  notationSel.title = `${notationInfo(notation).hint}　Ctrl+R ルビ / Ctrl+B 傍点 / Ctrl+Q 類義語`;
}
setNotationHint();

/* ---------- ルビ入力の小窓 ---------- */
const rubyBox = $<HTMLElement>("rubyBox");
const rubyReading = $<HTMLInputElement>("rubyReading");
const rubyBase = $<HTMLElement>("rubyBase");

/**
 * ルビの小窓を開く。
 *
 * 読みを本文（rt）に直に打たせない。rt の中では日本語入力が続かず、
 * 変換を始めた時点で入力が外れてしまう。ふつうの input なら IME が
 * そのまま効く。
 *
 * `pick` を渡すと、そのルビの読みを直す（読みをクリックしたとき）。
 */
function openRubyBox(pick?: HTMLElement): void {
  if (!rubyBox.hidden) {
    rubyReading.focus();
    rubyReading.select();
    return;
  }
  const { target, message } = session.rubyTarget(pick);
  if (!target) {
    statusMsg.textContent = message;
    statusMsg.classList.remove("err");
    return;
  }

  rubyBase.textContent = target.base;
  rubyReading.value = target.reading;
  rubyBox.hidden = false;
  placeRubyBox(target.rect);
  rubyReading.focus();
  rubyReading.select();
}

/** 小窓を、指した場所の近くかつ画面の中に収まる位置へ置く。 */
function placeBox(el: HTMLElement, near: DOMRect | null): void {
  const box = el.getBoundingClientRect();
  const margin = 8;
  const x = near ? near.left + near.width / 2 - box.width / 2 : window.innerWidth / 2 - box.width / 2;
  const y = near ? near.bottom + margin : window.innerHeight / 2;
  el.style.left = `${Math.min(Math.max(margin, x), window.innerWidth - box.width - margin)}px`;
  el.style.top = `${Math.min(Math.max(margin, y), window.innerHeight - box.height - margin)}px`;
}

function placeRubyBox(near: DOMRect | null): void {
  placeBox(rubyBox, near);
}

/** 小窓を閉じる。振らずに閉じただけなので、覚えた場所も捨てる。 */
function closeRubyBox(): void {
  if (rubyBox.hidden) return;
  rubyBox.hidden = true;
  session.cancelRuby();
  paper.focus();
}

rubyReading.addEventListener("keydown", (e) => {
  // 変換中の Enter と Esc は IME のもの。横取りすると変換が消える
  if (e.isComposing) return;
  if (e.key === "Enter") {
    // 検索バーなど、外側の Esc/Enter の始末に巻き込まれないようにする
    e.stopPropagation();
    e.preventDefault();
    const reading = rubyReading.value;
    rubyBox.hidden = true;
    void runNotationCommand(() => session.applyRuby(reading));
  } else if (e.key === "Escape") {
    e.stopPropagation();
    e.preventDefault();
    closeRubyBox();
  }
});
rubyReading.addEventListener("blur", () => closeRubyBox());

// 読みをクリックしたら、その場で直せるようにする。
// 本文の要素は作り直されるので、動かない親で受ける
viewport.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement | null)?.closest?.("rt");
  const ruby = el?.closest("ruby");
  if (ruby) openRubyBox(ruby as HTMLElement);
});

/* ---------- 類義語の小窓 ---------- */
const synBox = $<HTMLElement>("synBox");
const synWord = $<HTMLElement>("synWord");
const synList = $<HTMLElement>("synList");

/**
 * キャレット位置（または選択範囲）の語の類義語を出す。
 *
 * SudachiDict の同義語グループを Rust が引く。候補をクリックすると
 * その語で置き換える。グループが複数ある語（多義語）は、グループの
 * あいだに区切りを入れて出す。
 */
async function openSynBox(): Promise<void> {
  closeSynBox();
  try {
    const { hit, message, rect } = await session.lookupSynonyms();
    if (!hit) {
      statusMsg.textContent = message;
      statusMsg.classList.remove("err");
      return;
    }
    synWord.textContent = hit.word;
    synList.replaceChildren();
    let prevLabel = "";
    for (const group of hit.groups) {
      if (group.words.length === 0) continue;
      // 種類（言い換え / 同義 / 近い意味）が変わるところに見出しを、
      // 同じ種類のグループの切れ目（多義語の意味の違い）に区切りを置く
      if (group.label !== prevLabel) {
        const head = document.createElement("span");
        head.className = "syn-label";
        head.textContent = group.label;
        synList.appendChild(head);
        prevLabel = group.label;
      } else {
        const sep = document.createElement("span");
        sep.className = "syn-sep";
        synList.appendChild(sep);
      }
      for (const w of group.words) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = w;
        b.addEventListener("click", () => {
          synBox.hidden = true;
          void runNotationCommand(() => session.applySynonym(w));
        });
        synList.appendChild(b);
      }
    }
    synBox.hidden = false;
    placeBox(synBox, rect);
  } catch (err) {
    statusMsg.textContent = `エラー: ${String(err)}`;
    statusMsg.classList.add("err");
  }
}

/** 類義語の小窓を閉じる。 */
function closeSynBox(): void {
  if (synBox.hidden) return;
  synBox.hidden = true;
  session.cancelSynonym();
}

{
  const btn = $<HTMLButtonElement>("btnSynonym");
  // ボタンにフォーカスを奪わせない。奪われると本文のキャレットが
  // 消え、どの語を引けばよいか分からなくなる
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => void openSynBox());
}

/* ---------- ヘルプ ---------- */
const helpPanel = $<HTMLElement>("helpPanel");

function toggleHelp(show?: boolean): void {
  helpPanel.hidden = !(show ?? helpPanel.hidden);
}

$<HTMLButtonElement>("btnHelp").addEventListener("click", () => toggleHelp());
$<HTMLButtonElement>("helpClose").addEventListener("click", () => toggleHelp(false));

/**
 * ルビと傍点のコマンドを走らせて、結果を知らせる。
 *
 * 本文を直したときだけ「未保存」の印と文字数を更新する。
 * 書き方を知らせただけのときは、原稿は変わっていない。
 */
async function runNotationCommand(run: () => Promise<CommandResult>): Promise<void> {
  try {
    const res = await run();
    statusMsg.textContent = res.message;
    statusMsg.classList.remove("err");
    if (res.changed) {
      markDirty();
      updateStatus();
    }
  } catch (err) {
    statusMsg.textContent = `エラー: ${String(err)}`;
    statusMsg.classList.add("err");
  }
}

/**
 * 記法を変える。本文のルビと傍点も書き換える。
 *
 * 傍点の書き方がない記法（なろう・pixiv）へ移しても、中黒のルビで
 * 代用されるので傍点は消えない。読み取りでもその形を傍点として
 * 受けるため、戻せば元の書き方に戻る。
 */
async function changeNotation(next: Notation): Promise<void> {
  if (next === notation) return;
  const from = notationInfo(notation);
  const to = notationInfo(next);

  try {
    // 傍点の書き方がない記法（なろう・pixiv）へ移しても、中黒の
    // ルビで代用されるので傍点は失われない。断りは要らない。
    const converted = await convertNotation(notation, next);
    notation = next;
    saveNotation(notation);
    setNotationHint();
    await session.setNotation(notation);

    if (session.editMode === "preview") {
      await session.rebuildPreview(notation);
    } else {
      await session.setText(converted);
    }
    markDirty();

    const c = await countNotation(notation);
    statusMsg.textContent =
      `${from.label} → ${to.label}　ルビ ${c.ruby} / 傍点 ${c.emphasis}`;
    statusMsg.classList.remove("err");
  } catch (err) {
    notationSel.value = notation;
    statusMsg.textContent = `記法を変えられません: ${String(err)}`;
    statusMsg.classList.add("err");
  }
}

notationSel.addEventListener("change", () => void changeNotation(notationSel.value as Notation));

/** 表示モードを切り替える。 */
async function setMode(mode: EditMode): Promise<void> {
  if (mode === session.editMode) return;
  try {
    await session.setMode(mode, notation);
    modeSourceBtn.classList.toggle("is-on", mode === "source");
    modePreviewBtn.classList.toggle("is-on", mode === "preview");
    paper.dataset.mode = mode;
    statusMsg.textContent =
      mode === "preview" ? "プレビュー表示。ルビもその場で直せます" : "記法表示";
    statusMsg.classList.remove("err");
    updateStatus();
    scheduleSave();
  } catch (err) {
    statusMsg.textContent = `表示を切り替えられません: ${String(err)}`;
    statusMsg.classList.add("err");
  }
}

modeSourceBtn.addEventListener("click", () => void setMode("source"));
modePreviewBtn.addEventListener("click", () => void setMode("preview"));

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

/* ---------- 文体の報告 ---------- */
const report = $<HTMLElement>("report");
const reportSummary = $<HTMLElement>("reportSummary");
const reportFilter = $<HTMLElement>("reportFilter");
const reportList = $<HTMLElement>("reportList");

const ISSUE_KINDS: IssueKind[] = [
  "longsentence",
  "repeatedending",
  "nearbyrepeat",
  "overuse",
  "orthography",
];
const shownKinds = new Set<IssueKind>(ISSUE_KINDS);
let styleOptions: StyleOptions = loadOptions();

/* ---- しきい値の設定 ---- */
const optLongSentence = $<HTMLInputElement>("optLongSentence");
const optRepeatEndings = $<HTMLInputElement>("optRepeatEndings");
const optNearbyWindow = $<HTMLInputElement>("optNearbyWindow");
const optOverusePer1000 = $<HTMLInputElement>("optOverusePer1000");
const optOveruseWords = $<HTMLTextAreaElement>("optOveruseWords");

/** 設定値を入力欄へ流し込む。 */
function fillOptionInputs(o: StyleOptions): void {
  optLongSentence.value = String(o.longSentence);
  optRepeatEndings.value = String(o.repeatEndings);
  optNearbyWindow.value = String(o.nearbyWindow);
  optOverusePer1000.value = String(o.overusePer1000);
  optOveruseWords.value = o.overuseWords.join("\n");
}

/** 入力欄から設定値を読む。範囲外の値は既定に寄せる。 */
function readOptionInputs(): StyleOptions {
  const num = (el: HTMLInputElement, fallback: number): number => {
    const v = Number(el.value);
    if (!Number.isFinite(v)) return fallback;
    const min = Number(el.min);
    const max = Number(el.max);
    return Math.min(Number.isFinite(max) ? max : v, Math.max(Number.isFinite(min) ? min : v, v));
  };
  return {
    longSentence: Math.round(num(optLongSentence, DEFAULT_OPTIONS.longSentence)),
    repeatEndings: Math.round(num(optRepeatEndings, DEFAULT_OPTIONS.repeatEndings)),
    nearbyWindow: Math.round(num(optNearbyWindow, DEFAULT_OPTIONS.nearbyWindow)),
    overusePer1000: num(optOverusePer1000, DEFAULT_OPTIONS.overusePer1000),
    overuseWords: optOveruseWords.value
      .split("\n")
      .map((w) => w.trim())
      .filter((w) => w.length > 0),
  };
}

let optionTimer: number | null = null;

/** 設定が変わったら保存して調べ直す。打鍵のたびだと重いので少し待つ。 */
function onOptionsChanged(): void {
  if (optionTimer !== null) window.clearTimeout(optionTimer);
  optionTimer = window.setTimeout(() => {
    optionTimer = null;
    styleOptions = readOptionInputs();
    saveOptions(styleOptions);
    void refreshReport();
  }, 350);
}

for (const el of [
  optLongSentence,
  optRepeatEndings,
  optNearbyWindow,
  optOverusePer1000,
  optOveruseWords,
]) {
  el.addEventListener("input", onOptionsChanged);
}

$<HTMLButtonElement>("optReset").addEventListener("click", () => {
  styleOptions = { ...DEFAULT_OPTIONS };
  fillOptionInputs(styleOptions);
  saveOptions(styleOptions);
  void refreshReport();
});

fillOptionInputs(styleOptions);

function renderSummary(r: StyleReport): void {
  const rows: [string, string][] = [
    ["本文", `<b>${r.chars.toLocaleString()}</b> 字`],
    ["文の数", `<b>${r.sentences.toLocaleString()}</b>`],
    ["一文の平均", `<b>${r.avgSentence.toFixed(1)}</b> 字`],
    ["いちばん長い文", `<b>${r.maxSentence}</b> 字`],
    ["会話の割合", `<b>${(r.dialogueRatio * 100).toFixed(0)}</b> %`],
    ["副詞", `<b>${per1000(r.pos.adverb, r.chars).toFixed(1)}</b> 回/千字`],
    ["形容詞", `<b>${per1000(r.pos.adjective, r.chars).toFixed(1)}</b> 回/千字`],
    ["形容動詞", `<b>${per1000(r.pos.adjectivalNoun, r.chars).toFixed(1)}</b> 回/千字`],
  ];
  reportSummary.innerHTML =
    "<dl>" + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("") + "</dl>";
}

function renderFilter(r: StyleReport): void {
  reportFilter.replaceChildren();
  for (const kind of ISSUE_KINDS) {
    const n = r.issues.filter((i) => i.kind === kind).length;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${ISSUE_LABEL[kind]} ${n}`;
    b.classList.toggle("is-off", !shownKinds.has(kind));
    b.addEventListener("click", () => {
      if (shownKinds.has(kind)) shownKinds.delete(kind);
      else shownKinds.add(kind);
      b.classList.toggle("is-off", !shownKinds.has(kind));
      renderIssues(r);
    });
    reportFilter.appendChild(b);
  }
}

function renderIssues(r: StyleReport): void {
  reportList.replaceChildren();
  const list = r.issues.filter((i) => shownKinds.has(i.kind));
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "report-empty";
    li.textContent = r.issues.length === 0 ? "指摘はありません" : "表示する種類がありません";
    reportList.appendChild(li);
    return;
  }
  for (const issue of list) {
    const li = document.createElement("li");
    const kind = document.createElement("span");
    kind.className = `kind kind-${issue.kind}`;
    kind.textContent = ISSUE_LABEL[issue.kind];
    const msg = document.createElement("span");
    msg.textContent = issue.message;
    const ex = document.createElement("span");
    ex.className = "excerpt";
    ex.textContent = issue.excerpt;
    li.title = "クリックでその箇所へ。もう一度押すか Esc で強調を解きます";
    li.append(kind, msg, ex);
    li.addEventListener("click", () => jumpToIssue(issue, li));
    reportList.appendChild(li);
  }
}

/** いま強調している指摘の行。強調を解くときに使う */
let currentIssueEl: HTMLElement | null = null;

/** 指摘の強調が出ているか。 */
function hasIssueHighlight(): boolean {
  if (currentIssueEl) return true;
  return MarkerLayer.supported && CSS.highlights.has("issue-current");
}

/** 指摘の強調を解く。 */
function clearIssueHighlight(): void {
  if (!hasIssueHighlight()) return;
  if (MarkerLayer.supported) CSS.highlights.delete("issue-current");
  currentIssueEl?.classList.remove("is-current");
  currentIssueEl = null;
}

/**
 * 指摘箇所へ飛んで強調する。
 * すでに同じ指摘を選んでいたら強調を解く（押すたびに切り替わる）。
 */
function jumpToIssue(issue: Issue, li: HTMLElement): void {
  if (currentIssueEl === li) {
    clearIssueHighlight();
    return;
  }
  clearIssueHighlight();

  const el = paper.children[issue.para] as HTMLElement | undefined;
  if (!el) return;
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;

  const len = (node as Text).length;
  const start = Math.min(issue.start, len);
  const end = Math.min(issue.end, len);
  if (start >= end) return;

  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  scroller.revealRange(range);

  if (MarkerLayer.supported) {
    CSS.highlights.set("issue-current", new Highlight(range));
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  li.classList.add("is-current");
  currentIssueEl = li;
}

// 本文に触れたら強調を解く。
// paper は undo 履歴を捨てるときに作り直されるので、
// 要素に直接ではなく document で受けて中身かどうかで判定する。
document.addEventListener("pointerdown", (e) => {
  const t = e.target as Node;
  if (paper.contains(t)) clearIssueHighlight();
  // 類義語の小窓とヘルプは、外を突いたら閉じる
  if (!synBox.hidden && !synBox.contains(t)) closeSynBox();
  if (
    !helpPanel.hidden &&
    !helpPanel.contains(t) &&
    !(t instanceof Element && t.closest("#btnHelp"))
  ) {
    toggleHelp(false);
  }
});

async function refreshReport(): Promise<void> {
  if (report.hidden) return;
  try {
    // 一覧を作り直すと、強調していた行が DOM から外れる
    clearIssueHighlight();
    reportList.replaceChildren();
    const li = document.createElement("li");
    li.className = "report-empty";
    li.textContent = "調べています…";
    reportList.appendChild(li);

    const r = await fetchReport(styleOptions);
    renderSummary(r);
    renderFilter(r);
    renderIssues(r);
  } catch (err) {
    reportList.replaceChildren();
    const li = document.createElement("li");
    li.className = "report-empty";
    li.textContent = `調べられません: ${String(err)}`;
    reportList.appendChild(li);
  }
}

function toggleReport(show?: boolean): void {
  const next = show ?? report.hidden;
  report.hidden = !next;
  if (next) void refreshReport();
  else clearIssueHighlight();
  fitCellToViewport();
  scroller.calibrate();
}

$<HTMLButtonElement>("btnReport").addEventListener("click", () => toggleReport());
$<HTMLButtonElement>("reportClose").addEventListener("click", () => toggleReport(false));
$<HTMLButtonElement>("reportRefresh").addEventListener("click", () => void refreshReport());

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
    if (k === "r") {
      // ルビ。何も選んでいなければ、いまの記法の書き方を知らせる
      e.preventDefault();
      openRubyBox();
      return;
    }
    if (k === "b") {
      // 傍点の付け外し。ブラウザの太字が走らないよう先に止める
      e.preventDefault();
      void runNotationCommand(() => session.toggleEmphasis());
      return;
    }
    if (k === "q" || k === "i" || k === "t") {
      // 類義語。キャレット位置（または選択範囲）の語を引く。
      // 主は Ctrl+Q（左手だけで届く）。Ctrl+I も生かしてある。
      // Ctrl+T は WebView2 がブラウザ側のアクセラレータ（タブ操作）
      // として食ってしまい、ページに届かない環境がある。素の
      // ブラウザでは効くので残しておく。Ctrl+I 既定の斜体も止まる
      e.preventDefault();
      void openSynBox();
      return;
    }
    if (k === "e") {
      e.preventDefault();
      void setMode(session.editMode === "source" ? "preview" : "source");
      return;
    }
    if (k === "p") {
      // ブラウザ既定の印刷でも刷れるが、強調を消してから出したい
      e.preventDefault();
      doPrint();
      return;
    }
  }

  // F3 は本文にフォーカスがあっても効かせる
  if (e.key === "F3" && !findbar.hidden) {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "Escape") {
    // 類義語の小窓がいちばん手前。次にヘルプ、検索バー、最後に強調
    if (!synBox.hidden) {
      e.preventDefault();
      closeSynBox();
      return;
    }
    if (!helpPanel.hidden) {
      e.preventDefault();
      toggleHelp(false);
      return;
    }
    // 検索バーが開いていればそちらを優先し、次の Esc で強調を解く
    if (!findbar.hidden) {
      e.preventDefault();
      closeFind();
      return;
    }
    if (hasIssueHighlight()) {
      e.preventDefault();
      clearIssueHighlight();
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
  } else if (e.key === "End" && e.ctrlKey) {
    scroller.toTail();
    e.preventDefault();
  }
});

/* ---------- 起動 ---------- */

/* 覚えていた設定を画面に配る。
   つまみの値と実際の状態がずれると、次に保存したときに食い違うので、
   ここで一度に揃えてしまう。 */
presetSel.value = settings.preset === "custom" ? "custom" : presetFor(layout);
charsInput.value = String(layout.chars);
linesInput.value = String(layout.lines);
fontSel.value = layout.font;
gridSel.value = settings.grid;
themeSel.value = theme;
markStyleSel.value = settings.markStyle;
for (const cb of posChecks) cb.checked = settings.pos.includes(cb.dataset.pos as PosTag);
btnMarker.classList.toggle("is-on", settings.markerOn);
session.marker.setOptions({
  style: settings.markStyle,
  enabled: settings.markerOn,
  visible: new Set(settings.pos),
});
applyGrid(settings.grid);

applyLayout(layout);
fitCellToViewport();
void loadInstalledFonts();
void currentPath().then(setStatusFile).catch(() => setStatusFile(null));
if (!MarkerLayer.supported) {
  statusMsg.textContent = "CSS Custom Highlight API が使えないため、マーカーは表示されません";
  statusMsg.classList.add("err");
}
// ルビと傍点のコマンドは、プレビューを開いていなくても記法の書き方が要る
void session.setNotation(notation);
void session.setText(SAMPLE).then(async () => {
  // 本文が入ってからでないと、プレビューも組めないしスクロール量も測れない
  if (settings.preview) await setMode("preview");
  scroller.calibrate();
  scroller.toHead();
  paper.focus();
});
