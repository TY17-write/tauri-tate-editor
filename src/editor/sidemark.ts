/**
 * 傍線を「文字の右側」に引くための描画方式。
 *
 * CSS Custom Highlight API では傍線が必ず文字の左側に出る。
 * `text-underline-position: right` は効かず、`overline` は描画されず、
 * `text-underline-offset` を負にすると線が動く代わりに消える
 * （いずれも実測で確認済み）。
 *
 * 日本語の傍線は文字の右側が慣習なので、それを実現するには
 * 段落の DOM に span を挿して border を引くしかない。
 * 縦書きでは span の border-right が文字の右脇に当たる。
 *
 * ただし DOM を書き換えるため、Highlight API と違って
 *  ・キャレットの位置が飛ぶ（保存と復元が要る）
 *  ・IME 変換中に触ると入力が壊れる
 * という制約が戻ってくる。呼び出し側は入力が止まってから、
 * かつ変換中でないときにだけ呼ぶこと。
 */

import type { Mark, PosTag } from "./types";

/** 段落に span を挿して傍線を引く。 */
export function paintSideMarks(el: HTMLElement, marks: Mark[], visible: Set<PosTag>): void {
  const text = el.textContent ?? "";
  const targets = marks
    .filter((m) => visible.has(m.pos))
    .filter((m) => m.start < m.end && m.end <= text.length)
    .sort((a, b) => a.start - b.start);

  if (targets.length === 0) {
    // 元のテキストノード1つだけの状態に戻す
    if (el.childNodes.length !== 1 || el.firstChild?.nodeType !== Node.TEXT_NODE) {
      if (text.length) el.textContent = text;
      else el.replaceChildren();
    }
    return;
  }

  const frag = document.createDocumentFragment();
  let at = 0;
  for (const m of targets) {
    // 範囲が重なっている場合は後ろ側を諦める（線の二重掛けを避ける）
    if (m.start < at) continue;
    if (m.start > at) frag.appendChild(document.createTextNode(text.slice(at, m.start)));
    const span = document.createElement("span");
    span.className = `sidemark sidemark-${m.pos}`;
    span.textContent = text.slice(m.start, m.end);
    frag.appendChild(span);
    at = m.end;
  }
  if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));

  el.replaceChildren(frag);
}

/** span を取り除いて、テキストノード1つだけの状態に戻す。 */
export function clearSideMarks(el: HTMLElement): void {
  if (!el.querySelector(".sidemark")) return;
  const text = el.textContent ?? "";
  if (text.length) el.textContent = text;
  else el.replaceChildren();
}
