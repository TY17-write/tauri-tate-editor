//! 類義語検索。Sudachi 同義語辞書（assets/synonyms.txt）を引く。
//!
//! SudachiDict は語ごとに同義語グループ番号を持っていて、分かち書きの
//! details 末尾（synonym_group_ids、`016008/019163` のような形）で
//! 取れる。番号からグループの中身（語の一覧）を引くのがこの表の役目。
//!
//! synonyms.txt は SudachiDict と同じ Works Applications の配布物
//! （Apache License 2.0）。1 行が 1 語で、
//!   グループ番号,体言用言,展開制御,語彙素番号,語形種別,略語,表記揺れ,分野,見出し,,
//! の並び。展開制御 2 は誤表記などの「提案してはいけない語」。
//!
//! 語からグループを引く索引も作っておく。辞書にグループ番号が
//! 載っていない語（活用形や、辞書の版ずれ）でも、見出しの完全一致で
//! 引けるようにするため。

use std::collections::HashMap;

use once_cell::sync::OnceCell;
use serde::Serialize;

use crate::analyzer;
use crate::notation::{byte_to_utf16, utf16_to_byte};

/// 同義語辞書。ビルドに埋め込む（約 3MB）。
static RAW: &str = include_str!("../assets/synonyms.txt");

struct Store {
    /// グループ番号 → 提案してよい語の一覧（辞書の順）
    groups: HashMap<u32, Vec<String>>,
    /// 見出し → 属するグループ番号
    index: HashMap<String, Vec<u32>>,
}

static STORE: OnceCell<Store> = OnceCell::new();

fn store() -> &'static Store {
    STORE.get_or_init(|| {
        let mut groups: HashMap<u32, Vec<String>> = HashMap::new();
        let mut index: HashMap<String, Vec<u32>> = HashMap::new();
        for line in RAW.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let f: Vec<&str> = line.split(',').collect();
            if f.len() < 9 {
                continue;
            }
            let Ok(id) = f[0].parse::<u32>() else {
                continue;
            };
            let expand = f[2];
            let word = f[8];
            if word.is_empty() {
                continue;
            }
            // 誤表記などでも、引く側の入口としては使えるようにする
            index.entry(word.to_string()).or_default().push(id);
            // 提案する側には出さない
            if expand == "2" {
                continue;
            }
            let g = groups.entry(id).or_default();
            if !g.iter().any(|w| w == word) {
                g.push(word.to_string());
            }
        }
        Store { groups, index }
    })
}

/// 類義語の検索結果。
#[derive(Debug, Clone, Serialize)]
pub struct SynonymHit {
    /// 引いた語（選択がなければキャレット位置の語）
    pub word: String,
    /// その語が行のどこにあるか（UTF-16）。置き換えに使う
    pub start: u32,
    pub end: u32,
    /// 同義語グループごとの語の一覧。引いた語そのものは除く
    pub groups: Vec<Vec<String>>,
}

/// 行の中の位置（UTF-16 の範囲）から類義語を引く。
///
/// `start == end` ならキャレット位置。行を分かち書きして、その位置に
/// 掛かる語を探す。範囲があればその文字列を語として引く。
/// 見つからなければ None。
pub fn lookup(line: &str, start: u32, end: u32) -> Result<Option<SynonymHit>, String> {
    if line.is_empty() {
        return Ok(None);
    }
    let a = utf16_to_byte(line, start).ok_or("位置が本文からはみ出しています")?;
    let b = utf16_to_byte(line, end).ok_or("位置が本文からはみ出しています")?;

    let (word, w_start, w_end, mut ids, norm) = if a == b {
        // キャレット位置の語を探す
        match token_at(line, a)? {
            Some(t) => t,
            None => return Ok(None),
        }
    } else {
        let word = line[a..b].to_string();
        // 選択が 1 語なら、辞書のグループ番号と正規化形ももらう
        let (ids, norm) = describe(&word)?;
        (word, a, b, ids, norm)
    };

    // 見出しの完全一致でも引く（表層と正規化形の両方）
    let st = store();
    for key in [Some(word.as_str()), norm.as_deref()].into_iter().flatten() {
        if let Some(more) = st.index.get(key) {
            for &id in more {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }

    let mut groups: Vec<Vec<String>> = Vec::new();
    for id in ids {
        let Some(members) = st.groups.get(&id) else {
            continue;
        };
        let list: Vec<String> = members.iter().filter(|w| **w != word).cloned().collect();
        if !list.is_empty() {
            groups.push(list);
        }
        if groups.len() >= 8 {
            break;
        }
    }
    if groups.is_empty() {
        return Ok(None);
    }
    Ok(Some(SynonymHit {
        word,
        start: byte_to_utf16(line, w_start),
        end: byte_to_utf16(line, w_end),
        groups,
    }))
}

/// バイト位置に掛かる語（内容語）を分かち書きから探す。
#[allow(clippy::type_complexity)]
fn token_at(
    line: &str,
    at: usize,
) -> Result<Option<(String, usize, usize, Vec<u32>, Option<String>)>, String> {
    let seg = analyzer::segmenter()?;
    let mut tokens = seg
        .segment(std::borrow::Cow::Borrowed(line))
        .map_err(|e| format!("解析に失敗: {e}"))?;
    for t in tokens.iter_mut() {
        let (s, e) = (t.byte_start, t.byte_end);
        // キャレットは字と字のあいだに立つので、直後の語も拾う
        if !(s <= at && at <= e) {
            continue;
        }
        let d = t.details();
        let major = d.get(1).copied().unwrap_or("");
        if matches!(major, "助詞" | "助動詞" | "補助記号" | "空白" | "記号" | "") {
            continue;
        }
        let ids = parse_ids(d.get(14).copied().unwrap_or("*"));
        let norm = d
            .get(8)
            .filter(|n| **n != "*" && !n.is_empty())
            .map(|n| n.to_string());
        return Ok(Some((line[s..e].to_string(), s, e, ids, norm)));
    }
    Ok(None)
}

/// 語を単独で分かち書きして、グループ番号と正規化形を取る。
fn describe(word: &str) -> Result<(Vec<u32>, Option<String>), String> {
    let seg = analyzer::segmenter()?;
    let mut tokens = seg
        .segment(std::borrow::Cow::Borrowed(word))
        .map_err(|e| format!("解析に失敗: {e}"))?;
    let mut it = tokens.iter_mut();
    let Some(t) = it.next() else {
        return Ok((Vec::new(), None));
    };
    // 2 語以上に割れたら、辞書の情報は使わず見出しの一致だけに任せる
    if it.next().is_some() {
        return Ok((Vec::new(), None));
    }
    let d = t.details();
    let ids = parse_ids(d.get(14).copied().unwrap_or("*"));
    let norm = d
        .get(8)
        .filter(|n| **n != "*" && !n.is_empty())
        .map(|n| n.to_string());
    Ok((ids, norm))
}

/// `016008/019163` の形のグループ番号を読み取る。`*` は空。
fn parse_ids(s: &str) -> Vec<u32> {
    if s == "*" || s.is_empty() {
        return Vec::new();
    }
    s.split('/').filter_map(|p| p.parse::<u32>().ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同義語辞書が読める() {
        let st = store();
        assert!(!st.groups.is_empty());
        // 000001 のグループには「曖昧」の仲間が入っている
        let g = st.groups.get(&1).expect("グループ 000001 がない");
        assert!(g.iter().any(|w| w == "曖昧"), "{g:?}");
        assert!(g.iter().any(|w| w == "不明確"), "{g:?}");
    }

    #[test]
    fn 選択した語から類義語が引ける() {
        let hit = lookup("曖昧な言い方だ", 0, 2).unwrap().expect("引けない");
        assert_eq!(hit.word, "曖昧");
        assert!(hit.groups.iter().flatten().any(|w| w == "不明確"));
        // 引いた語そのものは提案に混ざらない
        assert!(hit.groups.iter().flatten().all(|w| w != "曖昧"));
    }

    #[test]
    fn キャレット位置の語が引ける() {
        // 「子ども」の中にキャレット（UTF-16 で 6 = 「子ど」のあと）
        let hit = lookup("小さな子どもがいた", 4, 4)
            .unwrap()
            .expect("引けない");
        assert_eq!(hit.word, "子ども");
        assert_eq!(hit.start, 3);
        assert_eq!(hit.end, 6);
        assert!(!hit.groups.is_empty());
    }

    #[test]
    fn 助詞では引かない() {
        // 「が」の上
        let got = lookup("犬がいる", 1, 1).unwrap();
        // 「が」は助詞なので飛ばし、直後の「いる」で引くか、何も返さない
        if let Some(hit) = got {
            assert_ne!(hit.word, "が");
        }
    }

    #[test]
    fn 見つからなければ_none() {
        assert!(lookup("ヴォグヌィルカ", 0, 7).unwrap().is_none());
    }
}
