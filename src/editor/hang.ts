/**
 * 行末の句読点のぶら下げ（ぶら下がり組み）。
 *
 * 行末に入りきらない句読点は、既定では行頭禁則により前の字ごと
 * 次の行へ送られる（追い出し）。ぶら下げでは、句読点を升の外
 * （行末の先）へはみ出させて、前の行に留める。
 *
 * CSS の hanging-punctuation は Chromium 148 でも未実装（実測）。
 * そこで升が完全等幅であることを利用して自前で行う。
 *
 *  1. 「追い出された」句読点を実測で見つける。
 *     前の字が行頭に立っていて、かつ前の行にその字のぶんの空きが
 *     残っていれば、それは自然な折り返しではなく追い出し
 *  2. その句読点を letter-spacing: -1em の span (.hang) で包む。
 *     字送りが 0 になるのでブレーカーには行に収まったと見え、
 *     グリフだけが升の外へはみ出して、ぶら下がりになる
 *
 * margin-inline-end の負値はブレーカーが折り返しの計算に入れて
 * くれないため使えない（実測）。letter-spacing は字送りそのものを
 * 変えるので効く。
 *
 * 編集で本文が動くとぶら下げの場所も変わる。正しいぶら下げは
 * 「グリフが行の長さのちょうど先に出ている」ので、そこから外れた
 * span はほどいてから、探し直す。
 */

/** ぶら下げる字。全角の句読点だけ（読点・句点とその横書き形）。 */
const PUNCT = /[、。，．]/;

/**
 * 行頭に置けない字。ぶら下げた句読点の次がこれだと、その字が
 * 行頭に来られずにまた折り返しが乱れるので、下げずに追い出しの
 * ままにしておく。
 */
const HEAD_FORBIDDEN =
  /[、。，．」』）｝〕】》〉ゝゞ々ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ・：；！？…‥]/;

/** 1 文字ぶんの居場所。rect はその字の占める枠。 */
interface Unit {
  node: Text;
  index: number;
  ch: string;
  /** ぶら下げ候補になれるか（塊やぶら下げ済みの中は不可） */
  candidate: boolean;
}

/**
 * 用紙全体のぶら下げを整える。DOM を書き換えたら true。
 *
 * span を挿すのでキャレットが飛びうる。呼び出し側（session）が
 * 選択範囲を文字数で覚えて戻す。IME 変換中には呼ばないこと。
 */
export function applyHanging(paper: HTMLElement): boolean {
  const cs = getComputedStyle(document.documentElement);
  const cell = parseFloat(cs.getPropertyValue("--cell"));
  const chars = parseFloat(cs.getPropertyValue("--chars"));
  if (!Number.isFinite(cell) || !Number.isFinite(chars) || cell <= 0 || chars <= 0) {
    return false;
  }
  const measure = cell * chars;

  let touched = false;
  for (const para of Array.from(paper.children) as HTMLElement[]) {
    if (para.tagName !== "P") continue;
    if (hangPara(para, measure)) touched = true;
  }
  return touched;
}

function hangPara(para: HTMLElement, measure: number): boolean {
  let touched = false;

  // 場所の合わなくなったぶら下げをほどく。
  // 送り幅 0 のまま行の途中に来ると、次の字と重なってしまう
  for (const span of Array.from(para.querySelectorAll<HTMLElement>("span.hang"))) {
    const text = span.textContent ?? "";
    const top = span.getBoundingClientRect().top - para.getBoundingClientRect().top;
    if (text.length === 1 && Math.abs(top - measure) < 1) continue;
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    touched = true;
  }
  if (touched) para.normalize();

  // 追い出された句読点を前から順に包む。包むと後ろの折り返しが
  // 変わるので、1 つ包むたびに測り直す。回数の上限は保険
  for (let guard = 0; guard < 64; guard++) {
    const spot = findPushedPunct(para, measure);
    if (!spot) break;
    wrapChar(spot.node, spot.index);
    touched = true;
  }
  return touched;
}

/** 段落の中の字を、画面に出ている順に並べる。読み（rt）は飛ばす。 */
function listUnits(para: HTMLElement): Unit[] {
  const out: Unit[] = [];
  const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const el = t.parentElement;
    if (!el) continue;
    if (el.closest("rt, rp")) continue;
    // ルビ・傍点・見出し記号の塊と、ぶら下げ済みの span の中は
    // 候補にしない（塊は組み直しで span が消えるし、傍点は文字ごとの
    // 入れ物と衝突する）。位置測りの隣としては使う
    const candidate = el.closest("[data-src], .hang") === null;
    for (let i = 0; i < t.length; i++) {
      out.push({ node: t, index: i, ch: t.data[i], candidate });
    }
  }
  return out;
}

/** 1 文字の枠。 */
function rectOf(u: Unit): DOMRect {
  const r = document.createRange();
  r.setStart(u.node, u.index);
  r.setEnd(u.node, u.index + 1);
  return r.getBoundingClientRect();
}

/**
 * 追い出された句読点を探す。見つからなければ null。
 *
 * 印は「前の字が行頭に立っている」かつ「その前の行に、前の字の
 * ぶんの空きが残っている」。行が満杯で自然に折り返しただけなら
 * 空きは無い。
 */
function findPushedPunct(para: HTMLElement, measure: number): { node: Text; index: number } | null {
  const paraTop = para.getBoundingClientRect().top;
  const units = listUnits(para);

  for (let k = 2; k < units.length; k++) {
    const u = units[k];
    if (!u.candidate || !PUNCT.test(u.ch)) continue;

    const next = units[k + 1];
    if (next && HEAD_FORBIDDEN.test(next.ch)) continue;

    // 前の字が行頭に立っているか
    const prev = units[k - 1];
    const prevRect = rectOf(prev);
    if (prevRect.top - paraTop > 0.5) continue;

    // その前の行に、前の字のぶんの空きが残っているか
    const prev2 = units[k - 2];
    const prev2Rect = rectOf(prev2);
    const free = measure - (prev2Rect.bottom - paraTop);
    if (free < prevRect.height - 0.5) continue;

    return { node: u.node, index: u.index };
  }
  return null;
}

/** その 1 文字を .hang の span で包む。 */
function wrapChar(node: Text, index: number): void {
  const target = index > 0 ? node.splitText(index) : node;
  if (target.length > 1) target.splitText(1);
  // contenteditable=false にしてはいけない。span が段落の末尾に
  // 来ると、その後ろに置けるキャレット位置が無くなり、文末で
  // 編集できなくなる（実害があった）。span は編集可能なままにして、
  // キャレットが中に入らないよう selectionchange で外へ出す
  // （session.ts を参照）。中に入ったまま書くと、IME の変換中
  // 文字列まで letter-spacing: -1em を継いでマスに載らなくなる。
  const span = document.createElement("span");
  span.className = "hang";
  target.parentNode?.insertBefore(span, target);
  span.appendChild(target);
}
