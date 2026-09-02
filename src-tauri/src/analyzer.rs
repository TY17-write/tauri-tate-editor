//! 形態素解析。Lindera（辞書は SudachiDict）を常駐させ、段落単位で
//! 品詞のマーカー範囲を返す。SudachiDict は語ごとに同義語グループ番号
//! （details 末尾の synonym_group_ids）を持つので、類義語検索を後から
//! 同じ辞書で実装できる。
//!
//! 辞書のロードは重いので `OnceCell` で一度だけ行う。
//! 返すオフセットは UTF-16 単位。JavaScript の文字列はコード単位が
//! UTF-16 なので、Rust のバイト位置のまま渡すとサロゲートペアを含む
//! 段落でマーカー位置がずれる。

use std::borrow::Cow;

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;

/// マーカーを引く品詞。
///
/// SudachiDict（UniDic 系）では形容動詞が「形状詞」という品詞名で
/// 分類される。判定は [`PosTag::from_details`] に閉じ込めてある。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PosTag {
    /// 副詞
    Adverb,
    /// 形容詞
    Adjective,
    /// 形容動詞（UniDic の形状詞）
    AdjectivalNoun,
    /// 連体詞
    Adnominal,
}

impl PosTag {
    /// Lindera の details から、マーカー対象の品詞かどうかを判定する。
    ///
    /// details の並びは辞書スキーマで決まる。SudachiDict では
    /// `[表示表層, 品詞大分類, 中分類, …]` の順なので、品詞大分類は
    /// 2 番目（UniDic では先頭だった）。未知語は details が
    /// `["UNK"]` の 1 要素になり、ここで None に落ちる。
    fn from_details(details: &[&str]) -> Option<Self> {
        let major = *details.get(1)?;
        match major {
            "副詞" => Some(PosTag::Adverb),
            "形容詞" => Some(PosTag::Adjective),
            "形状詞" => Some(PosTag::AdjectivalNoun),
            "連体詞" => Some(PosTag::Adnominal),
            _ => None,
        }
    }
}

/// 段落内のマーカー範囲。オフセットは UTF-16 単位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    pub start: u32,
    pub end: u32,
    pub pos: PosTag,
}

/// 表記ゆれ検出に使う語。位置は UTF-16 単位。
///
/// SudachiDict の正規化形は語形の揺れと活用を吸収した見出しになる
/// （子ども→子供、頂い→頂く）。同じ正規化形・同じ活用の位置で
/// 表層が違えば、それは書き分けではなく表記の揺れ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub start: u32,
    pub end: u32,
    /// 画面に出ている表記
    pub surface: String,
    /// 正規化形
    pub norm: String,
    /// 活用型と活用形（`五段-カ行|連用形-イ音便`）。無活用は `*|*`
    pub conj: String,
    /// 品詞大分類
    pub pos: String,
}

/// 一段落ぶんの解析結果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Analysis {
    pub marks: Vec<Mark>,
    pub words: Vec<Word>,
}

/// 表記ゆれを見る品詞。
/// 助詞・助動詞・記号は表記が揺れても意図的なことが多いので見ない。
/// 数詞も除く（三人/3人 は組版の方針であって語の揺れではない）。
fn is_variant_pos(major: &str, minor: &str) -> bool {
    if minor == "数詞" {
        return false;
    }
    matches!(
        major,
        "名詞" | "代名詞" | "動詞" | "形容詞" | "形状詞" | "副詞" | "連体詞" | "接続詞" | "感動詞"
    )
}

static SEGMENTER: OnceCell<Segmenter> = OnceCell::new();

/// 辞書を読み込んで Segmenter を用意する。二回目以降は使い回す。
pub(crate) fn segmenter() -> Result<&'static Segmenter, String> {
    SEGMENTER.get_or_try_init(|| {
        let dictionary = load_dictionary("embedded://sudachidict")
            .map_err(|e| format!("辞書の読み込みに失敗: {e}"))?;
        Ok(Segmenter::new(Mode::Normal, dictionary, None))
    })
}

/// 一段落を解析して、マーカー範囲と表記ゆれ用の語を返す。
///
/// 一度の分かち書きから両方を取り出す。マーカーは打鍵のたびに
/// 引き直すので、ここで二度解析すると重くなる。
pub fn analyze_text(text: &str) -> Result<Analysis, String> {
    if text.is_empty() {
        return Ok(Analysis::default());
    }

    let seg = segmenter()?;
    let mut tokens = seg
        .segment(Cow::Borrowed(text))
        .map_err(|e| format!("解析に失敗: {e}"))?;

    // バイト位置 → UTF-16 位置の対応表を作る。
    // 各バイト境界に対応する UTF-16 オフセットを引けるようにしておく。
    let mut utf16_at = vec![0u32; text.len() + 1];
    let mut u16_pos = 0u32;
    for (byte_idx, ch) in text.char_indices() {
        utf16_at[byte_idx] = u16_pos;
        u16_pos += ch.len_utf16() as u32;
    }
    utf16_at[text.len()] = u16_pos;

    let mut out = Analysis::default();
    for token in tokens.iter_mut() {
        let (s, e) = (token.byte_start, token.byte_end);
        if s > text.len() || e > text.len() || s >= e {
            continue;
        }
        let details = token.details();

        if let Some(pos) = PosTag::from_details(&details) {
            out.marks.push(Mark {
                start: utf16_at[s],
                end: utf16_at[e],
                pos,
            });
        }

        // 表記ゆれ用の語。未知語（details が短い）はここで落ちる
        let (Some(major), Some(minor), Some(norm)) =
            (details.get(1), details.get(2), details.get(8))
        else {
            continue;
        };
        if !is_variant_pos(major, minor) || *norm == "*" || norm.is_empty() {
            continue;
        }
        let conj_type = details.get(5).copied().unwrap_or("*");
        let conj_form = details.get(6).copied().unwrap_or("*");
        out.words.push(Word {
            start: utf16_at[s],
            end: utf16_at[e],
            surface: text[s..e].to_string(),
            norm: (*norm).to_string(),
            conj: format!("{conj_type}|{conj_form}"),
            pos: (*major).to_string(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 副詞と形容詞を拾う() {
        let marks = analyze_text("とても静かな夜だった。ゆっくりと長い道を歩く。")
            .unwrap()
            .marks;
        assert!(!marks.is_empty(), "マーカーが1つも取れていない");
        assert!(marks.iter().any(|m| m.pos == PosTag::Adverb));
        assert!(marks.iter().any(|m| m.pos == PosTag::Adjective));
    }

    #[test]
    fn サロゲートペアを含んでも位置がずれない() {
        // 𠮟 は UTF-8 で 4 バイト、UTF-16 で 2 コード単位
        let text = "𠮟られてとても悲しい";
        let marks = analyze_text(text).unwrap().marks;
        let utf16: Vec<u16> = text.encode_utf16().collect();
        for m in &marks {
            assert!(
                (m.end as usize) <= utf16.len(),
                "UTF-16 の範囲を超えている: {m:?} / len={}",
                utf16.len()
            );
            // 範囲が実際に切り出せることを確認する
            let slice = &utf16[m.start as usize..m.end as usize];
            assert!(!String::from_utf16_lossy(slice).is_empty());
        }
    }

    #[test]
    fn 空文字列は空を返す() {
        assert!(analyze_text("").unwrap().marks.is_empty());
    }

    #[test]
    fn 同じ本文なら常に同じ結果になる() {
        // 「同じ文なのにマーカーの付き方が違う」という症状の切り分け用。
        // 解析器がここで決定的だと分かれば、差が出た場合の原因は
        // フロントエンドが送った本文の側にあると言い切れる。
        let text = "とくに考えるまでもなく、問題とならない";
        let a = analyze_text(text).unwrap();
        let b = analyze_text(text).unwrap();
        let c = analyze_text(text).unwrap();
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    /// details の並びを目で見るための補助。
    /// `cargo test 詳細を表示 -- --nocapture`
    #[test]
    fn 詳細を表示() {
        let seg = segmenter().unwrap();
        for text in ["子どもを頂いた。走った犬。ヴァイオリンだ"] {
            let mut tokens = seg.segment(Cow::Borrowed(text)).unwrap();
            println!("── {text}");
            for t in tokens.iter_mut() {
                let d = t.details();
                println!("   {:?}", d);
            }
        }
    }

    /// 解析結果を目で見るための補助。`cargo test 解析結果を表示 -- --nocapture`
    #[test]
    fn 解析結果を表示() {
        for text in [
            "とくに考えるまでもなく、問題とならない",
            "問題とならない",
            "とても静かな夜だった",
        ] {
            let marks = analyze_text(text).unwrap().marks;
            let u: Vec<u16> = text.encode_utf16().collect();
            println!("── {text}");
            if marks.is_empty() {
                println!("   （マーカーなし）");
            }
            for m in &marks {
                let s = String::from_utf16_lossy(&u[m.start as usize..m.end as usize]);
                println!("   {:?} {:?} [{}..{}]", s, m.pos, m.start, m.end);
            }
        }
    }
}
