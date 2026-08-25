/**
 * ルビと傍点の記法。変換そのものは Rust 側（notation.rs）が行う。
 *
 * プレビューは「部品の配列」を受け取って組み立てる。ルビと傍点も
 * その場で直せる（プレビューを見ながら推敲できることを優先した）。
 *
 * 塊は次の三つを持つ。
 *   data-src   元の行から切り出した記法そのもの
 *   data-text  そのとき画面に出していた文字（ルビなら親文字）
 *   data-ruby  ルビの読み
 *
 * 記法テキストへ戻すときは、画面の中身が data-text / data-ruby と
 * 同じなら data-src をそのまま使う。原文に手を触れないためで、
 * 縦棒を省いたルビ（`漢字《かんじ》`）が勝手に `|漢字《かんじ》`
 * へ書き換わるのを防ぐ。手が入っていれば、Rust から受け取った
 * 型紙（NotationForms）で組み立て直す。書き方の定義を画面側にも
 * 書くと食い違うので、型紙は必ず Rust から取る。
 */

import { invoke } from "@tauri-apps/api/core";

export type Notation = "narou" | "kakuyomu" | "aozora" | "pixiv";

export const NOTATIONS: { value: Notation; label: string; hint: string }[] = [
  {
    value: "narou",
    label: "小説家になろう",
    hint: "ルビ |漢字《かんじ》　傍点 |文字《・・》",
  },
  {
    value: "kakuyomu",
    label: "カクヨム",
    hint: "ルビ |漢字《かんじ》　傍点 《《文字》》",
  },
  {
    value: "aozora",
    label: "青空文庫",
    hint: "ルビ ｜漢字《かんじ》　傍点 ［＃「文字」に傍点］",
  },
  {
    value: "pixiv",
    label: "pixiv",
    hint: "ルビ [[rb:漢字 > かんじ]]　傍点 [[rb:文字 > ・・]]",
  },
];

export function notationInfo(n: Notation) {
  return NOTATIONS.find((x) => x.value === n) ?? NOTATIONS[0];
}

/**
 * プレビューの部品。
 *
 * heading は行頭の見出し記号（`#` の並び）。プレビューでは
 * 見えなくするが、記法テキストへ戻すために src で持っておく。
 */
export interface Piece {
  kind: "text" | "ruby" | "emphasis" | "heading";
  text: string;
  ruby: string;
  src: string;
}

export interface NotationCount {
  ruby: number;
  emphasis: number;
}

/**
 * 記法ごとの書き方の型紙。Rust の `notation::NotationForms` と対応する。
 *
 * ルビは `{0}` が親文字、`{1}` が読み。傍点は `{0}` が文字で、
 * `{.}` は「`{0}` と同じ字数の中黒」に開く。傍点の書き方がない
 * 記法（なろう・pixiv）はルビで代用するので、この差し込み口が要る。
 */
export interface NotationForms {
  ruby: string;
  emphasis: string;
}

/** その記法でのルビと傍点の書き方を取る。 */
export async function notationForms(n: Notation): Promise<NotationForms> {
  return invoke<NotationForms>("notation_forms", { notationKind: n });
}

/** 型紙に文字を差し込む。差し込み口でない中かっこはそのまま。 */
function fill(form: string, a: string, b: string): string {
  let out = "";
  let rest = form;
  for (;;) {
    const i = rest.indexOf("{");
    if (i < 0) break;
    out += rest.slice(0, i);
    const tail = rest.slice(i);
    if (tail.startsWith("{0}")) {
      out += a;
      rest = tail.slice(3);
    } else if (tail.startsWith("{1}")) {
      out += b;
      rest = tail.slice(3);
    } else if (tail.startsWith("{.}")) {
      // 親文字と同じ字数の中黒。傍点をルビで代用する記法で使う
      out += DOT.repeat(Array.from(a).length);
      rest = tail.slice(3);
    } else {
      out += "{";
      rest = tail.slice(1);
    }
  }
  return out + rest;
}

/** 傍点の代わりに振る中黒。Rust の DOT_MARKS の先頭と同じ。 */
const DOT = "・";

/**
 * 親文字と読みから、ルビの記法テキストを作る。
 *
 * 親文字を消したら塊ごと消し、読みだけを消したらただの文字に戻す。
 * プレビュー上でルビを外す操作がこれで自然にできる。
 */
export function rubySource(forms: NotationForms, base: string, reading: string): string {
  if (base === "") return "";
  if (reading === "") return base;
  return fill(forms.ruby, base, reading);
}

/** 傍点の記法テキストを作る。 */
export function emphasisSource(forms: NotationForms, text: string): string {
  if (text === "") return "";
  return fill(forms.emphasis, text, text);
}



/** 本文の記法を変える。変換後の本文を返す。 */
export async function convertNotation(from: Notation, to: Notation): Promise<string> {
  return invoke<string>("convert_notation", { from, to });
}

/** 本文に含まれるルビと傍点の数。 */
export async function countNotation(n: Notation): Promise<NotationCount> {
  return invoke<NotationCount>("count_notation", { notationKind: n });
}

/** 本文をプレビュー用の部品に分ける。段落ごとの配列。 */
export async function previewPieces(n: Notation): Promise<Piece[][]> {
  return invoke<Piece[][]>("preview_pieces", { notationKind: n });
}

/** 一行だけを部品に分ける。段落を組み直すときに使う。 */
export async function linePieces(line: string, n: Notation): Promise<Piece[]> {
  return invoke<Piece[]>("line_pieces", { line, notationKind: n });
}

/** 傍点を付け外ししたあとの行。Rust の `EmphasisEdit` と対応する。 */
export interface EmphasisEdit {
  text: string;
  /** 付け外しした範囲（直したあとの行での位置） */
  start: number;
  end: number;
}

/**
 * 行の `[start, end)` に傍点を付ける、または外す。
 *
 * すでに傍点が掛かっていれば外す。ルビに掛かる範囲には付けられない
 * ので null が返る。
 */
export async function toggleEmphasisAt(
  line: string,
  start: number,
  end: number,
  n: Notation,
): Promise<EmphasisEdit | null> {
  return invoke<EmphasisEdit | null>("toggle_emphasis", {
    line,
    start,
    end,
    notationKind: n,
  });
}

const STORE_KEY = "tate-editor.notation";

export function saveNotation(n: Notation): void {
  try {
    localStorage.setItem(STORE_KEY, n);
  } catch {
    /* 保存できなくても動く */
  }
}

export function loadNotation(): Notation {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v && NOTATIONS.some((x) => x.value === v)) return v as Notation;
  } catch {
    /* 既定に落とす */
  }
  return "kakuyomu";
}

/* ============================================================
   プレビューの組み立てと読み戻し
   ============================================================ */

/**
 * 部品から段落要素を作る。
 *
 * 親文字と傍点はそのまま打ち直せる。読み戻すときに中から記法を
 * 組み立て直すので、キャレットが中に入っても壊れない。
 *
 * 読み（rt）だけは触れない。rt の中では日本語入力が続かず、変換を
 * 始めた時点で入力が外れてしまうため、小窓（Ctrl+R）から入れる。
 *
 * 見出し記号だけは触れない塊のままにする。直す中身がないうえ、
 * 半端に消されると見出しかどうかが揺れるため。
 *
 * 塊には `data-src`（元の記法）と、そのとき表示した `data-text` /
 * `data-ruby` を持たせる。手が入ったかどうかの判定と、品詞マーカー
 * を描くときの位置合わせ（segment.ts）に使う。
 */
export function buildPreviewPara(pieces: Piece[]): HTMLParagraphElement {
  const p = document.createElement("p");
  for (const piece of pieces) {
    if (piece.kind === "text") {
      p.appendChild(document.createTextNode(piece.text));
      continue;
    }
    if (piece.kind === "heading") {
      // 見出し記号は消さずに置いたまま、CSS で見えなくする。
      // 消してしまうとマス目の位置が記法表示とずれる。
      // data-text は持たせない（マーカーを掛ける相手ではない）。
      const mark = document.createElement("span");
      mark.className = "heading-mark";
      mark.contentEditable = "false";
      mark.dataset.src = piece.src;
      mark.textContent = piece.text;
      p.appendChild(mark);
      continue;
    }
    if (piece.kind === "ruby") {
      const ruby = document.createElement("ruby");
      ruby.dataset.src = piece.src;
      ruby.dataset.text = piece.text;
      ruby.dataset.ruby = piece.ruby;
      ruby.appendChild(document.createTextNode(piece.text));
      const rt = document.createElement("rt");
      // 読みは小窓（Ctrl+R）で入れる。ここへ直に打たせない。
      // rt の中では日本語入力が正しく続かず、変換を始めた時点で
      // 入力が外れてしまう。親文字はそのまま打ち替えられる。
      rt.contentEditable = "false";
      rt.textContent = piece.ruby;
      ruby.appendChild(rt);
      p.appendChild(ruby);
      continue;
    }
    const em = document.createElement("span");
    em.className = "bouten";
    em.dataset.src = piece.src;
    em.dataset.text = piece.text;
    fillBouten(em, piece.text);
    p.appendChild(em);
  }
  return p;
}

/**
 * 傍点の塊の中身を、文字ごとの入れ物に組み直す。
 *
 * ゴマ点は `text-emphasis` で描くが、本文の側に置くと行の高さが
 * 増えて、後ろの行がマス目から外れる（実測で 20字40px・行送り48px
 * のとき 16px ずれた）。点は文字ごとの疑似要素に描かせ、絶対配置で
 * 流れから外す。
 *
 * 塊ひとつをまとめて疑似要素にすると、行をまたいで折り返したときに
 * 点の位置が合わなくなる。1文字ずつなら折り返しの境目でしか切れず、
 * どの文字の点も必ずその文字の上に出る。
 */
export function fillBouten(el: HTMLElement, text: string): void {
  const frag = document.createDocumentFragment();
  for (const ch of Array.from(text)) {
    const unit = document.createElement("span");
    unit.className = "bt";
    unit.textContent = ch;
    frag.appendChild(unit);
  }
  el.replaceChildren(frag);
}

/** ルビの親文字。読み（rt）は数えない。 */
export function rubyBase(el: HTMLElement): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const e = node as Element;
    if (e.tagName === "RT" || e.tagName === "RP") continue;
    out += e.textContent ?? "";
  }
  return out;
}

/** ルビの読み。 */
export function rubyReading(el: HTMLElement): string {
  return el.querySelector("rt")?.textContent ?? "";
}

/**
 * 塊が表している記法テキスト。
 *
 * 画面の中身が最後に組み立てたときのままなら `data-src` をそのまま
 * 返す。原文に手を触れないためで、これがないとプレビューを開いた
 * だけで縦棒の有無などが書き換わる。手が入っていれば型紙で作り直す。
 */
export function blockSource(el: HTMLElement, forms: NotationForms | null): string {
  const src = el.dataset.src ?? "";
  if (el.tagName === "RUBY") {
    const base = rubyBase(el);
    const reading = rubyReading(el);
    if (base === el.dataset.text && reading === el.dataset.ruby) return src;
    // 型紙はプレビューを組み立てる前に取りに行くので、編集の時点では
    // 必ずある。念のため、取れていなければ原文を守る
    return forms ? rubySource(forms, base, reading) : src;
  }
  if (el.classList.contains("bouten")) {
    const text = el.textContent ?? "";
    if (text === el.dataset.text) return src;
    return forms ? emphasisSource(forms, text) : src;
  }
  // 見出し記号は触れないので、いつでも元のまま
  return src;
}

/**
 * 編集された塊の `data-*` を、いまの中身に合わせて更新する。
 *
 * 本文を Rust に送ったあとに呼ぶ。更新しないと `data-src` が古いまま
 * になり、品詞マーカーの位置合わせ（segment.ts は data-src の長さを
 * 記法テキスト上の幅として使う）がずれる。
 *
 * DOM の形は変えない。キャレットが飛ばないようにするため。
 */
export function commitPreviewEdits(root: HTMLElement, forms: NotationForms | null): void {
  if (!forms) return;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-src]"))) {
    if (el.tagName === "RUBY") {
      const base = rubyBase(el);
      let reading = rubyReading(el);
      if (base === el.dataset.text && reading === el.dataset.ruby) continue;
      if (base === "") {
        // 親文字が消えたらルビも用がない。読みだけが宙に浮かないよう落とす
        const rt = el.querySelector("rt");
        if (rt) rt.textContent = "";
        reading = "";
      }
      el.dataset.src = rubySource(forms, base, reading);
      el.dataset.text = base;
      el.dataset.ruby = reading;
      continue;
    }
    if (!el.classList.contains("bouten")) continue;
    const text = el.textContent ?? "";
    if (text === el.dataset.text) continue;
    el.dataset.src = emphasisSource(forms, text);
    el.dataset.text = text;
    // 打ち替えられた字にも点が出るよう、文字ごとの入れ物を組み直す
    fillBouten(el, text);
  }
}

/**
 * プレビューの段落要素から記法テキストを読み戻す。
 *
 * ルビや傍点は `blockSource()` に任せる。表示されている文字だけから
 * 組み立て直すと読みや傍点の記号が落ちるし、`data-src` を無条件に
 * 使うと編集した内容が捨てられる。
 */
export function readPreviewPara(el: Element, forms: NotationForms | null): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const e = node as HTMLElement;
    if (e.dataset.src !== undefined) {
      out += blockSource(e, forms);
      continue;
    }
    // 傍線モードの span など、塊ではない要素はテキストとして拾う
    out += e.textContent ?? "";
  }
  return out;
}

/** プレビュー全体を記法テキストに戻す。 */
export function readPreview(root: HTMLElement, forms: NotationForms | null): string {
  return Array.from(root.children)
    .map((el) => readPreviewPara(el, forms))
    .join("\n");
}
