/**
 * 見出しの抽出と章立て。
 *
 * 行頭の `#` の連続を見出しとみなす。日本語入力のまま書けるよう
 * 全角の `＃` も同じに扱う。記号の後ろの空白はあってもなくてもよい。
 *
 *   # 第一章        レベル1
 *   ＃＃ 二　邂逅    レベル2
 *
 * 小説の本文に `#` が現れることはまずないので、この規則で困らない。
 */

/** 見出し記号の並び。半角・全角どちらも受ける。 */
const HEADING = /^([#＃]{1,6})[ 　]*(.*)$/;

export interface Heading {
  /** 見出しの深さ。1 が最上位 */
  level: number;
  /** 記号を取り除いた見出し文 */
  title: string;
  /** 何段落目か（0 始まり） */
  index: number;
  /**
   * この見出しが受け持つ範囲の文字数（見出し行そのものは含まない）。
   *
   * 下位の見出しの分も合算する。「第一章」の直後に「一節」が続く
   * ような書き方でも、章の分量が 0 にならないようにするため。
   */
  chars: number;
}

/** 一行が見出しなら、その深さと本文を返す。 */
export function parseHeading(line: string): { level: number; title: string } | null {
  const m = HEADING.exec(line);
  if (!m) return null;
  const title = m[2].trim();
  return { level: m[1].length, title: title || "（無題）" };
}

/** 行が見出しかどうか。 */
export function isHeading(line: string): boolean {
  return HEADING.test(line);
}

/**
 * 段落の配列から章立てを組み立てる。
 *
 * 各見出しの文字数は「その見出しから、同じか浅いレベルの次の見出しが
 * 現れるまで」の本文を数える。下位の見出しの分も含まれるので、
 * 章のすぐ下に節を置いても章の分量が 0 にならない。
 */
export function buildOutline(lines: string[]): Heading[] {
  const found: { level: number; title: string; index: number }[] = [];
  lines.forEach((line, index) => {
    const h = parseHeading(line);
    if (h) found.push({ ...h, index });
  });

  return found.map((h) => {
    let chars = 0;
    for (let i = h.index + 1; i < lines.length; i++) {
      const next = parseHeading(lines[i]);
      if (next) {
        if (next.level <= h.level) break; // 受け持ちの終わり
        continue; // 下位の見出し行そのものは数えない
      }
      chars += lines[i].length;
    }
    return { ...h, chars };
  });
}

/** 本文全体の文字数（改行を除く）。 */
export function totalChars(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length, 0);
}

/** 見出し行を除いた本文の文字数。原稿の分量はこちらが実態に近い。 */
export function bodyChars(lines: string[]): number {
  return lines.reduce((n, l) => (isHeading(l) ? n : n + l.length), 0);
}
