/**
 * 文体の報告。Rust 側（stats.rs）の結果を受け取って表示する。
 *
 * 指摘の位置は段落番号と段落内の UTF-16 オフセットで来るので、
 * そのまま Range を張れる。
 */

import { invoke } from "@tauri-apps/api/core";

export type IssueKind = "longsentence" | "repeatedending" | "nearbyrepeat" | "overuse";

export interface Issue {
  kind: IssueKind;
  para: number;
  start: number;
  end: number;
  message: string;
  excerpt: string;
}

export interface PosRatio {
  adverb: number;
  adjective: number;
  adjectivalNoun: number;
  adnominal: number;
}

export interface StyleReport {
  chars: number;
  sentences: number;
  avgSentence: number;
  maxSentence: number;
  pos: PosRatio;
  dialogueRatio: number;
  issues: Issue[];
}

/** Rust から返る形（serde の既定でスネークケース）。 */
interface RawReport {
  chars: number;
  sentences: number;
  avg_sentence: number;
  max_sentence: number;
  pos: {
    adverb: number;
    adjective: number;
    adjectival_noun: number;
    adnominal: number;
  };
  dialogue_ratio: number;
  issues: Issue[];
}

export const ISSUE_LABEL: Record<IssueKind, string> = {
  longsentence: "長い文",
  repeatedending: "文末の重なり",
  nearbyrepeat: "近くの繰り返し",
  overuse: "使いすぎ",
};

/** 判定のしきい値。Rust の StyleOptions と同じ形で渡す。 */
export interface StyleOptions {
  /** これを超える一文を「長い」とみなす（字） */
  longSentence: number;
  /** 同じ文末がこの数だけ並んだら指摘する */
  repeatEndings: number;
  /** 同じ語の繰り返しを見る幅（字） */
  nearbyWindow: number;
  /** 使いすぎを数える語 */
  overuseWords: string[];
  /** 本文千字あたり何回で指摘するか */
  overusePer1000: number;
}

export const DEFAULT_OPTIONS: StyleOptions = {
  // 小説の一文は長くなりがちなので、明らかに読みにくい水準に置く
  longSentence: 200,
  repeatEndings: 3,
  nearbyWindow: 60,
  overuseWords: [
    "思う",
    "思った",
    "感じる",
    "ような",
    "そう",
    "という",
    "こと",
    "もの",
    "とても",
    "少し",
  ],
  overusePer1000: 4.0,
};

/** Rust 側は snake_case で受ける。 */
function toRaw(o: StyleOptions) {
  return {
    long_sentence: o.longSentence,
    repeat_endings: o.repeatEndings,
    nearby_window: o.nearbyWindow,
    overuse_words: o.overuseWords,
    overuse_per_1000: o.overusePer1000,
  };
}

export async function fetchReport(options?: StyleOptions): Promise<StyleReport> {
  const r = await invoke<RawReport>("style_report", {
    options: options ? toRaw(options) : null,
  });
  return {
    chars: r.chars,
    sentences: r.sentences,
    avgSentence: r.avg_sentence,
    maxSentence: r.max_sentence,
    pos: {
      adverb: r.pos.adverb,
      adjective: r.pos.adjective,
      adjectivalNoun: r.pos.adjectival_noun,
      adnominal: r.pos.adnominal,
    },
    dialogueRatio: r.dialogue_ratio,
    issues: r.issues,
  };
}

/** 千字あたりの回数。分量の違う原稿を並べても比べられるようにする。 */
export function per1000(count: number, chars: number): number {
  return chars > 0 ? (count * 1000) / chars : 0;
}

const STORE_KEY = "tate-editor.style-options";

/** しきい値を保存する。次に開いたときも同じ設定で見られるように。 */
export function saveOptions(o: StyleOptions): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch {
    /* 保存できなくても機能そのものは使える */
  }
}

/** 保存したしきい値を読む。壊れていれば既定値。 */
export function loadOptions(): StyleOptions {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_OPTIONS };
    const parsed = JSON.parse(raw) as Partial<StyleOptions>;
    return {
      ...DEFAULT_OPTIONS,
      ...parsed,
      // 配列は取り違えると壊れるので形を確かめる
      overuseWords: Array.isArray(parsed.overuseWords)
        ? parsed.overuseWords.filter((w) => typeof w === "string" && w.length > 0)
        : DEFAULT_OPTIONS.overuseWords,
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}
