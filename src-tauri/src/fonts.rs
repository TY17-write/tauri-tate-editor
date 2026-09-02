//! インストール済みフォントの一覧。
//!
//! fontdb で列挙し、**日本語のグリフを持つ書体だけ**を返す。縦書きの
//! 原稿で英数専用の書体を選んでも、和文はフォールバックで描かれて
//! 見た目が揃わないだけなので、最初から出さない。
//!
//! 持っているかどうかは名前では分からないので、実際にフォントを
//! 開いて cmap を引く（ひらがなと漢字を 1 字ずつ）。ファミリーごとに
//! 最初の 1 面だけを見る。列挙は一度だけ行い、以後は使い回す。

use std::collections::HashSet;

use fontdb::Language;
use once_cell::sync::OnceCell;
use serde::Serialize;

/// 書体の一項目。
#[derive(Debug, Clone, Serialize)]
pub struct FontEntry {
    /// CSS の font-family に書く名前（フォントの既定名。ふつう英語）
    pub name: String,
    /// 画面に出す名前。日本語名があればそちら
    pub label: String,
}

static FONTS: OnceCell<Vec<FontEntry>> = OnceCell::new();

/// 日本語の書けるインストール済みフォントの一覧。ラベル順。
pub fn list() -> &'static [FontEntry] {
    FONTS.get_or_init(collect)
}

fn collect() -> Vec<FontEntry> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<FontEntry> = Vec::new();

    for face in db.faces() {
        // families の先頭は原則として英語名（フォントの既定名）
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        // 同じファミリーの太字や斜体で何度も開かないよう、名前で 1 回だけ
        if !seen.insert(name.clone()) {
            continue;
        }

        let covers = db
            .with_face_data(face.id, |data, index| {
                ttf_parser::Face::parse(data, index)
                    .map(|f| f.glyph_index('あ').is_some() && f.glyph_index('永').is_some())
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !covers {
            continue;
        }

        let label = face
            .families
            .iter()
            .find(|(_, lang)| *lang == Language::Japanese_Japan)
            .map(|(n, _)| n.clone())
            .unwrap_or_else(|| name.clone());
        out.push(FontEntry {
            name: name.clone(),
            label,
        });
    }

    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 日本語の書体が見つかる() {
        // Windows なら MS ゴシックや游ゴシックが必ず入っている
        let fonts = list();
        assert!(!fonts.is_empty(), "日本語の書体が 1 つも見つからない");
    }

    #[test]
    fn 英数専用の書体は出てこない() {
        let names: Vec<&str> = list().iter().map(|f| f.name.as_str()).collect();
        // Arial は代表的な英数専用書体。混ざっていたら選別が働いていない
        assert!(!names.contains(&"Arial"), "英数専用の書体が混ざっている");
    }

    /// 一覧を目で見るための補助。`cargo test 書体一覧を表示 -- --nocapture`
    #[test]
    fn 書体一覧を表示() {
        let fonts = list();
        println!("{} 書体", fonts.len());
        for f in fonts.iter().take(40) {
            println!("  {} ({})", f.label, f.name);
        }
    }

    #[test]
    fn 同じ書体は一度しか出ない() {
        let fonts = list();
        let mut seen = std::collections::HashSet::new();
        for f in fonts {
            assert!(seen.insert(&f.name), "重複: {}", f.name);
        }
    }
}
