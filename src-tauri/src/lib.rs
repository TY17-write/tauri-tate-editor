mod analyzer;
mod document;

use std::sync::Mutex;

use tauri::State;

use document::{AnalyzeResult, Document, ParaId, ParaView};

/// 本文の正本。フロントエンドは表示用のミラーだけを持つ。
struct AppState {
    doc: Mutex<Document>,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            doc: Mutex::new(Document::new()),
        })
        .invoke_handler(tauri::generate_handler![
            set_text,
            update_para,
            analyze,
            analyze_pending,
            get_text,
            char_count
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
