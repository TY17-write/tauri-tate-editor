/**
 * 段落の中身を「記法テキストのどこに当たるか」で並べ直す。
 *
 * 記法表示では段落の中身はテキストノード1つなので、Rust が返す
 * マーカーのオフセットをそのまま使えた。プレビューでは段落の中に
 * ルビや傍点の塊が混ざり、しかも塊は画面に出る文字（親文字）と
 * 記法テキスト（`|漢字《かんじ》`）で長さが違う。
 *
 * そこで、段落の子ノードを順に見て
 *  ・テキストノード  … 記法テキストと1対1で対応する
 *  ・data-src を持つ塊 … 記法テキストでは `src` の長さぶんを占め、
 *                        画面に出るのはそのうち `data-text` の部分
 * という区間の並びに直しておく。マーカーの位置は必ずこの並びを
 * 通してから DOM に写す。
 */

/** 記法テキスト上の範囲。マーカーも選択範囲もこの形で受ける。 */
export interface SrcRange {
  start: number;
  end: number;
}

/** 段落の中身の一区間。位置はすべて記法テキストでの UTF-16 オフセット。 */
export interface Segment {
  start: number;
  end: number;
  /** テキストノード。塊のときは null */
  text: Text | null;
  /** ルビ・傍点・見出し記号の塊。テキストのときは null */
  atom: HTMLElement | null;
  /** 画面に出ている文字が記法テキストのどこに当たるか */
  shownStart: number;
  shownEnd: number;
}

/** 段落の中身を区間の並びに直す。 */
export function readSegments(el: HTMLElement): Segment[] {
  const out: Segment[] = [];
  walk(el, out, 0);
  return out;
}

/** 区間の並びが表す記法テキストの長さ。 */
export function srcLength(segs: Segment[]): number {
  return segs.length ? segs[segs.length - 1].end : 0;
}

function walk(parent: Node, out: Segment[], at: number): number {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      out.push({
        start: at,
        end: at + t.length,
        text: t,
        atom: null,
        shownStart: at,
        shownEnd: at + t.length,
      });
      at += t.length;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const el = node as HTMLElement;
    const src = el.dataset.src;
    if (src === undefined) {
      // 塊ではない要素（傍線モードの span など）は中身を数える
      at = walk(el, out, at);
      continue;
    }

    // 画面に出ている文字が記法のどこに当たるかを探す。
    // 見つからない（見出し記号のように data-text を持たない）ときは
    // 空の範囲にして、マーカーが掛からないようにする。
    const shown = el.dataset.text ?? "";
    const rel = shown.length ? src.indexOf(shown) : -1;
    const shownStart = rel < 0 ? at : at + rel;
    out.push({
      start: at,
      end: at + src.length,
      text: null,
      atom: el,
      shownStart,
      shownEnd: rel < 0 ? shownStart : shownStart + shown.length,
    });
    at += src.length;
  }
  return at;
}

/**
 * 傍点の塊の中の、印を付ける範囲。位置は塊の中の表示文字で数える。
 *
 * 傍点はゴマ点を文字の外側（縦書きなら右脇）に描いている。そこへ
 * ハイライトや傍線を重ねると点が潰れて読めなくなる（実測）。かと
 * いって塊まるごとを色付けすると、解析した語と対応しなくなる。
 * 塊の中は span で語を囲み、要素の色で示す。
 */
export interface AtomHit {
  atom: HTMLElement;
  start: number;
  end: number;
}

/** マーカー1件が段落のどこに掛かるか。 */
export interface MarkHit {
  /** ハイライトや傍線で塗る範囲 */
  ranges: Range[];
  /** 塊の中に span を挿して示す範囲 */
  atoms: AtomHit[];
}

/**
 * マーカー1件が段落のどこに掛かるかを調べる。
 *
 * 塊にまたがるマーカーは区間ごとに分かれるので、範囲は複数に
 * なりうる。掛かるところがなければどちらも空。
 */
export function markHits(segs: Segment[], mark: SrcRange): MarkHit {
  const ranges: Range[] = [];
  const atoms: AtomHit[] = [];
  for (const s of segs) {
    const a = Math.max(mark.start, s.start);
    const b = Math.min(mark.end, s.end);
    if (a >= b) continue;

    if (s.text) {
      const r = document.createRange();
      r.setStart(s.text, a - s.start);
      r.setEnd(s.text, b - s.start);
      ranges.push(r);
      continue;
    }
    if (!s.atom) continue;

    // 塊は途中で切れない。画面に出ている文字に掛かるときだけ、
    // 塊ごと引く。記法の記号（縦棒や《》）だけに掛かるマーカーは
    // 見えている語と対応しないので捨てる。
    if (a >= s.shownEnd || b <= s.shownStart) continue;
    if (s.atom.classList.contains("bouten")) {
      // 傍点は塊まるごとではなく、掛かった語のところだけを示す。
      // 位置は塊の中の表示文字で数え直す
      atoms.push({
        atom: s.atom,
        start: Math.max(a, s.shownStart) - s.shownStart,
        end: Math.min(b, s.shownEnd) - s.shownStart,
      });
      continue;
    }
    const r = atomRange(s.atom);
    if (r) ranges.push(r);
  }
  return { ranges, atoms };
}

/**
 * DOM の位置（ノードとその中のオフセット）が、記法テキストの
 * どこに当たるか。
 *
 * 塊の中は途中で切れないので、外側へ寄せる。始点は塊の手前、
 * 終点は塊の後ろ。選択がルビの一部に掛かったら、ルビ全体を
 * 選んだものとして扱うということ。
 *
 * 見つからなければ null。
 */
export function srcOffsetAt(
  para: HTMLElement,
  segs: Segment[],
  node: Node,
  offset: number,
  side: "start" | "end",
): number | null {
  if (node === para) {
    // 段落そのものを指している。offset は子の番号
    if (offset <= 0) return 0;
    const child = para.childNodes[offset];
    if (!child) return srcLength(segs);
    for (const s of segs) {
      if (s.text === child || s.atom === child) return s.start;
    }
    return null;
  }

  for (const s of segs) {
    if (s.text) {
      if (s.text === node) return s.start + offset;
      continue;
    }
    if (!s.atom) continue;
    if (s.atom === node) return offset <= 0 ? s.start : s.end;
    if (s.atom.contains(node)) return side === "start" ? s.start : s.end;
  }
  return null;
}

/**
 * 記法テキスト上の範囲を、段落の中の Range に直す。
 *
 * 傍点を付け外ししたあと、直した範囲を選び直すのに使う。
 * `start === end` なら、その位置に畳んだ Range を返す。
 */
export function domRange(para: HTMLElement, start: number, end: number): Range | null {
  const segs = readSegments(para);
  const head = pointAt(para, segs, start, "start");
  const tail = pointAt(para, segs, Math.max(start, end), "end");
  if (!head || !tail) return null;
  const r = document.createRange();
  r.setStart(head.node, head.offset);
  try {
    r.setEnd(tail.node, tail.offset);
  } catch {
    // 終点が始点より前になることはないはずだが、崩れていたら畳む
    r.collapse(true);
  }
  return r;
}

/** 記法テキスト上の一点を、DOM の位置に直す。 */
function pointAt(
  para: HTMLElement,
  segs: Segment[],
  at: number,
  side: "start" | "end",
): { node: Node; offset: number } | null {
  if (segs.length === 0) return { node: para, offset: 0 };
  for (const s of segs) {
    if (at > s.end) continue;
    if (at < s.start) break;
    if (s.text) return { node: s.text, offset: at - s.start };
    if (!s.atom) continue;

    // 塊のうち、ルビの読みの中だけは指せる。
    // ルビを振った直後に読みを選ぶのに要る。
    const inReading = readingPoint(s, at);
    if (inReading) return inReading;

    const parent = s.atom.parentNode;
    if (!parent) return null;
    const idx = Array.from(parent.childNodes).indexOf(s.atom);
    // 塊の中は指せない。手前か後ろの境目に寄せる
    const after = side === "end" ? at > s.start : at >= s.end;
    return { node: parent, offset: after ? idx + 1 : idx };
  }
  return { node: para, offset: para.childNodes.length };
}

/**
 * 記法テキスト上の位置が、ルビの読みの中を指しているなら
 * その読み（rt）の中の位置を返す。
 */
function readingPoint(s: Segment, at: number): { node: Node; offset: number } | null {
  const atom = s.atom;
  if (!atom || atom.tagName !== "RUBY") return null;
  const reading = atom.dataset.ruby ?? "";
  const src = atom.dataset.src ?? "";
  if (!reading) return null;

  // 読みは記法の末尾寄りにある（親文字と同じ字でも取り違えない）
  const rel = src.lastIndexOf(reading);
  if (rel < 0) return null;
  const from = s.start + rel;
  if (at < from || at > from + reading.length) return null;

  const node = atom.querySelector("rt")?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  return { node, offset: at - from };
}

/** その範囲が地の文だけでできているか。ルビや傍点を含めば false。 */
export function plainOnly(segs: Segment[], start: number, end: number): boolean {
  return segs.every((s) => s.start >= end || s.end <= start || s.text !== null);
}

/**
 * 行頭の見出し記号が占めている長さ。
 *
 * 見出し記号にルビや傍点を掛けると見出しでなくなってしまうので、
 * 選択範囲の始点をここまで押し出すのに使う。
 */
export function headingEnd(segs: Segment[]): number {
  const head = segs[0];
  if (head?.atom?.classList.contains("heading-mark")) return head.end;
  return 0;
}

/**
 * 塊のうち、線を引く相手の Range。
 *
 * ルビは親文字だけに引く。読み（rt）まで引くと読みにくい。
 * 親文字は編集でテキストノードが分かれることがあるので、
 * 先頭から末尾までをまとめて囲む。
 */
function atomRange(el: HTMLElement): Range | null {
  const kids = Array.from(el.childNodes).filter((n) => !isReading(n));
  if (kids.length === 0) return null;
  const r = document.createRange();
  r.setStartBefore(kids[0]);
  r.setEndAfter(kids[kids.length - 1]);
  return r;
}

/** ルビの読みを入れる要素か。 */
function isReading(n: Node): boolean {
  if (n.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = (n as Element).tagName;
  return tag === "RT" || tag === "RP";
}
