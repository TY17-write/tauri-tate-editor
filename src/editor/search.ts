/**
 * 検索と置換。
 *
 * ヒットの強調には CSS Custom Highlight API を使う。DOM を書き換えない
 * ので、品詞マーカーと同じく IME 変換中でも本文が壊れない。
 * 自分が登録したハイライト名だけを取り下げるようにして、
 * 品詞マーカーと共存できるようにしてある。
 *
 * 置換は `document.execCommand("insertText")` で行う。非推奨の API では
 * あるが、ブラウザの元に戻す履歴に載る唯一の手段で、これを使わないと
 * 置換を取り消せない。
 */

const HL_ALL = "search-hit";
const HL_CURRENT = "search-current";

export interface SearchOptions {
  /** 正規表現として扱う */
  regex: boolean;
  /** 英字の大小を区別する */
  caseSensitive: boolean;
}

/** ヒット一件。段落要素の中の位置で持つ。 */
interface Hit {
  el: HTMLElement;
  node: Text;
  start: number;
  end: number;
}

export class SearchLayer {
  private hits: Hit[] = [];
  private index = -1;
  private registered: string[] = [];

  constructor(private paper: HTMLElement) {}

  /** 本文を入れる要素が作り直されたときに繋ぎ直す。 */
  rebind(paper: HTMLElement): void {
    this.paper = paper;
    this.clear();
  }

  get count(): number {
    return this.hits.length;
  }

  /** いま何件目か（1 始まり）。ヒットがなければ 0。 */
  get position(): number {
    return this.index < 0 ? 0 : this.index + 1;
  }

  static get supported(): boolean {
    return typeof CSS !== "undefined" && "highlights" in CSS;
  }

  /** 検索をやめて強調を消す。 */
  clear(): void {
    this.hits = [];
    this.index = -1;
    if (SearchLayer.supported) {
      for (const n of this.registered) CSS.highlights.delete(n);
    }
    this.registered = [];
  }

  /**
   * 検索し直す。ヒット件数を返す。
   *
   * 段落ごとに走査する。段落をまたぐ語は拾わない（縦書きの本文では
   * 段落が意味の単位なので、実用上これで足りる）。
   */
  run(query: string, opts: SearchOptions): number {
    this.clear();
    if (!query) return 0;

    let re: RegExp;
    try {
      const source = opts.regex ? query : escapeRegExp(query);
      re = new RegExp(source, opts.caseSensitive ? "g" : "gi");
    } catch {
      return -1; // 正規表現として壊れている
    }

    for (const el of Array.from(this.paper.children) as HTMLElement[]) {
      const node = el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const text = (node as Text).data;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++; // 空マッチで止まらないように
          continue;
        }
        this.hits.push({
          el,
          node: node as Text,
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    }

    this.render();
    return this.hits.length;
  }

  /** ヒットを Range に変換して強調する。 */
  private render(): void {
    if (!SearchLayer.supported) return;
    for (const n of this.registered) CSS.highlights.delete(n);
    this.registered = [];
    if (this.hits.length === 0) return;

    const all: Range[] = [];
    let current: Range | null = null;
    this.hits.forEach((h, i) => {
      const r = this.toRange(h);
      if (!r) return;
      if (i === this.index) current = r;
      else all.push(r);
    });

    if (all.length) {
      CSS.highlights.set(HL_ALL, new Highlight(...all));
      this.registered.push(HL_ALL);
    }
    if (current) {
      CSS.highlights.set(HL_CURRENT, new Highlight(current));
      this.registered.push(HL_CURRENT);
    }
  }

  private toRange(h: Hit): Range | null {
    // 編集で段落が短くなっていることがある
    if (!h.node.isConnected || h.end > h.node.length) return null;
    const r = document.createRange();
    r.setStart(h.node, h.start);
    r.setEnd(h.node, h.end);
    return r;
  }

  /**
   * 次（dir=+1）または前（dir=-1）のヒットへ移る。
   * 移った先の Range を返す。ヒットがなければ null。
   */
  step(dir: number): Range | null {
    if (this.hits.length === 0) return null;
    if (this.index < 0) {
      this.index = dir > 0 ? 0 : this.hits.length - 1;
    } else {
      this.index = (this.index + dir + this.hits.length) % this.hits.length;
    }
    this.render();
    return this.currentRange();
  }

  currentRange(): Range | null {
    if (this.index < 0 || this.index >= this.hits.length) return null;
    return this.toRange(this.hits[this.index]);
  }

  /** いま選んでいるヒットを本文の選択範囲にする。 */
  select(): Range | null {
    const r = this.currentRange();
    if (!r) return null;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    return r;
  }

  /**
   * いま選んでいるヒットを置き換える。置き換えたら true。
   *
   * 元に戻す履歴に載せるため execCommand を使う。そのため
   * 本文の要素にフォーカスがある必要がある。
   */
  replaceCurrent(replacement: string): boolean {
    const r = this.select();
    if (!r) return false;
    this.paper.focus();
    // 選択し直す（focus で選択が外れることがある）
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    return document.execCommand("insertText", false, replacement);
  }

  /**
   * すべてのヒットを置き換える。置き換えた件数を返す。
   *
   * 後ろから処理する。前から置換すると、後ろのヒットの位置が
   * ずれて別の場所を書き換えてしまう。
   */
  replaceAll(replacement: string): number {
    if (this.hits.length === 0) return 0;
    this.paper.focus();
    let done = 0;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const r = this.toRange(this.hits[i]);
      if (!r) continue;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      if (document.execCommand("insertText", false, replacement)) done++;
    }
    this.clear();
    return done;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
