/**
 * 組版の設定（判型・マス目）。
 *
 * 検証（vertical-grid-probe.html）で分かったこと:
 *  ・禁則処理はマス目を壊さない。19字の行ができても次の行はまた升の
 *    先頭から始まるので、行末に空きマスができるだけで済む。
 *    そのため自前で行分割を実装する必要はない。
 *  ・マス目を壊すのは半角幅で描画される文字だけ。U+2014 EM DASH が
 *    MS明朝・BIZ UD明朝で半角になるのが代表例。→ normalizeText で対処
 *  ・游明朝は約物（、。「」）が詰まるためマス目には使えない。
 */

import type { Layout } from "./types";

/** 判型のプリセット。字数 × 行数。 */
export const PRESETS: Record<string, { chars: number; lines: number; label: string }> = {
  "20,20": { chars: 20, lines: 20, label: "原稿用紙" },
  "20,10": { chars: 20, lines: 10, label: "原稿用紙ペラ" },
  "42,16": { chars: 42, lines: 16, label: "文庫" },
  "43,17": { chars: 43, lines: 17, label: "新書" },
  "44,18": { chars: 44, lines: 18, label: "四六判" },
};

/**
 * 本文の書体。
 * マス目モードでは約物まで全角で揃う等幅フォントしか使えない。
 */
export const FONTS: { value: string; label: string; grid: boolean }[] = [
  { value: '"MS 明朝", "MS Mincho", serif', label: "MS 明朝", grid: true },
  { value: '"BIZ UDMincho", serif', label: "BIZ UD明朝", grid: true },
  { value: '"MS ゴシック", "MS Gothic", monospace', label: "MS ゴシック", grid: true },
  { value: '"游明朝", "Yu Mincho", serif', label: "游明朝（約物が詰まる）", grid: false },
  { value: '"游ゴシック", "Yu Gothic", sans-serif', label: "游ゴシック（約物が詰まる）", grid: false },
];

export const DEFAULT_LAYOUT: Layout = {
  chars: 20,
  lines: 20,
  cell: 24,
  step: 38,
  font: FONTS[0].value,
};

/** 組版設定を CSS 変数へ反映する。 */
export function applyLayout(layout: Layout): void {
  const s = document.documentElement.style;
  s.setProperty("--chars", String(layout.chars));
  s.setProperty("--lines", String(layout.lines));
  s.setProperty("--cell", `${layout.cell}px`);
  s.setProperty("--step", `${layout.step}px`);
  s.setProperty("--novel-font", layout.font);
}

/** その書体でマス目が成立するか（約物が全角のままか）。 */
export function isGridSafeFont(font: string): boolean {
  return FONTS.find((f) => f.value === font)?.grid ?? false;
}

/**
 * マス目を壊す文字を全角へ寄せる。
 *
 *  ・U+2014 EM DASH「—」は MS明朝・BIZ UD明朝で半角幅になる。
 *    小説のダーシは U+2015「―」を使えば全角のまま揃う。
 *  ・半角英数記号は全角へ。縦中横で扱う方針に変えるならここを外す。
 */
export function normalizeText(s: string): string {
  return s
    .replace(/—/g, "―")
    .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

/** 正規化で変わる箇所があるか。ステータス表示に使う。 */
export function countNormalizable(s: string): number {
  const m = s.match(/[—!-~]/g);
  return m ? m.length : 0;
}

/** 1ページあたりの字数。 */
export function charsPerPage(layout: Layout): number {
  return layout.chars * layout.lines;
}
