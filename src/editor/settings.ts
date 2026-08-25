/**
 * 画面の設定の保存と読み出し。
 *
 * 判型・書体・マス目・マーカー・配色・表示モードを localStorage に
 * 覚えておき、次に開いたときに同じ見た目で始められるようにする。
 * 記法（notation.ts）と文体のしきい値（style.ts）は、それぞれの
 * 都合があるので別のキーで持っている。
 *
 * 読み出したものは信用しない。手で書き換えられることもあれば、
 * 版が変わって形が違うこともある。既定値に重ねたうえで、数は範囲へ
 * 丸め、選択肢は表にあるものだけを通す。壊れた設定で起動できなく
 * なるのがいちばん困る。
 */

import { DEFAULT_LAYOUT, FONTS, PRESETS } from "./grid";
import { ALL_POS } from "./types";
import type { Layout, MarkStyle, PosTag } from "./types";

/** マス目の描き方。CSS のクラス名がそのまま値になる。 */
export type GridMode = "grid-full" | "grid-rules" | "grid-page" | "";

const GRID_MODES: GridMode[] = ["grid-full", "grid-rules", "grid-page", ""];

/** マーカーの表示スタイル。index.html の選択肢と揃える。 */
const MARK_STYLES: MarkStyle[] = ["h", "h2", "sr", "u", "d", "hu", "c"];

/** 配色。 */
export type ThemeName = "light" | "sepia" | "dark";

export const THEMES: { value: ThemeName; label: string }[] = [
  { value: "light", label: "白" },
  { value: "sepia", label: "生成り" },
  { value: "dark", label: "夜" },
];

/** 画面の見た目に関わる設定ひとまとめ。 */
export interface Settings {
  layout: Layout;
  /** 用紙を画面の高さに合わせるか */
  fit: boolean;
  /** 判型の選択。カスタムなら "custom" */
  preset: string;
  grid: GridMode;
  markStyle: MarkStyle;
  /** マーカーを出すか */
  markerOn: boolean;
  /** 印を付ける品詞 */
  pos: PosTag[];
  /** 記法表示かプレビューか */
  preview: boolean;
  theme: ThemeName;
}

export const DEFAULT_SETTINGS: Settings = {
  layout: { ...DEFAULT_LAYOUT },
  fit: true,
  preset: "20,20",
  grid: "grid-full",
  markStyle: "h",
  markerOn: true,
  pos: ["adverb", "adjective", "adjectivalnoun"],
  preview: false,
  theme: "light",
};

/** 文字サイズと行送りの上下限。index.html の range と揃えること。 */
const LIMITS = {
  chars: [5, 80],
  lines: [3, 40],
  cell: [8, 48],
  step: [16, 70],
} as const;

const STORE_KEY = "tate-editor.settings";

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても動く */
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_LAYOUT } };
    return clean(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_SETTINGS, layout: { ...DEFAULT_LAYOUT } };
  }
}

/** 読み出したものを既定値に重ねて、使える形に整える。 */
function clean(raw: unknown): Settings {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const layout = (typeof o.layout === "object" && o.layout !== null ? o.layout : {}) as Record<
    string,
    unknown
  >;

  return {
    layout: {
      chars: num(layout.chars, DEFAULT_LAYOUT.chars, LIMITS.chars),
      lines: num(layout.lines, DEFAULT_LAYOUT.lines, LIMITS.lines),
      cell: num(layout.cell, DEFAULT_LAYOUT.cell, LIMITS.cell),
      step: num(layout.step, DEFAULT_LAYOUT.step, LIMITS.step),
      // 手元にない書体を覚えていても、表にないものは使わない
      font: FONTS.some((f) => f.value === o0(layout.font)) ? String(layout.font) : DEFAULT_LAYOUT.font,
    },
    fit: bool(o.fit, DEFAULT_SETTINGS.fit),
    preset: preset(o.preset),
    grid: pick(o.grid, GRID_MODES, DEFAULT_SETTINGS.grid),
    markStyle: pick(o.markStyle, MARK_STYLES, DEFAULT_SETTINGS.markStyle),
    markerOn: bool(o.markerOn, DEFAULT_SETTINGS.markerOn),
    pos: posList(o.pos),
    preview: bool(o.preview, DEFAULT_SETTINGS.preview),
    theme: pick(
      o.theme,
      THEMES.map((t) => t.value),
      DEFAULT_SETTINGS.theme,
    ),
  };
}

function o0(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function pick<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function preset(v: unknown): string {
  if (v === "custom") return "custom";
  return typeof v === "string" && v in PRESETS ? v : DEFAULT_SETTINGS.preset;
}

function posList(v: unknown): PosTag[] {
  if (!Array.isArray(v)) return [...DEFAULT_SETTINGS.pos];
  const out = ALL_POS.filter((p) => v.includes(p));
  // すべて外れていると何も出なくなる。覚えたとおりに戻すのが筋なので、
  // 空でもそのまま通す（マーカー表示の入切とは別の設定）
  return out;
}

/** その判型の選択がいまの字数・行数と合っているか。 */
export function presetFor(layout: Layout): string {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.chars === layout.chars && p.lines === layout.lines) return key;
  }
  return "custom";
}

/** 配色を画面に反映する。 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}
