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

/**
 * 段落要素を1つ作る。
 *
 * 空段落にダミー文字を入れてはいけない。DOM のテキストが Rust へ
 * 送る本文とずれ、マーカーの位置がその分ずれる。
 * 空段落が潰れないようにするのは CSS（`p:empty::before`）の役目。
 */
export function createPara(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  if (text.length) p.textContent = text;
  return p;
}

/** 段落要素のテキスト。DOM の文字列がそのままモデルの文字列になる。 */
function paraText(el: Element): string {
  return el.textContent ?? "";
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
  // 段落の区切りも 1 文字（改行）として数える。
  // Range#toString は textContent 相当なので、傍線モードの span を
  // またいでも文字数はそのまま数えられる。
  const before = probe.cloneContents();
  const paras = before.querySelectorAll("p").length;
  return probe.toString().length + Math.max(0, paras - 1);
}

/** 文字オフセットで指定した位置へキャレットを戻す。 */
export function setCaretOffset(paper: HTMLElement, offset: number): void {
  let remain = offset;
  for (const el of Array.from(paper.children)) {
    const len = paraText(el).length;
    if (remain <= len) {
      const sel = window.getSelection();
      const range = document.createRange();

      // 段落内のテキストノードを順に辿る。傍線モードでは
      // sidemark の span に分かれているので、先頭の子だけを
      // 見ていると span の内側へキャレットを戻せない。
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let placed = false;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const l = (node as Text).length;
        if (acc + l >= remain) {
          range.setStart(node, remain - acc);
          placed = true;
          break;
        }
        acc += l;
      }
      if (!placed) range.setStart(el, el.childNodes.length);

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

/**
 * 段落の中身として許される子ノードか。
 *
 * テキストノードのほか、傍線（右）モードが挿す sidemark の span を
 * 認める。これを認めないと、傍線を出すたびに構造が汚れていると
 * 判定され、修復と再描画を延々と繰り返すことになる。
 */
function isCleanChild(n: Node): boolean {
  if (n.nodeType === Node.TEXT_NODE) return true;
  return (
    n.nodeType === Node.ELEMENT_NODE &&
    (n as Element).tagName === "SPAN" &&
    (n as Element).classList.contains("sidemark")
  );
}

/** すべての子が <p> で、その中身がテキストか sidemark の span だけか。 */
export function isStructureClean(paper: HTMLElement): boolean {
  for (const el of Array.from(paper.childNodes)) {
    if (el.nodeType !== Node.ELEMENT_NODE) return false;
    if ((el as Element).tagName !== "P") return false;
    for (const child of Array.from(el.childNodes)) {
      if (!isCleanChild(child)) return false;
    }
  }
  return paper.childNodes.length > 0;
}

/**
 * 崩れた構造を「1段落 = 1つの <p>」に直す。
 * キャレットは文字オフセットで保存・復元する。
 *
 * 段落の並びは DOM の構造から直接組み立てる。ここで
 * `paper.innerText` を使ってはいけない。innerText は <br> を
 * 改行に変換するため、ブラウザが段落内に挿入した <br> が
 * 本物の改行に化けて、段落が勝手に増える。
 * `textContent` は <br> を無視するので、段落は分裂しない。
 *
 * 戻り値は実際に直したかどうか。
 */
export function normalizeStructure(paper: HTMLElement): boolean {
  if (isStructureClean(paper)) return false;
  const caret = caretOffset(paper);

  const lines: string[] = [];
  for (const node of Array.from(paper.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      // <p> の外に投げ出された裸のテキスト。1段落として拾う
      const t = node.nodeValue ?? "";
      if (t.length) lines.push(t);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (el.tagName === "BR") {
      // paper の直下に来た <br> だけは、段落の切れ目として扱う
      lines.push("");
      continue;
    }
    // <p> でも <div> でも、中身のテキストを1段落とする。
    // 段落内の <br> は textContent が無視するので改行にならない。
    lines.push(el.textContent ?? "");
  }

  const frag = document.createDocumentFragment();
  if (lines.length === 0) lines.push("");
  for (const line of lines) frag.appendChild(createPara(line));
  paper.replaceChildren(frag);

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
  const clean = node && node.nodeType === Node.TEXT_NODE ? (node as Text).data : "";

  let at = 0;
  if (node && range.startContainer === node) {
    at = range.startOffset;
  } else if (range.startContainer === para) {
    at = range.startOffset === 0 ? 0 : clean.length;
  }

  const head = clean.slice(0, at);
  const tail = clean.slice(at);

  // 空になる側はテキストノードを持たせない。ダミー文字を入れると
  // Rust へ送る本文とずれてマーカーの位置が狂う。
  if (head.length) para.textContent = head;
  else para.replaceChildren();

  const next = createPara(tail);
  para.after(next);

  const r = document.createRange();
  const target = next.firstChild;
  if (target && target.nodeType === Node.TEXT_NODE) {
    r.setStart(target, 0);
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
