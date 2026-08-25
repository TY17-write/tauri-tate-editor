//! 形態素解析。Lindera を常駐させ、段落単位で品詞のマーカー範囲を返す。
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
/// UniDic では形容動詞が「形状詞」という品詞名で分類される。
/// IPADIC に切り替えた場合は「名詞,形容動詞語幹」になるため、
/// 判定は [`PosTag::from_details`] に閉じ込めてある。
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
    /// details の並びは辞書によって違うが、先頭が品詞大分類である点は
    /// UniDic・IPADIC で共通。
    fn from_details(details: &[&str]) -> Option<Self> {
        let major = *details.first()?;
        match major {
            "副詞" => Some(PosTag::Adverb),
            "形容詞" => Some(PosTag::Adjective),
            "形状詞" => Some(PosTag::AdjectivalNoun),
            "連体詞" => Some(PosTag::Adnominal),
            // IPADIC 互換：名詞のうち形容動詞語幹だけを拾う
            "名詞" => {
                let sub = details.get(1).copied().unwrap_or("");
                if sub == "形容動詞語幹" {
                    Some(PosTag::AdjectivalNoun)
                } else {
                    None
                }
            }
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

static SEGMENTER: OnceCell<Segmenter> = OnceCell::new();

/// 辞書を読み込んで Segmenter を用意する。二回目以降は使い回す。
fn segmenter() -> Result<&'static Segmenter, String> {
    SEGMENTER.get_or_try_init(|| {
        let dictionary =
            load_dictionary("embedded://unidic").map_err(|e| format!("辞書の読み込みに失敗: {e}"))?;
        Ok(Segmenter::new(Mode::Normal, dictionary, None))
    })
}

/// 一段落を解析してマーカー範囲を返す。
pub fn analyze_text(text: &str) -> Result<Vec<Mark>, String> {
    if text.is_empty() {
        return Ok(Vec::new());
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

    let mut marks = Vec::new();
    for token in tokens.iter_mut() {
        let details = token.details();
        let Some(pos) = PosTag::from_details(&details) else {
            continue;
        };
        let (s, e) = (token.byte_start, token.byte_end);
        if s > text.len() || e > text.len() || s >= e {
            continue;
        }
        marks.push(Mark {
            start: utf16_at[s],
            end: utf16_at[e],
            pos,
        });
    }
    Ok(marks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 副詞と形容詞を拾う() {
        let marks = analyze_text("とても静かな夜だった。ゆっくりと長い道を歩く。").unwrap();
        assert!(!marks.is_empty(), "マーカーが1つも取れていない");
        assert!(marks.iter().any(|m| m.pos == PosTag::Adverb));
        assert!(marks.iter().any(|m| m.pos == PosTag::Adjective));
    }

    #[test]
    fn サロゲートペアを含んでも位置がずれない() {
        // 𠮟 は UTF-8 で 4 バイト、UTF-16 で 2 コード単位
        let text = "𠮟られてとても悲しい";
        let marks = analyze_text(text).unwrap();
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
        assert!(analyze_text("").unwrap().is_empty());
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

    /// 解析結果を目で見るための補助。`cargo test 解析結果を表示 -- --nocapture`
    #[test]
    fn 解析結果を表示() {
        for text in [
            "とくに考えるまでもなく、問題とならない",
            "問題とならない",
            "とても静かな夜だった",
        ] {
            let marks = analyze_text(text).unwrap();
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
