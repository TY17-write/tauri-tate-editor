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
//!
//! Sudachi 同義語辞書は「厳密な言い換え」でグループが小さい。類語辞典
//! らしい広さは日本語 WordNet（assets/wnjpn-ok.tab、再配布可・
//! assets/wnja-LICENSE.txt を同梱）で足す。WordNet は語を概念
//! （synset）でまとめており、
//!   ・同じ概念の語 = 同義語
//!   ・上位・下位の概念や、形容詞の類似（sim）の語 = 近い意味の語
//! が引ける。概念のつながりは wnjpn.db から抜き出した
//! assets/wnjpn-links.tsv（hype = 上位、sim = 類似。日本語の語を持つ
//! 概念どうしに絞ってある）を使う。

use std::collections::HashMap;

use once_cell::sync::OnceCell;
use serde::Serialize;

use crate::analyzer;
use crate::notation::{byte_to_utf16, utf16_to_byte};

/// 同義語辞書。ビルドに埋め込む（約 3MB）。
static RAW: &str = include_str!("../assets/synonyms.txt");

/// 日本語 WordNet の語と概念の対応（約 4MB）。`概念\t語\t出所` の並び。
static WN_TAB: &str = include_str!("../assets/wnjpn-ok.tab");

/// 概念のつながり（約 1MB）。`種類\t概念1\t概念2` の並び。
/// hype は「概念1 の上位が 概念2」、sim は形容詞の類似。
static WN_LINKS: &str = include_str!("../assets/wnjpn-links.tsv");

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

/// 日本語 WordNet。概念（synset）は読み込み時に番号へ写す。
struct WordNet {
    /// 概念番号 → 語の一覧
    members: Vec<Vec<String>>,
    /// 語 → 属する概念番号
    by_word: HashMap<String, Vec<u32>>,
    /// 概念番号 → 上位の概念番号
    hype: HashMap<u32, Vec<u32>>,
    /// 概念番号 → 下位の概念番号（hype の逆引き）
    hypo: HashMap<u32, Vec<u32>>,
    /// 概念番号 → 類似の概念番号（形容詞）
    sim: HashMap<u32, Vec<u32>>,
}

static WORDNET: OnceCell<WordNet> = OnceCell::new();

fn wordnet() -> &'static WordNet {
    WORDNET.get_or_init(|| {
        let mut ids: HashMap<&str, u32> = HashMap::new();
        let mut members: Vec<Vec<String>> = Vec::new();
        let mut by_word: HashMap<String, Vec<u32>> = HashMap::new();
        let intern =
            |ids: &mut HashMap<&str, u32>, members: &mut Vec<Vec<String>>, synset: &'static str| {
                *ids.entry(synset).or_insert_with(|| {
                    members.push(Vec::new());
                    (members.len() - 1) as u32
                })
            };
        for line in WN_TAB.lines() {
            let mut f = line.split('\t');
            let (Some(synset), Some(word)) = (f.next(), f.next()) else {
                continue;
            };
            if word.is_empty() {
                continue;
            }
            let id = intern(&mut ids, &mut members, synset);
            let m = &mut members[id as usize];
            if !m.iter().any(|w| w == word) {
                m.push(word.to_string());
            }
            let list = by_word.entry(word.to_string()).or_default();
            if !list.contains(&id) {
                list.push(id);
            }
        }
        let mut hype: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut hypo: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut sim: HashMap<u32, Vec<u32>> = HashMap::new();
        for line in WN_LINKS.lines() {
            let mut f = line.split('\t');
            let (Some(kind), Some(a), Some(b)) = (f.next(), f.next(), f.next()) else {
                continue;
            };
            let (Some(&ia), Some(&ib)) = (ids.get(a), ids.get(b)) else {
                continue;
            };
            match kind {
                "hype" => {
                    hype.entry(ia).or_default().push(ib);
                    hypo.entry(ib).or_default().push(ia);
                }
                "sim" => sim.entry(ia).or_default().push(ib),
                _ => {}
            }
        }
        WordNet {
            members,
            by_word,
            hype,
            hypo,
            sim,
        }
    })
}

/// 類義語のひとかたまり。label は小窓の見出しに使う。
#[derive(Debug, Clone, Serialize)]
pub struct SynonymGroup {
    pub label: String,
    pub words: Vec<String>,
}

/// 類義語の検索結果。
#[derive(Debug, Clone, Serialize)]
pub struct SynonymHit {
    /// 引いた語（選択がなければキャレット位置の語）
    pub word: String,
    /// その語が行のどこにあるか（UTF-16）。置き換えに使う
    pub start: u32,
    pub end: u32,
    /// 種類ごとの語の一覧。引いた語そのものは除く
    pub groups: Vec<SynonymGroup>,
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

    // 一度出した語は他の段に重ねて出さない
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(word.clone());
    let take =
        |seen: &mut std::collections::HashSet<String>, src: &[String], cap: usize| -> Vec<String> {
            let mut out = Vec::new();
            for w in src {
                if out.len() >= cap {
                    break;
                }
                if seen.insert(w.clone()) {
                    out.push(w.clone());
                }
            }
            out
        };

    let mut groups: Vec<SynonymGroup> = Vec::new();

    // 1) Sudachi 同義語辞書 = 厳密な言い換え
    for id in ids.iter().take(4) {
        let Some(members) = st.groups.get(id) else {
            continue;
        };
        let list = take(&mut seen, members, 20);
        if !list.is_empty() {
            groups.push(SynonymGroup {
                label: "言い換え".into(),
                words: list,
            });
        }
    }

    // 2) WordNet の同じ概念の語 = 同義語。多義語は概念ごとに分かれる
    let wn = wordnet();
    let mut synsets: Vec<u32> = Vec::new();
    for key in [Some(word.as_str()), norm.as_deref()].into_iter().flatten() {
        if let Some(list) = wn.by_word.get(key) {
            for &id in list {
                if !synsets.contains(&id) {
                    synsets.push(id);
                }
            }
        }
    }
    for &id in synsets.iter().take(6) {
        let list = take(&mut seen, &wn.members[id as usize], 12);
        if !list.is_empty() {
            groups.push(SynonymGroup {
                label: "同義".into(),
                words: list,
            });
        }
    }

    // 3) 概念のつながりをたどった語 = 近い意味。
    //    上位（おおまかな語）・下位（細かな語）・類似をひとまとめに
    let mut near: Vec<String> = Vec::new();
    let push_members = |near: &mut Vec<String>, id: u32| {
        for w in &wn.members[id as usize] {
            if !near.iter().any(|x| x == w) {
                near.push(w.clone());
            }
        }
    };
    for &id in synsets.iter().take(4) {
        for map in [&wn.sim, &wn.hype, &wn.hypo] {
            for &n in map.get(&id).map(|v| v.as_slice()).unwrap_or(&[]) {
                push_members(&mut near, n);
            }
        }
    }
    let list = take(&mut seen, &near, 30);
    if !list.is_empty() {
        groups.push(SynonymGroup {
            label: "近い意味".into(),
            words: list,
        });
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

    fn all_words(hit: &SynonymHit) -> Vec<&String> {
        hit.groups.iter().flat_map(|g| g.words.iter()).collect()
    }

    #[test]
    fn 選択した語から類義語が引ける() {
        let hit = lookup("曖昧な言い方だ", 0, 2).unwrap().expect("引けない");
        assert_eq!(hit.word, "曖昧");
        assert!(all_words(&hit).iter().any(|w| *w == "不明確"));
        // 引いた語そのものは提案に混ざらない
        assert!(all_words(&hit).iter().all(|w| *w != "曖昧"));
        // 同じ語が別の段に重ねて出ない
        let words = all_words(&hit);
        let mut set = std::collections::HashSet::new();
        for w in &words {
            assert!(set.insert(*w), "重複: {w}");
        }
    }

    #[test]
    fn wordnet_で同義と近い意味が出る() {
        let hit = lookup("ゆっくり歩く", 4, 6).unwrap().expect("引けない");
        assert_eq!(hit.word, "歩く");
        let labels: Vec<&str> = hit.groups.iter().map(|g| g.label.as_str()).collect();
        assert!(labels.contains(&"同義"), "{labels:?}");
        assert!(labels.contains(&"近い意味"), "{labels:?}");
        // WordNet なら「歩む」あたりは同義に入っているはず
        assert!(
            all_words(&hit).iter().any(|w| *w == "歩む"),
            "{:?}",
            hit.groups
        );
    }

    #[test]
    fn 活用した語でも正規化形で引ける() {
        // 「歩い」（連用形）でも正規化形の「歩く」で WordNet が引ける
        let hit = lookup("とぼとぼ歩いた", 5, 5).unwrap().expect("引けない");
        assert_eq!(hit.word, "歩い");
        assert!(!hit.groups.is_empty());
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

    /// 候補を目で見るための補助。`cargo test 類義語を表示 -- --nocapture`
    #[test]
    fn 類義語を表示() {
        for (line, s, e) in [
            ("静かな夜", 0u32, 2u32),
            ("ゆっくり歩く", 4, 6),
            ("美しい str", 0, 3),
            ("悲しい話", 0, 3),
        ] {
            println!("── {}", &line);
            match lookup(line, s, e).unwrap() {
                None => println!("   （なし）"),
                Some(hit) => {
                    for g in &hit.groups {
                        println!("   [{}] {}", g.label, g.words.join("、"));
                    }
                }
            }
        }
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
