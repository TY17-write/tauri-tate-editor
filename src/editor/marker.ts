/**
 * 品詞マーカーの描画。CSS Custom Highlight API を使う。
 *
 * DOM を一切書き換えないのが要点。span を挿す方式だと IME 変換中に
 * 入力が壊れるが、Highlight API なら変換中に更新しても壊れない
 * （実測で確認済み）。
 *
 * Chromium の制約（実測）:
 *  ・text-decoration は「::highlight(名前)」の単体セレクタでしか効かない。
 *    子孫セレクタで書くと無視されるため、表示スタイルは CSS クラスでは
 *    なく「登録するハイライト名」で切り替える。
 *  ・傍線は必ず文字の左側に出る（text-underline-position が効かない）。
 *  ・text-emphasis（傍点）は使えない。
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

/** 段落ごとのマーカー。DOM 要素と紐づけて保持する。 */
interface Entry {
  el: HTMLElement;
  marks: Mark[];
}

export class MarkerLayer {
  private entries = new Map<string, Entry>();
  private opts: MarkerOptions = {
    style: "h",
    enabled: true,
    visible: new Set<PosTag>(["adverb", "adjective", "adjectivalnoun"]),
  };
  /** 直近に描画したマーカー数。ステータス表示用 */
  lastCount = 0;

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
  set(id: ParaId, el: HTMLElement, marks: Mark[]): void {
    this.entries.set(idKey(id), { el, marks });
  }

  /** 段落を取り除く。 */
  remove(id: ParaId): void {
    this.entries.delete(idKey(id));
  }

  clear(): void {
    this.entries.clear();
    if (MarkerLayer.supported) CSS.highlights.clear();
    this.lastCount = 0;
  }

  /**
   * 保持しているマーカーを Range に変換して登録し直す。
   *
   * Range は段落の Text ノードに対して作る。段落単位で保持しているので、
   * 変更のあった段落だけ set() し直せば済む。
   */
  render(): void {
    this.lastCount = 0;

    // 傍線（右）だけは Highlight API では描けないので span を挿す
    if (this.usesDom) {
      if (MarkerLayer.supported) CSS.highlights.clear();
      for (const { el, marks } of this.entries.values()) {
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
    for (const { el } of this.entries.values()) clearSideMarks(el);

    if (!MarkerLayer.supported) return;
    CSS.highlights.clear();
    if (!this.opts.enabled) return;

    const buckets = new Map<PosTag, Range[]>();
    for (const pos of ALL_POS) buckets.set(pos, []);

    for (const { el, marks } of this.entries.values()) {
      const node = el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const len = (node as Text).length;

      for (const m of marks) {
        if (!this.opts.visible.has(m.pos)) continue;
        // 編集で段落が短くなっている場合に備えて範囲を丸める
        const start = Math.min(m.start, len);
        const end = Math.min(m.end, len);
        if (start >= end) continue;

        const r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, end);
        buckets.get(m.pos)!.push(r);
      }
    }

    for (const [pos, ranges] of buckets) {
      if (ranges.length === 0) continue;
      CSS.highlights.set(`${pos}-${this.opts.style}`, new Highlight(...ranges));
      this.lastCount += ranges.length;
    }
  }
}
