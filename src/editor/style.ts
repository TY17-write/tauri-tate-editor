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

export async function fetchReport(): Promise<StyleReport> {
  const r = await invoke<RawReport>("style_report", { options: null });
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
