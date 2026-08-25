/**
 * 品詞マーカーの描画。
 *
 * 既定は CSS Custom Highlight API。DOM を一切書き換えないのが要点で、
 * span を挿す方式と違い IME 変換中に更新しても入力が壊れない
 * （実測で確認済み）。
 *
 * Chromium の制約（実測）:
 *  ・text-decoration は「::highlight(名前)」の単体セレクタでしか効かない。
 *    子孫セレクタで書くと無視されるため、表示スタイルは CSS クラスでは
 *    なく「登録するハイライト名」で切り替える。
 *  ・傍線は必ず文字の左側に出る（text-underline-position が効かない）。
 *    右側に引きたい場合だけ sidemark.ts の span 方式を使う。
 *  ・text-emphasis（傍点）は使えない。
 *
 * マーカーは段落 ID に紐づけて持ち、DOM 要素は描画のたびに
 * `data-slot` / `data-gen` から引き直す。要素の参照を持ち回ると、
 * 編集で段落要素が作り直されたときに古い要素へ Range を張ってしまう。
 */

import { clearSideMarks, paintSideMarks } from "./sidemark";
import { ALL_POS, idKey, usesDomWrite } from "./types";
import type { Mark, MarkStyle, ParaId, PosTag } from "./types";

export interface MarkerOptions {
  style: MarkStyle;
  enabled: boolean;
  /** 表示する品詞 */
  visible: Set<PosTag>;
}

export class MarkerLayer {
  /** 段落 ID → マーカー。DOM 要素は持たない */
  private marks = new Map<string, Mark[]>();
  private opts: MarkerOptions = {
    style: "h",
    enabled: true,
    visible: new Set<PosTag>(["adverb", "adjective", "adjectivalnoun"]),
  };
  /** 直近に描画したマーカー数。ステータス表示用 */
  lastCount = 0;
  /**
   * いま CSS.highlights に登録している名前。
   *
   * `CSS.highlights.clear()` は検索など他の機能が登録したものまで
   * 消してしまうので、自分が入れた分だけを消す。
   */
  private registered: string[] = [];

  constructor(private paper: HTMLElement) {}

  /** 本文を入れる要素が作り直されたときに繋ぎ直す。 */
  rebind(paper: HTMLElement): void {
    this.paper = paper;
  }

  static get supported(): boolean {
    return typeof CSS !== "undefined" && "highlights" in CSS;
  }

  /**
   * 表示設定を変える。描画はしないので、呼び出し側が続けて
   * `render()` を呼ぶこと。傍線（右）はキャレットの保存と復元を
   * 伴うため、描画のタイミングを Session に握らせている。
   */
  setOptions(patch: Partial<MarkerOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  get options(): Readonly<MarkerOptions> {
    return this.opts;
  }

  /** いまの表示スタイルが DOM の書き換えを伴うか。 */
  get usesDom(): boolean {
    return usesDomWrite(this.opts.style);
  }

  /** 段落一件分のマーカーを差し替える。 */
  set(id: ParaId, marks: Mark[]): void {
    this.marks.set(idKey(id), marks);
  }

  /** 段落を取り除く。 */
  remove(id: ParaId): void {
    this.marks.delete(idKey(id));
  }

  clear(): void {
    this.marks.clear();
    this.clearOwn();
    this.lastCount = 0;
  }

  /** 自分が登録したハイライトだけを取り下げる。 */
  private clearOwn(): void {
    if (!MarkerLayer.supported) return;
    for (const name of this.registered) CSS.highlights.delete(name);
    this.registered = [];
  }

  /** 現在の DOM から「段落要素 → その段落のマーカー」を作る。 */
  private pairs(): { el: HTMLElement; marks: Mark[] }[] {
    const out: { el: HTMLElement; marks: Mark[] }[] = [];
    for (const el of Array.from(this.paper.children) as HTMLElement[]) {
      const slot = el.dataset.slot;
      const gen = el.dataset.gen;
      if (slot === undefined || gen === undefined) continue;
      const marks = this.marks.get(`${slot}:${gen}`);
      out.push({ el, marks: marks ?? [] });
    }
    return out;
  }

  /** 保持しているマーカーを描き直す。 */
  render(): void {
    this.lastCount = 0;
    const pairs = this.pairs();

    // 傍線（右）だけは Highlight API では描けないので span を挿す
    if (this.usesDom) {
      this.clearOwn();
      for (const { el, marks } of pairs) {
        if (!this.opts.enabled) {
          clearSideMarks(el);
          continue;
        }
        paintSideMarks(el, marks, this.opts.visible);
        this.lastCount += marks.filter((m) => this.opts.visible.has(m.pos)).length;
      }
      return;
    }

    // 直前まで span 方式だったなら、テキストノード1つの状態に戻す。
    // 戻す前に Range を張ると相手のノードが見つからない。
    for (const { el } of pairs) clearSideMarks(el);

    if (!MarkerLayer.supported) return;
    this.clearOwn();
    if (!this.opts.enabled) return;

    const buckets = new Map<PosTag, Range[]>();
    for (const pos of ALL_POS) buckets.set(pos, []);

    for (const { el, marks } of pairs) {
      const node = el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const len = (node as Text).length;

      for (const m of marks) {
        if (!this.opts.visible.has(m.pos)) continue;
        // 段落が短くなっていて範囲に収まらないマーカーは、
        // 丸めずに捨てる。丸めると別の語に線が付いて見える。
        if (m.start >= m.end || m.end > len) continue;

        const r = document.createRange();
        r.setStart(node, m.start);
        r.setEnd(node, m.end);
        buckets.get(m.pos)!.push(r);
      }
    }

    for (const [pos, ranges] of buckets) {
      if (ranges.length === 0) continue;
      const name = `${pos}-${this.opts.style}`;
      CSS.highlights.set(name, new Highlight(...ranges));
      this.registered.push(name);
      this.lastCount += ranges.length;
    }
  }
}
