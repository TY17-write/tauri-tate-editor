/**
 * 組版の設定（判型・マス目）。
 *
 * 検証（vertical-grid-probe.html）で分かったこと:
 *  ・禁則処理はマス目を壊さない。19字の行ができても次の行はまた升の
 *    先頭から始まるので、行末に空きマスができるだけで済む。
 *    そのため自前で行分割を実装する必要はない。
 *  ・マス目を壊すのは半角幅で描画される文字だけ。U+2014 EM DASH が
 *    MS明朝・BIZ UD明朝で半角になるのが代表例。→ normalizeText で対処
 *  ・游明朝の約物（、。「」）が詰まっていた原因は書体ではなく、
 *    Chromium の text-spacing-trim 既定値。space-all で止めれば
 *    游明朝・游ゴシックも全書体で升に乗る（実測で全角 1em・半角
 *    0.5em を確認）。→ styles.css の .paper と TateHalf* を参照
 */

import { invoke } from "@tauri-apps/api/core";

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
 *
 * 全角の字はどの書体でも 1em 送りなので升に乗る。乗らないのは
 *  ・約物 … Chromium が既定で詰める（text-spacing-trim）。
 *    styles.css で space-all を指定して止めてある
 *  ・半角英数 … 書体によって幅がまちまち。先頭に半角専用の
 *    フォールバック（TateHalf*、styles.css の @font-face）を置き、
 *    どの書体でもちょうど 0.5em（1マスに2字）で送らせる
 * この二つを押さえたので、どの書体でも升が字を掴む。
 */
export const FONTS: { value: string; label: string }[] = [
  { value: 'TateHalfMincho, "MS 明朝", "MS Mincho", serif', label: "MS 明朝" },
  { value: 'TateHalfMincho, "BIZ UDMincho", serif', label: "BIZ UD明朝" },
  { value: 'TateHalfGothic, "MS ゴシック", "MS Gothic", monospace', label: "MS ゴシック" },
  { value: 'TateHalfMincho, "游明朝", "Yu Mincho", serif', label: "游明朝" },
  { value: 'TateHalfGothic, "游ゴシック", "Yu Gothic", sans-serif', label: "游ゴシック" },
];

/** Rust から返る、インストール済み書体の一項目。 */
export interface InstalledFont {
  /** CSS の font-family に書く名前（フォントの既定名） */
  name: string;
  /** 画面に出す名前。日本語名があればそちら */
  label: string;
}

/** 日本語の書けるインストール済みフォントの一覧を取る。 */
export async function listInstalledFonts(): Promise<InstalledFont[]> {
  return invoke<InstalledFont[]>("list_fonts");
}

/** 標準の書体としてすでに並んでいるファミリー名。重ねて出さない。 */
export const CURATED_FAMILIES = new Set([
  "MS Mincho",
  "BIZ UDMincho",
  "MS Gothic",
  "Yu Mincho",
  "Yu Gothic",
]);

/**
 * ファミリー名から本文用のフォントスタックを組む。
 *
 * 先頭の TateHalf* は半角を 0.5em に固定するための振り向け先で、
 * 見た目が浮かないよう、ゴシック系の名前ならゴシックの半角を使う。
 */
export function fontStack(name: string): string {
  const gothic = /ゴシック|gothic|メイリオ|meiryo|sans/i.test(name);
  const half = gothic ? "TateHalfGothic" : "TateHalfMincho";
  const generic = gothic ? "sans-serif" : "serif";
  return `${half}, "${name.replace(/"/g, "")}", ${generic}`;
}

/**
 * 字送りに対する行送りの比。行送りはここから自動で決まる。
 *
 * 行と行のあいだには「字の箱」どうしの空きが (比 - 1)em できる。
 * ルビ（0.5em）と傍点はこの空きに出るので、比を 1.7 にしておけば
 * 0.7em の空きに収まり、隣の行の字に乗らない。1.5 を切るとルビが
 * 前の行へはみ出す。
 */
export const STEP_RATIO = 1.7;

/** 文字サイズの上下限(px)。画面に合わせて自動で決めるときに丸める。 */
export const CELL_LIMITS = [8, 48] as const;

export const DEFAULT_LAYOUT: Layout = {
  chars: 20,
  lines: 20,
  cell: 24,
  step: Math.round(24 * STEP_RATIO),
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
  // 印刷では文字の大きさを用紙から決め直すので、px ではなく
  // 「字送りに対する行送りの比」を渡す（print.css を参照）
  s.setProperty("--step-ratio", String(layout.step / layout.cell));
}

/**
 * その書体でマス目が成立するかを実測で調べる。
 *
 * インストール済みの書体は何が来るか分からないので、表ではなく
 * 実際に組んで測る。全角（約物・濁点・漢字を含む）が 1em、半角が
 * 0.5em で送られれば升に乗る。仮名が詰まる書体（BIZ UDP 系や
 * MS P 系などのプロポーショナル）はここで弾かれて警告になる。
 */
export function isGridSafeFont(font: string): boolean {
  const d = document.createElement("div");
  d.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;" +
    "writing-mode:vertical-rl;text-orientation:mixed;" +
    "font-size:32px;line-height:64px;letter-spacing:0;" +
    "font-kerning:none;font-variant-ligatures:none;" +
    "text-spacing-trim:space-all;text-autospace:no-autospace;" +
    'font-feature-settings:"palt" 0,"vpal" 0;line-break:strict;block-size:4000px;';
  d.style.fontFamily = font;
  document.body.appendChild(d);
  const measure = (s: string): number => {
    d.textContent = s;
    const r = document.createRange();
    r.selectNodeContents(d);
    return r.getBoundingClientRect().height;
  };
  const zen = measure("あ、。「」永―がぎ罠"); // 全角 10 字 → 320px が正
  const half = measure("abcdefgh"); // 半角 8 字 → 128px が正
  d.remove();
  return Math.abs(zen - 320) < 1 && Math.abs(half - 128) < 1;
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
