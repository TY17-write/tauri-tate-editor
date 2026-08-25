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
  // CRLF や CR で渡されても段落に割れるようにしておく
  for (const line of text.split(NEWLINE_G)) frag.appendChild(createPara(line));
  paper.replaceChildren(frag);
}

/* ============================================================
   キャレット位置の保存と復元

   要素を作り直すと Selection のノード参照が無効になるので、
   本文先頭からの文字オフセットで持ち回る。
   ============================================================ */

/**
 * ノードと中の位置を、本文先頭からの文字数に直す。
 *
 * 段落の区切りも 1 文字（改行）として数える。
 * Range#toString は textContent 相当なので、傍線モードの span や
 * プレビューの塊をまたいでも文字数はそのまま数えられる。
 */
function offsetOf(paper: HTMLElement, node: Node, offset: number): number | null {
  if (!paper.contains(node)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(paper);
  probe.setEnd(node, offset);
  const paras = probe.cloneContents().querySelectorAll("p").length;
  return probe.toString().length + Math.max(0, paras - 1);
}

/** 文字オフセットに当たる DOM の位置を探す。 */
function pointOf(paper: HTMLElement, offset: number): { node: Node; offset: number } | null {
  let remain = offset;
  for (const el of Array.from(paper.children)) {
    const len = paraText(el).length;
    if (remain <= len) {
      // 段落内のテキストノードを順に辿る。傍線モードでは
      // sidemark の span に分かれているので、先頭の子だけを
      // 見ていると span の内側へキャレットを戻せない。
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const l = (node as Text).length;
        if (acc + l >= remain) return { node, offset: remain - acc };
        acc += l;
      }
      return { node: el, offset: el.childNodes.length };
    }
    remain -= len + 1; // 段落の区切り分
  }
  // 行き過ぎたら末尾へ
  const last = paper.lastElementChild;
  return last ? { node: last, offset: last.childNodes.length } : null;
}

/** キャレット位置を、本文先頭からの文字数で返す。 */
export function caretOffset(paper: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return offsetOf(paper, range.startContainer, range.startOffset);
}

/**
 * いま選んでいる範囲を、本文先頭からの文字数で返す。
 *
 * マーカーの描画が DOM を書き換えるとき、キャレットだけでなく
 * 選択範囲も保つのに使う。始点だけを覚えて戻すと、選んでいた
 * 範囲が畳まれてしまう。
 */
export function selectionOffsets(paper: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = offsetOf(paper, range.startContainer, range.startOffset);
  const end = offsetOf(paper, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return { start, end };
}

/** 文字オフセットで指定した位置へキャレットを戻す。 */
export function setCaretOffset(paper: HTMLElement, offset: number): void {
  setSelectionOffsets(paper, offset, offset);
}

/** 文字オフセットで指定した範囲を選び直す。 */
export function setSelectionOffsets(paper: HTMLElement, start: number, end: number): void {
  const head = pointOf(paper, start);
  const tail = pointOf(paper, Math.max(start, end));
  if (!head || !tail) return;

  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(head.node, head.offset);
  try {
    range.setEnd(tail.node, tail.offset);
  } catch {
    // 終点が始点より前になることはないはずだが、崩れていたら畳む
    range.collapse(true);
  }
  sel?.removeAllRanges();
  sel?.addRange(range);
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
  if (n.nodeType === Node.TEXT_NODE) {
    // 生の改行がテキストノードに残っていてはいけない。
    // 段落は <p> で表すのが約束で、readText はそれを \n で繋ぐ。
    // 文字として \n が混ざると、モデル側で段落が余分に割れて
    // DOM と段落数が食い違う。
    return !NEWLINE.test(n.nodeValue ?? "");
  }
  return (
    n.nodeType === Node.ELEMENT_NODE &&
    (n as Element).tagName === "SPAN" &&
    (n as Element).classList.contains("sidemark")
  );
}

/** 改行の表記ゆれ。ペーストや読み込みで CRLF や CR が入ることがある。 */
const NEWLINE = /\r\n|\r|\n/;
const NEWLINE_G = /\r\n|\r|\n/g;

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

  // テキストに残った生の改行はここで段落に割る。
  // textContent は <br> を無視する一方 \n はそのまま残すので、
  // 割らずに積むと 1 つの <p> が複数行を抱えたままになり、
  // モデル側の段落数と食い違う。
  const push = (s: string): void => {
    for (const line of s.split(NEWLINE_G)) lines.push(line);
  };

  for (const node of Array.from(paper.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      // <p> の外に投げ出された裸のテキスト
      const t = node.nodeValue ?? "";
      if (t.length) push(t);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (el.tagName === "BR") {
      // paper の直下に来た <br> だけは、段落の切れ目として扱う
      lines.push("");
      continue;
    }
    // <p> でも <div> でも、中身のテキストを段落にする。
    // 段落内の <br> は textContent が無視するので改行にならない。
    push(el.textContent ?? "");
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
 *
 * 段落の中身をテキストとして組み直してはいけない。プレビューでは
 * ルビや傍点の要素が入っていて、textContent で組み直すと読みが
 * 本文に混ざって消える。Range で切り出して、要素はそのまま移す。
 */
export function splitAtCaret(paper: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!paper.contains(range.startContainer)) return;

  // 選択範囲があれば先に消す
  if (!range.collapsed) range.deleteContents();

  const para = paraOf(paper, range.startContainer);
  if (!para) return;

  // ルビや傍点の中で割ると、記法が二つに割れて意味が変わってしまう。
  // 塊の中にキャレットがあるときは、塊の後ろを切れ目にする。
  const atom = findAtom(para, range.startContainer);
  const cut = document.createRange();
  if (atom) cut.setStartAfter(atom);
  else cut.setStart(range.startContainer, range.startOffset);
  cut.setEnd(para, para.childNodes.length);

  const next = createPara("");
  next.appendChild(cut.extractContents());

  // 切り出しで分かれたテキストノードを繋ぎ直す。空になった側は
  // normalize() が空のテキストノードごと落としてくれる。
  // ダミー文字を入れてはいけない（Rust へ送る本文とずれる）。
  para.normalize();
  next.normalize();
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

/**
 * キャレット位置に、改行を含みうるテキストを挿入する。
 *
 * ブラウザ任せにすると生の改行がテキストノードに残り、モデル側で
 * 段落が余分に割れて DOM と食い違う（青空文庫からの貼り付けで実際に
 * 起きた）。改行のところで段落を割りながら入れる。
 */
export function insertTextAtCaret(paper: HTMLElement, text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!paper.contains(range.startContainer)) return;
  if (!range.collapsed) range.deleteContents();

  const lines = text.split(NEWLINE_G);
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) splitAtCaret(paper);
    if (lines[i].length) insertPlain(paper, lines[i]);
  }
}

/**
 * 改行を含まない文字列をキャレット位置に入れる。
 *
 * 段落の本文を textContent で組み立て直してはいけない。プレビューでは
 * ルビの読みまで本文に混ざってしまう。Range に入れてから、分かれた
 * テキストノードを normalize() で繋ぎ直す。
 *
 * テキストノードを分けたままにすると、段落内のノードが増えて
 * マーカーの位置合わせが余計に複雑になる。normalize() のあとは
 * 記法表示ならテキストノード 1 つに戻る。
 */
function insertPlain(paper: HTMLElement, s: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const para = paraOf(paper, range.startContainer);
  if (!para) return;

  // normalize() でノードが入れ替わるので、キャレットは文字数で覚える
  const at = caretOffset(paper);
  range.insertNode(document.createTextNode(s));
  para.normalize();
  if (at !== null) setCaretOffset(paper, at + s.length);
}

/** ノードが属する段落要素を探す。 */
export function paraOf(paper: HTMLElement, node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== paper) {
    if (cur.nodeType === Node.ELEMENT_NODE && (cur as Element).tagName === "P") {
      return cur as HTMLElement;
    }
    cur = cur.parentNode;
  }
  return null;
}

/**
 * ノードが属するルビ・傍点・見出し記号の塊を探す。
 *
 * プレビューの塊は `data-src` を持っている。段落そのものに行き
 * 当たったら塊の外。
 */
function findAtom(para: HTMLElement, node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== para) {
    if (cur.nodeType === Node.ELEMENT_NODE && (cur as HTMLElement).dataset.src !== undefined) {
      return cur as HTMLElement;
    }
    cur = cur.parentNode;
  }
  return null;
}
