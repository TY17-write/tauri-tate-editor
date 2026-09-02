mod analyzer;
mod backup;
mod document;
mod fonts;
mod io;
mod notation;
mod stats;
mod synonyms;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use document::{AnalyzeResult, Document, ParaId, ParaView};
use io::LoadResult;
use notation::{EmphasisEdit, Notation, NotationCount, NotationForms, Piece};
use stats::{StyleOptions, StyleReport};

/// 本文の正本。フロントエンドは表示用のミラーだけを持つ。
struct AppState {
    doc: Mutex<Document>,
    /// いま開いているファイル。新規なら None
    file: Mutex<Option<OpenFile>>,
}

/// 開いているファイルの素性。
#[derive(Debug, Clone)]
struct OpenFile {
    path: PathBuf,
    /// 元のファイルの改行コード。保存時に戻す
    newline: String,
    /// 元が UTF-8 BOM 付きだったか
    bom: bool,
}

/// 保存の結果。フロントエンドの表示に使う。
#[derive(Debug, Clone, Serialize)]
struct SaveResult {
    path: String,
    bytes: usize,
}

/// 本文全体を差し替え、段落の一覧を返す。
#[tauri::command]
fn set_text(state: State<'_, AppState>, text: String) -> Result<Vec<ParaView>, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    Ok(doc.set_text(&text))
}

/// 一段落の本文を差し替える。解析結果はここで無効化される。
#[tauri::command]
fn update_para(state: State<'_, AppState>, id: ParaId, text: String) -> Result<bool, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    Ok(doc.update(id, text))
}

/// まだ解析していない段落だけを解析して返す。
///
/// `#[tauri::command]` の同期関数は Tauri がワーカースレッドで実行するため、
/// 辞書引きでブロックしても UI スレッドは止まらない。
#[tauri::command]
fn analyze_pending(state: State<'_, AppState>) -> Result<Vec<AnalyzeResult>, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    doc.analyze_pending()
}

/// 指定した段落を解析する。空の配列を渡すと全段落が対象。
#[tauri::command]
fn analyze(state: State<'_, AppState>, ids: Vec<ParaId>) -> Result<Vec<AnalyzeResult>, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    doc.analyze(&ids)
}

/// 本文全体を改行区切りで取り出す。
#[tauri::command]
fn get_text(state: State<'_, AppState>) -> Result<String, String> {
    let doc = state.doc.lock().map_err(|e| e.to_string())?;
    Ok(doc.text())
}

/// 改行を除いた文字数。
#[tauri::command]
fn char_count(state: State<'_, AppState>) -> Result<usize, String> {
    let doc = state.doc.lock().map_err(|e| e.to_string())?;
    Ok(doc.char_count())
}

/// 文体を調べて報告を返す。
///
/// 未解析の段落があれば先に解析するので、初回は時間がかかることがある。
#[tauri::command]
fn style_report(
    state: State<'_, AppState>,
    options: Option<StyleOptions>,
) -> Result<StyleReport, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    doc.style_report(&options.unwrap_or_default())
}

/// 本文の記法を別の記法に直す。直したあとの本文を返す。
///
/// 傍点を書けない記法へ移すときは記号を落として文字だけ残す。
/// 記号を残すと投稿先でそのまま表示されてしまうため。
#[tauri::command]
fn convert_notation(
    state: State<'_, AppState>,
    from: Notation,
    to: Notation,
) -> Result<String, String> {
    let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
    let converted = notation::convert(&doc.text(), from, to);
    doc.set_text(&converted);
    Ok(converted)
}

/// 本文に含まれるルビと傍点の数。記法を変える前の確認に使う。
#[tauri::command]
fn count_notation(
    state: State<'_, AppState>,
    notation_kind: Notation,
) -> Result<NotationCount, String> {
    let doc = state.doc.lock().map_err(|e| e.to_string())?;
    Ok(notation::count(&doc.text(), notation_kind))
}

/// 本文をプレビュー用の部品に分ける。段落ごとの配列で返す。
#[tauri::command]
fn preview_pieces(
    state: State<'_, AppState>,
    notation_kind: Notation,
) -> Result<Vec<Vec<Piece>>, String> {
    let doc = state.doc.lock().map_err(|e| e.to_string())?;
    Ok(doc
        .text()
        .split('\n')
        .map(|l| notation::pieces(l, notation_kind))
        .collect())
}

/// その記法でのルビと傍点の書き方（型紙）を返す。
///
/// プレビューでルビを直したとき、画面側はこれを使って記法を
/// 組み立て直す。書き方の定義を画面側にも書くと食い違うため、
/// Rust の表を渡して使わせる。
#[tauri::command]
fn notation_forms(notation_kind: Notation) -> NotationForms {
    notation::forms(notation_kind)
}

/// 一行だけをプレビュー用の部品に分ける。
///
/// 傍点を付け外ししたあとに、その段落だけを組み直すのに使う。
/// 本文には触らない（正本を書き換えるのは `set_text` の役目）。
#[tauri::command]
fn line_pieces(line: String, notation_kind: Notation) -> Vec<Piece> {
    notation::pieces(&line, notation_kind)
}

/// 行の指定範囲に傍点を付ける、または外す。
///
/// すでに傍点が掛かっていれば外す。ルビに掛かる範囲には付けられない
/// ので None を返す。位置は UTF-16 で数える。
#[tauri::command]
fn toggle_emphasis(
    line: String,
    start: u32,
    end: u32,
    notation_kind: Notation,
) -> Option<EmphasisEdit> {
    notation::toggle_emphasis(&line, start, end, notation_kind)
}

/// 行の中の位置（UTF-16）から類義語を引く。
///
/// `start == end` ならキャレット位置の語を分かち書きで探す。
/// SudachiDict の同義語グループ番号と、同義語辞書の見出し一致の
/// 両方で引く。見つからなければ null。
#[tauri::command]
fn synonyms_at(line: String, start: u32, end: u32) -> Result<Option<synonyms::SynonymHit>, String> {
    synonyms::lookup(&line, start, end)
}

/// 日本語の書けるインストール済みフォントの一覧。
///
/// 初回は全フォントの cmap を引くので少し時間がかかる。同期コマンドは
/// ワーカースレッドで走るため UI は止まらず、二回目からは即返る。
#[tauri::command]
fn list_fonts() -> Vec<fonts::FontEntry> {
    fonts::list().to_vec()
}

/// ファイルを読み込み、本文として取り込む。
///
/// 文字コードは推定する（青空文庫の原稿など Shift_JIS のことがある）。
/// 改行は内部では常に LF に揃え、元の改行コードは保存時に戻せるよう覚えておく。
#[tauri::command]
fn open_file(state: State<'_, AppState>, path: String) -> Result<LoadResult, String> {
    let p = PathBuf::from(&path);
    let loaded = io::load(&p)?;

    {
        let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
        doc.set_text(&loaded.text);
    }
    {
        let mut file = state.file.lock().map_err(|e| e.to_string())?;
        *file = Some(OpenFile {
            path: p,
            newline: loaded.newline.clone(),
            bom: loaded.encoding.contains("BOM"),
        });
    }
    Ok(loaded)
}

/// 保存する。旧版は世代バックアップへ退避する。
///
/// `path` を省略すると、いま開いているファイルへ上書きする。
#[tauri::command]
fn save_file(
    state: State<'_, AppState>,
    path: Option<String>,
    text: String,
) -> Result<SaveResult, String> {
    let current = state.file.lock().map_err(|e| e.to_string())?.clone();
    let target: PathBuf = match (&path, &current) {
        (Some(p), _) => PathBuf::from(p),
        (None, Some(f)) => f.path.clone(),
        (None, None) => return Err("保存先が決まっていません".into()),
    };

    // 上書きする前に旧版を退避する
    backup::rotate(&target)?;

    let (newline, bom) = current
        .as_ref()
        .filter(|f| f.path == target)
        .map(|f| (f.newline.clone(), f.bom))
        .unwrap_or_else(|| ("\n".to_string(), false));

    io::save(&target, &text, &newline, bom)?;

    {
        let mut doc = state.doc.lock().map_err(|e| e.to_string())?;
        doc.set_text(&text);
    }
    {
        let mut file = state.file.lock().map_err(|e| e.to_string())?;
        *file = Some(OpenFile {
            path: target.clone(),
            newline,
            bom,
        });
    }

    Ok(SaveResult {
        path: target.to_string_lossy().into_owned(),
        bytes: text.len(),
    })
}

/// 自動保存。開いているファイルの隣に `.autosave` を書く。
///
/// 保存先が決まっていない新規の原稿では何もしない（呼び出し側で
/// 保存を促すほうが分かりやすい）。
#[tauri::command]
fn autosave(state: State<'_, AppState>, text: String) -> Result<Option<String>, String> {
    let current = state.file.lock().map_err(|e| e.to_string())?.clone();
    let Some(f) = current else {
        return Ok(None);
    };
    let target = backup::autosave_path(&f.path);
    io::save(&target, &text, &f.newline, f.bom)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// いま開いているファイルのパス。
#[tauri::command]
fn current_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let file = state.file.lock().map_err(|e| e.to_string())?;
    Ok(file.as_ref().map(|f| f.path.to_string_lossy().into_owned()))
}

/// 自動保存が残っていれば、その中身を返す。
///
/// アプリが落ちたあとの復旧に使う。
#[tauri::command]
fn take_autosave(path: String) -> Result<Option<String>, String> {
    let p = backup::autosave_path(Path::new(&path));
    if !p.exists() {
        return Ok(None);
    }
    Ok(Some(io::load(&p)?.text))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            doc: Mutex::new(Document::new()),
            file: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            set_text,
            update_para,
            analyze,
            analyze_pending,
            get_text,
            char_count,
            style_report,
            convert_notation,
            count_notation,
            preview_pieces,
            notation_forms,
            line_pieces,
            toggle_emphasis,
            synonyms_at,
            list_fonts,
            open_file,
            save_file,
            autosave,
            current_path,
            take_autosave
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
