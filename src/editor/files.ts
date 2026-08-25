/**
 * ファイルの開閉と保存、自動保存。
 *
 * 実際の読み書きと文字コードの判定は Rust 側（io.rs / backup.rs）が行う。
 * ここはダイアログを出してパスを受け取り、本文を受け渡すだけ。
 */

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface LoadResult {
  text: string;
  encoding: string;
  newline: string;
}

export interface SaveResult {
  path: string;
  bytes: number;
}

const FILTERS = [
  { name: "テキスト", extensions: ["txt", "text"] },
  { name: "すべて", extensions: ["*"] },
];

/** 開くダイアログを出してファイルを読む。取り消されたら null。 */
export async function openWithDialog(): Promise<(LoadResult & { path: string }) | null> {
  const picked = await open({ multiple: false, directory: false, filters: FILTERS });
  if (typeof picked !== "string") return null;
  const loaded = await invoke<LoadResult>("open_file", { path: picked });
  return { ...loaded, path: picked };
}

/** いま開いているファイルへ上書き保存する。保存先が未定なら null。 */
export async function saveToCurrent(text: string): Promise<SaveResult | null> {
  const current = await invoke<string | null>("current_path");
  if (!current) return null;
  return invoke<SaveResult>("save_file", { path: null, text });
}

/** 名前を付けて保存する。取り消されたら null。 */
export async function saveWithDialog(text: string): Promise<SaveResult | null> {
  const picked = await save({ filters: FILTERS, defaultPath: "原稿.txt" });
  if (typeof picked !== "string") return null;
  return invoke<SaveResult>("save_file", { path: picked, text });
}

/** 自動保存。保存先が未定なら何もせず null を返す。 */
export async function autosave(text: string): Promise<string | null> {
  return invoke<string | null>("autosave", { text });
}

/** いま開いているファイルのパス。 */
export async function currentPath(): Promise<string | null> {
  return invoke<string | null>("current_path");
}

/** 前回の自動保存が残っていれば、その本文を返す。 */
export async function takeAutosave(path: string): Promise<string | null> {
  return invoke<string | null>("take_autosave", { path });
}

/** パスから表示用のファイル名を取り出す。 */
export function baseName(path: string): string {
  const m = path.split(/[\\/]/);
  return m[m.length - 1] || path;
}
