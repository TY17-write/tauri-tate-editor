/**
 * contenteditable の DOM 操作。
 *
 * 本文は「1段落 = 1つの <p>」で保つ。この構造が崩れると、マーカーの
 * Range を張る相手が分からなくなり、Rust 側の段落モデルとも対応が取れなくなる。
 *
 * ブラウザは contenteditable の中で勝手に <div> や <br> を作るので、
 * 改行だけは beforeinput で横取りして自前で段落を割る。それでも崩れた
 * ときのために normalizeStructure() を用意してある。
 */

/** 空段落の高さを保つための文字（ゼロ幅スペース）。 */
export const EMPTY_PARA = "​";

/** 段落要素を1つ作る。 */
export function createPara(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text.length ? text : EMPTY_PARA;
  return p;
}

/** 表示用のテキストから、モデルに渡す実テキストへ。 */
function paraText(el: Element): string {
  const t = el.textContent ?? "";
  return t === EMPTY_PARA ? "" : t.replace(/​/g, "");
}

/** 現在の DOM から段落テキストの配列を取り出す。 */
export function readLines(paper: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of Array.from(paper.children)) out.push(paraText(el));
  return out;
}

/** 本文全体を改行区切りで取り出す。 */
export function readText(paper: HTMLElement): string {
  return readLines(paper).join("\n");
}

/** 本文を丸ごと差し替える。キャレットは保持しない。 */
export function writeText(paper: HTMLElement, text: string): void {
  const frag = document.createDocumentFragment();
  for (const line of text.split("\n")) frag.appendChild(createPara(line));
  paper.replaceChildren(frag);
}

/* ============================================================
   キャレット位置の保存と復元

   要素を作り直すと Selection のノード参照が無効になるので、
   本文先頭からの文字オフセットで持ち回る。
   ============================================================ */

/** キャレット位置を、本文先頭からの文字数で返す。 */
export function caretOffset(paper: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!paper.contains(range.startContainer)) return null;

  const probe = document.createRange();
  probe.selectNodeContents(paper);
  probe.setEnd(range.startContainer, range.startOffset);
  // 段落の区切りも 1 文字（改行）として数える
  const before = probe.cloneContents();
  const paras = before.querySelectorAll("p").length;
  return probe.toString().replace(/​/g, "").length + Math.max(0, paras - 1);
}

/** 文字オフセットで指定した位置へキャレットを戻す。 */
export function setCaretOffset(paper: HTMLElement, offset: number): void {
  let remain = offset;
  for (const el of Array.from(paper.children)) {
    const len = paraText(el).length;
    if (remain <= len) {
      const node = el.firstChild;
      const sel = window.getSelection();
      const range = document.createRange();
      if (node && node.nodeType === Node.TEXT_NODE) {
        const max = (node as Text).length;
        range.setStart(node, Math.min(remain, max));
      } else {
        range.setStart(el, 0);
      }
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    remain -= len + 1; // 段落の区切り分
  }
  // 行き過ぎたら末尾へ
  const last = paper.lastElementChild;
  if (last) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

/* ============================================================
   構造の維持
   ============================================================ */

/** すべての子が <p> で、かつ中身がテキストノード1つだけか。 */
export function isStructureClean(paper: HTMLElement): boolean {
  for (const el of Array.from(paper.childNodes)) {
    if (el.nodeType !== Node.ELEMENT_NODE) return false;
    if ((el as Element).tagName !== "P") return false;
    const p = el as Element;
    if (p.childNodes.length > 1) return false;
    if (p.firstChild && p.firstChild.nodeType !== Node.TEXT_NODE) return false;
  }
  return paper.childNodes.length > 0;
}

/**
 * 崩れた構造を「1段落 = 1つの <p>」に直す。
 * キャレットは文字オフセットで保存・復元する。
 *
 * 戻り値は実際に直したかどうか。
 */
export function normalizeStructure(paper: HTMLElement): boolean {
  if (isStructureClean(paper)) return false;
  const caret = caretOffset(paper);
  const text = (paper.innerText ?? "").replace(/​/g, "");
  writeText(paper, text.length ? text : "");
  if (caret !== null) setCaretOffset(paper, caret);
  return true;
}

/**
 * キャレット位置で段落を割る。Enter の自前処理。
 *
 * ブラウザ任せにすると <div> や <br> が入って構造が崩れるため、
 * beforeinput の insertParagraph を横取りしてここを呼ぶ。
 */
export function splitAtCaret(paper: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!paper.contains(range.startContainer)) return;

  // 選択範囲があれば先に消す
  if (!range.collapsed) range.deleteContents();

  const para = findPara(paper, range.startContainer);
  if (!para) return;

  const node = para.firstChild;
  const full = node && node.nodeType === Node.TEXT_NODE ? (node as Text).data : "";
  const clean = full === EMPTY_PARA ? "" : full;

  let at = 0;
  if (node && range.startContainer === node) {
    at = range.startOffset;
    if (full === EMPTY_PARA) at = 0;
  } else if (range.startContainer === para) {
    at = range.startOffset === 0 ? 0 : clean.length;
  }

  const head = clean.slice(0, at);
  const tail = clean.slice(at);

  para.textContent = head.length ? head : EMPTY_PARA;
  const next = createPara(tail);
  para.after(next);

  const r = document.createRange();
  const target = next.firstChild;
  if (target && target.nodeType === Node.TEXT_NODE) {
    r.setStart(target, tail.length ? 0 : (target as Text).length);
  } else {
    r.setStart(next, 0);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** ノードが属する段落要素を探す。 */
function findPara(paper: HTMLElement, node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== paper) {
    if (cur.nodeType === Node.ELEMENT_NODE && (cur as Element).tagName === "P") {
      return cur as HTMLElement;
    }
    cur = cur.parentNode;
  }
  return null;
}
