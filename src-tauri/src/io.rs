//! ファイルの読み書きと文字コードの判定。
//!
//! 小説の原稿は Shift_JIS で保存されていることが珍しくない。
//! 青空文庫のテキストもそうなので、読み込みでは文字コードを推定する。
//! 保存は UTF-8 に寄せる（BOM の有無は選べるようにしてある）。

use std::fs;
use std::path::Path;

use encoding_rs::{EUC_JP, SHIFT_JIS, UTF_16BE, UTF_16LE};
use serde::Serialize;

/// 読み込み結果。
#[derive(Debug, Clone, Serialize)]
pub struct LoadResult {
    pub text: String,
    /// 判定した文字コードの表示名
    pub encoding: String,
    /// 元のファイルの改行コード（保存時に戻せるように覚えておく）
    pub newline: String,
}

/// バイト列を文字列に直す。文字コードは推定する。
///
/// 判定の順番:
///   1. BOM があればそれに従う
///   2. UTF-8 として妥当なら UTF-8
///   3. Shift_JIS として文字化けなく読めるなら Shift_JIS
///   4. EUC-JP として文字化けなく読めるなら EUC-JP
///   5. どれでもなければ Shift_JIS として強引に読む（国内の原稿を想定）
pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).into_owned(), "UTF-8 (BOM)");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return (UTF_16LE.decode(rest).0.into_owned(), "UTF-16 LE");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return (UTF_16BE.decode(rest).0.into_owned(), "UTF-16 BE");
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_owned(), "UTF-8");
    }
    let (cow, _, had_errors) = SHIFT_JIS.decode(bytes);
    if !had_errors {
        return (cow.into_owned(), "Shift_JIS");
    }
    let (cow, _, had_errors) = EUC_JP.decode(bytes);
    if !had_errors {
        return (cow.into_owned(), "EUC-JP");
    }
    let (cow, _, _) = SHIFT_JIS.decode(bytes);
    (cow.into_owned(), "Shift_JIS (一部読めず)")
}

/// 元のファイルで使われていた改行コードを見る。
fn detect_newline(s: &str) -> &'static str {
    if s.contains("\r\n") {
        "\r\n"
    } else if s.contains('\r') {
        "\r"
    } else {
        "\n"
    }
}

/// 改行を LF に揃える。エディタ内部では常に LF で扱う。
pub fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// ファイルを読む。
pub fn load(path: &Path) -> Result<LoadResult, String> {
    let bytes = fs::read(path).map_err(|e| format!("読み込めません: {e}"))?;
    let (raw, encoding) = decode(&bytes);
    let newline = detect_newline(&raw);
    Ok(LoadResult {
        text: normalize_newlines(&raw),
        encoding: encoding.to_string(),
        newline: newline.to_string(),
    })
}

/// ファイルへ書く。内部の LF を、指定された改行コードに直してから保存する。
pub fn save(path: &Path, text: &str, newline: &str, bom: bool) -> Result<(), String> {
    let body = if newline == "\n" {
        text.to_owned()
    } else {
        text.replace('\n', newline)
    };
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(body.as_bytes());

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("フォルダを作れません: {e}"))?;
    }
    fs::write(path, &bytes).map_err(|e| format!("保存できません: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_を読める() {
        let (s, enc) = decode("とても静かな夜".as_bytes());
        assert_eq!(s, "とても静かな夜");
        assert_eq!(enc, "UTF-8");
    }

    #[test]
    fn utf8_の_bom_を落とす() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("夜半の風".as_bytes());
        let (s, enc) = decode(&b);
        assert_eq!(s, "夜半の風");
        assert_eq!(enc, "UTF-8 (BOM)");
    }

    #[test]
    fn shift_jis_を読める() {
        // 青空文庫の原稿など、国内のテキストは Shift_JIS のことがある
        let (bytes, _, _) = SHIFT_JIS.encode("とても静かな夜だった。");
        let (s, enc) = decode(&bytes);
        assert_eq!(s, "とても静かな夜だった。");
        assert_eq!(enc, "Shift_JIS");
    }

    #[test]
    fn 改行を_lf_に揃える() {
        assert_eq!(normalize_newlines("あ\r\nい\rう\nえ"), "あ\nい\nう\nえ");
    }

    #[test]
    fn 改行コードを見分ける() {
        assert_eq!(detect_newline("あ\r\nい"), "\r\n");
        assert_eq!(detect_newline("あ\rい"), "\r");
        assert_eq!(detect_newline("あ\nい"), "\n");
        assert_eq!(detect_newline("改行なし"), "\n");
    }

    #[test]
    fn 保存して読み直すと元に戻る() {
        let dir = std::env::temp_dir().join("tate-editor-test");
        let path = dir.join("round-trip.txt");
        let text = "夜半の風が硝子戸を鳴らしていた。\n\nとても静かな夜だった。";

        save(&path, text, "\n", false).unwrap();
        let got = load(&path).unwrap();
        assert_eq!(got.text, text);
        assert_eq!(got.encoding, "UTF-8");

        // CRLF で保存しても、読み込み時には LF に揃う
        save(&path, text, "\r\n", false).unwrap();
        let got = load(&path).unwrap();
        assert_eq!(got.text, text);
        assert_eq!(got.newline, "\r\n");

        let _ = fs::remove_file(&path);
    }
}
