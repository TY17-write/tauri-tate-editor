/** Rust 側と受け渡しする型。src-tauri/src/document.rs と対応する。 */

/**
 * 段落の識別子。
 *
 * Rust 側は thunderdome の `Index` で管理しているが、`to_bits()` の u64 を
 * そのまま JSON の数値にすると JavaScript の Number（IEEE754 double）では
 * 下位ビットが落ちるため、slot と generation に分けて受け渡ししている。
 * フロントエンドは中身を解釈せず、不透明なトークンとして持ち回るだけ。
 */
export interface ParaId {
  slot: number;
  gen: number;
}

/** マーカーを引く品詞。Rust 側の PosTag と対応する。 */
export type PosTag = "adverb" | "adjective" | "adjectivalnoun" | "adnominal";

export const ALL_POS: PosTag[] = ["adverb", "adjective", "adjectivalnoun", "adnominal"];

/** 段落内のマーカー範囲。オフセットは UTF-16 単位。 */
export interface Mark {
  start: number;
  end: number;
  pos: PosTag;
}

/** 段落一件分。 */
export interface ParaView {
  id: ParaId;
  text: string;
}

/** 解析結果一件分。 */
export interface AnalyzeResult {
  id: ParaId;
  marks: Mark[];
}

/**
 * マーカーの表示スタイル。
 *
 * "sr" 以外は CSS Custom Highlight API で描き、接尾辞がそのまま
 * ハイライト名になる（`adverb-h` など）。
 * "sr"（傍線・右）だけは Highlight API では実現できないため、
 * DOM に span を挿す方式になる。
 */
export type MarkStyle = "h" | "h2" | "u" | "d" | "hu" | "c" | "sr";

/** その表示スタイルが DOM の書き換えを伴うか。 */
export function usesDomWrite(style: MarkStyle): boolean {
  return style === "sr";
}

/** 組版の設定。 */
export interface Layout {
  /** 1行の字数 */
  chars: number;
  /** 1ページの行数 */
  lines: number;
  /** 1文字の送り(px)。マス目の一辺 */
  cell: number;
  /** 1行の送り(px) */
  step: number;
  /** 本文の書体 */
  font: string;
}

export function sameId(a: ParaId, b: ParaId): boolean {
  return a.slot === b.slot && a.gen === b.gen;
}

export function idKey(id: ParaId): string {
  return `${id.slot}:${id.gen}`;
}
