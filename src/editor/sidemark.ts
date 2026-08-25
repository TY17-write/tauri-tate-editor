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
 *
 * プレビューでは段落にルビや傍点の塊が混ざる。塊は途中で切れない
 * ので、掛かったときは塊そのものに印を付ける。段落の中身を
 * textContent で組み直してはいけない（塊が消える）。
 */

import { readSegments, srcLength } from "./segment";
import { ALL_POS } from "./types";
import type { Mark, PosTag } from "./types";

/** 塊の中の一区切り。位置は塊の中の表示文字で数える。 */
interface AtomPart {
  start: number;
  end: number;
  pos: PosTag;
}

/**
 * 段落に span を挿して傍線を引く。引いた本数を返す。
 *
 * 元の並びに戻してから引き直すので、続けて呼んでも線は増えない。
 */
export function paintSideMarks(el: HTMLElement, marks: Mark[], visible: Set<PosTag>): number {
  clearSideMarks(el);

  const segs = readSegments(el);
  const len = srcLength(segs);

  const targets: Mark[] = [];
  let taken = 0;
  for (const m of marks
    .filter((m) => visible.has(m.pos))
    .filter((m) => m.start < m.end && m.end <= len)
    .sort((a, b) => a.start - b.start)) {
    // 範囲が重なっている場合は後ろ側を諦める（線の二重掛けを避ける）
    if (m.start < taken) continue;
    targets.push(m);
    taken = m.end;
  }
  if (targets.length === 0) return 0;

  const frag = document.createDocumentFragment();
  const parts = new Map<HTMLElement, AtomPart[]>();
  for (const s of segs) {
    if (s.atom) {
      if (s.atom.classList.contains("bouten")) {
        // 傍点の右脇にはゴマ点が出ている。そこへ傍線を引くと
        // 点と線が重なって読めなくなるので、中を色で示す
        parts.set(
          s.atom,
          targets
            .filter((m) => m.start < s.shownEnd && m.end > s.shownStart)
            .map((m) => ({
              start: Math.max(m.start, s.shownStart) - s.shownStart,
              end: Math.min(m.end, s.shownEnd) - s.shownStart,
              pos: m.pos,
            })),
        );
      } else {
        // ルビは塊が最小の単位。掛かっていれば丸ごと線を引く
        const hit = targets.find((m) => m.start < s.shownEnd && m.end > s.shownStart);
        if (hit) s.atom.classList.add("sidemark", `sidemark-${hit.pos}`);
      }
      frag.appendChild(s.atom);
      continue;
    }

    const text = s.text?.data ?? "";
    let cut = 0;
    for (const m of targets) {
      const a = Math.max(m.start, s.start) - s.start;
      const b = Math.min(m.end, s.end) - s.start;
      if (a >= b) continue;
      if (a > cut) frag.appendChild(document.createTextNode(text.slice(cut, a)));
      const span = document.createElement("span");
      span.className = `sidemark sidemark-${m.pos}`;
      span.textContent = text.slice(a, b);
      frag.appendChild(span);
      cut = b;
    }
    if (cut < text.length) frag.appendChild(document.createTextNode(text.slice(cut)));
  }

  el.replaceChildren(frag);
  // 段落の中の傍点はすべて塗り直す。掛からなくなったものは空になる
  for (const atom of Array.from(el.querySelectorAll<HTMLElement>(".bouten"))) {
    paintAtomMarks(atom, parts.get(atom) ?? []);
  }
  return targets.length;
}

/**
 * 印を取り除いて元の並びに戻す。
 *
 * 挿した span は外して中身を親に戻し、塊に付けた印は class だけ
 * 外す。最後に normalize() で分かれたテキストノードを繋ぎ直す。
 * 記法表示では「段落の中身はテキストノード1つ」が前提になっている。
 */
export function clearSideMarks(el: HTMLElement): void {
  const marked = Array.from(el.querySelectorAll<HTMLElement>(".sidemark"));
  if (marked.length === 0) return;

  for (const e of marked) {
    if (e.dataset.src !== undefined) {
      // ルビや傍点の塊。要素は残して印だけ外す
      e.classList.remove("sidemark");
      for (const pos of ALL_POS) e.classList.remove(`sidemark-${pos}`);
      continue;
    }
    const parent = e.parentNode;
    if (!parent) continue;
    while (e.firstChild) parent.insertBefore(e.firstChild, e);
    parent.removeChild(e);
  }

  el.normalize();
}

/**
 * 傍点の塊の中を、掛かった語ごとに span で囲む。
 *
 * ハイライトはゴマ点を潰すので使えず、塊まるごとを色付けすると
 * 解析した語と対応しなくなる。要素の背景は文字の枠の中しか塗らない
 * ので、点には掛からない。
 *
 * 直す必要がなければ何もしない。DOM を書き換えたときだけ true を
 * 返す（呼び出し側がキャレットを戻すかどうかの判断に使う）。
 */
export function paintAtomMarks(atom: HTMLElement, parts: AtomPart[]): boolean {
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  const sig = sorted.map((p) => `${p.start}:${p.end}:${p.pos}`).join(",");
  if ((atom.dataset.marksig ?? "") === sig) return false;

  // 傍点の中身は文字ごとの入れ物（notation.ts の fillBouten）。
  // 中身を組み直さず、掛かった字に class を足すだけにする。
  // 組み直すと点を描いている疑似要素まで作り直すことになる。
  const units = Array.from(atom.querySelectorAll<HTMLElement>(".bt"));
  for (let i = 0; i < units.length; i++) {
    const hit = sorted.find((p) => p.start <= i && i < p.end);
    units[i].classList.remove("bmark", ...ALL_POS.map((p) => `bmark-${p}`));
    if (hit) units[i].classList.add("bmark", `bmark-${hit.pos}`);
  }

  if (sig) atom.dataset.marksig = sig;
  else delete atom.dataset.marksig;
  return true;
}

/**
 * 塊の中に付けた印を外す。
 *
 * ハイライトの登録を取り下げるのと同じ役目。書き換えたら true。
 */
export function clearAtomMarks(el: HTMLElement): boolean {
  let touched = false;
  for (const atom of Array.from(el.querySelectorAll<HTMLElement>("[data-marksig]"))) {
    for (const unit of Array.from(atom.querySelectorAll<HTMLElement>(".bt"))) {
      unit.classList.remove("bmark", ...ALL_POS.map((p) => `bmark-${p}`));
    }
    delete atom.dataset.marksig;
    touched = true;
  }
  return touched;
}
