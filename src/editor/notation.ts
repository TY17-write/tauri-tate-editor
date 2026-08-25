/**
 * ルビと傍点の記法。変換そのものは Rust 側（notation.rs）が行う。
 *
 * プレビューは「部品の配列」を受け取って組み立てる。ルビと傍点は
 * 編集できない塊として置き、元の記法を `data-src` に持たせる。
 * こうしておけば、プレビューのまま本文を編集しても、記法テキストへ
 * 正しく戻せる。
 */

import { invoke } from "@tauri-apps/api/core";

export type Notation = "narou" | "kakuyomu" | "aozora" | "pixiv";

export const NOTATIONS: { value: Notation; label: string; emphasis: boolean; hint: string }[] = [
  {
    value: "narou",
    label: "小説家になろう",
    emphasis: false,
    hint: "ルビ |漢字《かんじ》　傍点は使えません",
  },
  {
    value: "kakuyomu",
    label: "カクヨム",
    emphasis: true,
    hint: "ルビ |漢字《かんじ》　傍点 《《文字》》",
  },
  {
    value: "aozora",
    label: "青空文庫",
    emphasis: true,
    hint: "ルビ ｜漢字《かんじ》　傍点 ［＃「文字」に傍点］",
  },
  {
    value: "pixiv",
    label: "pixiv",
    emphasis: false,
    hint: "ルビ [[rb:漢字 > かんじ]]　傍点は使えません",
  },
];

export function notationInfo(n: Notation) {
  return NOTATIONS.find((x) => x.value === n) ?? NOTATIONS[0];
}

/** プレビューの部品。 */
export interface Piece {
  kind: "text" | "ruby" | "emphasis";
  text: string;
  ruby: string;
  src: string;
}

export interface NotationCount {
  ruby: number;
  emphasis: number;
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
 * ルビと傍点は `contenteditable="false"` の塊にする。こうすると
 * ブラウザがひとまとまりとして扱うので、キャレットが中に入り込んで
 * 記法が壊れることがない。消すときは塊ごと消える。
 */
export function buildPreviewPara(pieces: Piece[]): HTMLParagraphElement {
  const p = document.createElement("p");
  for (const piece of pieces) {
    if (piece.kind === "text") {
      p.appendChild(document.createTextNode(piece.text));
      continue;
    }
    if (piece.kind === "ruby") {
      const ruby = document.createElement("ruby");
      ruby.contentEditable = "false";
      ruby.dataset.src = piece.src;
      ruby.appendChild(document.createTextNode(piece.text));
      const rt = document.createElement("rt");
      rt.textContent = piece.ruby;
      ruby.appendChild(rt);
      p.appendChild(ruby);
      continue;
    }
    const em = document.createElement("span");
    em.className = "bouten";
    em.contentEditable = "false";
    em.dataset.src = piece.src;
    em.textContent = piece.text;
    p.appendChild(em);
  }
  return p;
}

/**
 * プレビューの段落要素から記法テキストを読み戻す。
 *
 * ルビや傍点は `data-src` の記法をそのまま使う。表示されている
 * 文字（親文字だけ、傍点の記号なし）から組み立て直そうとすると
 * 情報が落ちてしまう。
 */
export function readPreviewPara(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const e = node as HTMLElement;
    const src = e.dataset.src;
    if (src !== undefined) {
      out += src;
      continue;
    }
    // 想定外の要素はテキストとして拾う
    out += e.textContent ?? "";
  }
  return out;
}

/** プレビュー全体を記法テキストに戻す。 */
export function readPreview(root: HTMLElement): string {
  return Array.from(root.children)
    .map((el) => readPreviewPara(el))
    .join("\n");
}
