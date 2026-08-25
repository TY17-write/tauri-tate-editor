//! 文体の統計と、推敲のための指摘。
//!
//! 品詞マーカーと同じ Lindera の解析結果を使い回す。
//! 位置は段落内の UTF-16 オフセットで返す（フロントエンドが
//! そのまま Range を張れるようにするため）。

use serde::{Deserialize, Serialize};

use crate::analyzer::{Mark, PosTag};

/// 指摘の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueKind {
    /// 一文が長い
    LongSentence,
    /// 同じ文末が続いている
    RepeatedEnding,
    /// 同じ語が近くで繰り返されている
    NearbyRepeat,
    /// 特定の語を使いすぎている
    Overuse,
}

/// 指摘一件。
#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub kind: IssueKind,
    /// 何段落目か（0 始まり）
    pub para: usize,
    /// 段落内の UTF-16 オフセット
    pub start: u32,
    pub end: u32,
    /// 画面に出す文言
    pub message: String,
    /// 該当箇所の抜粋
    pub excerpt: String,
}

/// 品詞の割合。
#[derive(Debug, Clone, Default, Serialize)]
pub struct PosRatio {
    pub adverb: usize,
    pub adjective: usize,
    pub adjectival_noun: usize,
    pub adnominal: usize,
}

/// 文体の報告。
#[derive(Debug, Clone, Default, Serialize)]
pub struct StyleReport {
    /// 本文の文字数（見出し行を除く）
    pub chars: usize,
    /// 文の数
    pub sentences: usize,
    /// 一文の平均の長さ
    pub avg_sentence: f64,
    /// もっとも長い文の長さ
    pub max_sentence: usize,
    pub pos: PosRatio,
    /// 会話文（かぎ括弧で始まる段落）の割合
    pub dialogue_ratio: f64,
    pub issues: Vec<Issue>,
}

/// 判定の閾値。
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct StyleOptions {
    /// これを超える文を「長い」とみなす（字）
    pub long_sentence: usize,
    /// 同じ文末がこの数だけ並んだら指摘する
    pub repeat_endings: usize,
    /// 同じ語の繰り返しを見る幅（字）
    pub nearby_window: usize,
    /// 使いすぎを数える語
    pub overuse_words: Vec<String>,
    /// 本文 1000 字あたり何回でて来たら指摘するか
    pub overuse_per_1000: f64,
}

impl Default for StyleOptions {
    fn default() -> Self {
        Self {
            // 小説の一文は長くなりがちなので、明らかに読みにくい水準に置く
            long_sentence: 200,
            repeat_endings: 3,
            nearby_window: 60,
            // 小説の推敲でよく槍玉に挙がる語
            overuse_words: [
                "思う",
                "思った",
                "感じる",
                "ような",
                "そう",
                "という",
                "こと",
                "もの",
                "とても",
                "少し",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            overuse_per_1000: 4.0,
        }
    }
}

/// 見出し行かどうか。全角・半角の井桁で始まる行。
fn is_heading(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('#') || t.starts_with('＃')
}

/// 会話文の段落かどうか。かぎ括弧で始まるもの。
fn is_dialogue(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('「') || t.starts_with('『')
}

/// 段落を文に切る。返すのは文字単位の範囲。
///
/// 句点・感嘆符・疑問符で切り、直後に続く閉じ括弧はその文に含める。
fn split_sentences(text: &str) -> Vec<(usize, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if c == '。' || c == '！' || c == '？' {
            let mut end = i + 1;
            // 「そうか。」のように閉じ括弧が続くならそこまでを一文にする
            while end < chars.len() && matches!(chars[end], '」' | '』' | '）' | ')') {
                end += 1;
            }
            if end > start {
                out.push((start, end));
            }
            start = end;
            i = end;
            continue;
        }
        i += 1;
    }
    if start < chars.len() {
        out.push((start, chars.len()));
    }
    out
}

/// 文の末尾表現を取り出す。文末の連続を見るのに使う。
///
/// 句点と閉じ括弧を落とし、残りの末尾 2 文字を返す。
fn ending_of(sentence: &str) -> String {
    let trimmed: Vec<char> = sentence
        .chars()
        .rev()
        .skip_while(|c| matches!(c, '。' | '！' | '？' | '」' | '』' | '）' | ')'))
        .collect();
    trimmed.iter().take(2).rev().collect()
}

/// 文字単位の位置を UTF-16 単位に直す。
fn char_to_utf16(text: &str, char_idx: usize) -> u32 {
    text.chars()
        .take(char_idx)
        .map(|c| c.len_utf16() as u32)
        .sum()
}

/// 抜粋を作る。長い場合は省略する。
fn excerpt(s: &str, limit: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= limit {
        return s.to_string();
    }
    let head: String = chars.iter().take(limit).collect();
    format!("{head}…")
}

/// 一段落ぶんの入力。
pub struct ParaInput<'a> {
    pub text: &'a str,
    pub marks: &'a [Mark],
}

/// 本文全体を調べて報告を作る。
pub fn analyze(paras: &[ParaInput<'_>], opts: &StyleOptions) -> StyleReport {
    let mut report = StyleReport::default();
    let mut issues = Vec::new();

    let mut body_paras = 0usize;
    let mut dialogue_paras = 0usize;
    let mut total_sentence_chars = 0usize;

    // 文末の連続を見るために、段落をまたいで文をたどる
    let mut prev_ending: Option<String> = None;
    let mut run_len = 0usize;
    let mut run_start: Option<(usize, u32, u32)> = None; // (段落, 開始, 終了)

    for (pi, para) in paras.iter().enumerate() {
        if is_heading(para.text) {
            continue;
        }
        let chars: Vec<char> = para.text.chars().collect();
        report.chars += chars.len();
        if !para.text.trim().is_empty() {
            body_paras += 1;
            if is_dialogue(para.text) {
                dialogue_paras += 1;
            }
        }

        for m in para.marks {
            match m.pos {
                PosTag::Adverb => report.pos.adverb += 1,
                PosTag::Adjective => report.pos.adjective += 1,
                PosTag::AdjectivalNoun => report.pos.adjectival_noun += 1,
                PosTag::Adnominal => report.pos.adnominal += 1,
            }
        }

        for (s, e) in split_sentences(para.text) {
            let sentence: String = chars[s..e].iter().collect();
            if sentence.trim().is_empty() {
                continue;
            }
            let len = e - s;
            report.sentences += 1;
            total_sentence_chars += len;
            report.max_sentence = report.max_sentence.max(len);

            let u_start = char_to_utf16(para.text, s);
            let u_end = char_to_utf16(para.text, e);

            if len > opts.long_sentence {
                issues.push(Issue {
                    kind: IssueKind::LongSentence,
                    para: pi,
                    start: u_start,
                    end: u_end,
                    message: format!("一文が {len} 字あります"),
                    excerpt: excerpt(&sentence, 30),
                });
            }

            // 文末の連続
            let ending = ending_of(&sentence);
            if ending.is_empty() {
                prev_ending = None;
                run_len = 0;
                run_start = None;
            } else if prev_ending.as_deref() == Some(ending.as_str()) {
                run_len += 1;
                if run_len + 1 == opts.repeat_endings {
                    // ちょうど閾値に達したところで一件だけ出す
                    let (p0, s0, _) = run_start.unwrap_or((pi, u_start, u_end));
                    issues.push(Issue {
                        kind: IssueKind::RepeatedEnding,
                        para: p0,
                        start: s0,
                        end: u_end.max(s0 + 1),
                        message: format!("「{ending}」で終わる文が {} つ続いています", run_len + 1),
                        excerpt: excerpt(&sentence, 24),
                    });
                }
            } else {
                prev_ending = Some(ending);
                run_len = 0;
                run_start = Some((pi, u_start, u_end));
            }
        }

        // 同じ語の近接反復。マーカー対象の語（副詞・形容詞など）だけを見る
        detect_nearby_repeat(pi, para, opts, &mut issues);
    }

    // 使いすぎ
    detect_overuse(paras, opts, report.chars, &mut issues);

    report.avg_sentence = if report.sentences > 0 {
        total_sentence_chars as f64 / report.sentences as f64
    } else {
        0.0
    };
    report.dialogue_ratio = if body_paras > 0 {
        dialogue_paras as f64 / body_paras as f64
    } else {
        0.0
    };
    report.issues = issues;
    report
}

/// 同じ語が近くで繰り返されていないか。
fn detect_nearby_repeat(
    pi: usize,
    para: &ParaInput<'_>,
    opts: &StyleOptions,
    issues: &mut Vec<Issue>,
) {
    let utf16: Vec<u16> = para.text.encode_utf16().collect();
    let mut seen: Vec<(String, u32)> = Vec::new();

    for m in para.marks {
        if m.end as usize > utf16.len() || m.start >= m.end {
            continue;
        }
        let word = String::from_utf16_lossy(&utf16[m.start as usize..m.end as usize]);
        if word.chars().count() < 2 {
            continue; // 一字の語は偶然が多いので見ない
        }
        if let Some((_, prev)) = seen
            .iter()
            .rev()
            .find(|(w, p)| w == &word && m.start.saturating_sub(*p) as usize <= opts.nearby_window)
        {
            issues.push(Issue {
                kind: IssueKind::NearbyRepeat,
                para: pi,
                start: m.start,
                end: m.end,
                message: format!(
                    "「{word}」が {} 字のあいだに繰り返されています",
                    m.start - prev
                ),
                excerpt: word.clone(),
            });
        }
        seen.push((word, m.start));
    }
}

/// 決まった語を使いすぎていないか。
fn detect_overuse(
    paras: &[ParaInput<'_>],
    opts: &StyleOptions,
    total_chars: usize,
    issues: &mut Vec<Issue>,
) {
    if total_chars == 0 {
        return;
    }
    for word in &opts.overuse_words {
        if word.is_empty() {
            continue;
        }
        let mut hits: Vec<(usize, u32, u32)> = Vec::new();
        for (pi, para) in paras.iter().enumerate() {
            if is_heading(para.text) {
                continue;
            }
            let mut from = 0usize;
            while let Some(rel) = para.text[from..].find(word.as_str()) {
                let byte = from + rel;
                let start = para.text[..byte].encode_utf16().count() as u32;
                let end = start + word.encode_utf16().count() as u32;
                hits.push((pi, start, end));
                from = byte + word.len();
            }
        }
        let per_1000 = hits.len() as f64 * 1000.0 / total_chars as f64;
        if per_1000 >= opts.overuse_per_1000 && hits.len() >= 3 {
            let (pi, s, e) = hits[0];
            issues.push(Issue {
                kind: IssueKind::Overuse,
                para: pi,
                start: s,
                end: e,
                message: format!(
                    "「{word}」が {} 回（千字あたり {:.1} 回）出てきます",
                    hits.len(),
                    per_1000
                ),
                excerpt: word.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(text: &'a str, marks: &'a [Mark]) -> ParaInput<'a> {
        ParaInput { text, marks }
    }

    #[test]
    fn 文に切れる() {
        let s = "短い文。長めの文だった。「会話です。」そして続く";
        let got: Vec<String> = split_sentences(s)
            .into_iter()
            .map(|(a, b)| s.chars().skip(a).take(b - a).collect())
            .collect();
        assert_eq!(
            got,
            vec![
                "短い文。",
                "長めの文だった。",
                "「会話です。」",
                "そして続く"
            ]
        );
    }

    #[test]
    fn 文末表現を取り出す() {
        assert_eq!(ending_of("そこにいた。"), "いた");
        assert_eq!(ending_of("「そうですね」"), "すね");
        assert_eq!(ending_of("走る！"), "走る");
    }

    #[test]
    fn 長い文を指摘する() {
        let long = "あ".repeat(220) + "。";
        let paras = vec![input(&long, &[])];
        let r = analyze(&paras, &StyleOptions::default());
        assert_eq!(r.sentences, 1);
        assert!(r.issues.iter().any(|i| i.kind == IssueKind::LongSentence));
    }

    #[test]
    fn 既定では二百字までは長いと言わない() {
        let ok = "あ".repeat(190) + "。";
        let paras = vec![input(&ok, &[])];
        let r = analyze(&paras, &StyleOptions::default());
        assert!(!r.issues.iter().any(|i| i.kind == IssueKind::LongSentence));
    }

    #[test]
    fn しきい値を変えられる() {
        let text = "あ".repeat(80) + "。";
        let paras = vec![input(&text, &[])];

        let opts = StyleOptions {
            long_sentence: 50,
            ..StyleOptions::default()
        };
        assert!(analyze(&paras, &opts)
            .issues
            .iter()
            .any(|i| i.kind == IssueKind::LongSentence));

        let opts = StyleOptions {
            long_sentence: 100,
            ..StyleOptions::default()
        };
        assert!(!analyze(&paras, &opts)
            .issues
            .iter()
            .any(|i| i.kind == IssueKind::LongSentence));
    }

    #[test]
    fn 文末の連続を指摘する() {
        let text = "そこにいた。彼もいた。犬もいた。";
        let paras = vec![input(text, &[])];
        let r = analyze(&paras, &StyleOptions::default());
        let hit = r
            .issues
            .iter()
            .find(|i| i.kind == IssueKind::RepeatedEnding)
            .expect("文末の連続が拾えていない");
        assert!(hit.message.contains("いた"));
    }

    #[test]
    fn 連続していなければ指摘しない() {
        let text = "そこにいた。彼が走る。犬が鳴いた。";
        let paras = vec![input(text, &[])];
        let r = analyze(&paras, &StyleOptions::default());
        assert!(!r.issues.iter().any(|i| i.kind == IssueKind::RepeatedEnding));
    }

    #[test]
    fn 見出し行は分量に数えない() {
        let paras = vec![input("＃第一章", &[]), input("本文です。", &[])];
        let r = analyze(&paras, &StyleOptions::default());
        assert_eq!(r.chars, "本文です。".chars().count());
    }

    #[test]
    fn 会話の割合を出す() {
        let paras = vec![
            input("「こんにちは」", &[]),
            input("地の文である。", &[]),
            input("「またね」", &[]),
            input("また地の文。", &[]),
        ];
        let r = analyze(&paras, &StyleOptions::default());
        assert!((r.dialogue_ratio - 0.5).abs() < 1e-6);
    }

    #[test]
    fn 使いすぎを指摘する() {
        // 短い本文に「思う」を集中させる
        let text = "思う。思う。思う。思う。";
        let paras = vec![input(text, &[])];
        let r = analyze(&paras, &StyleOptions::default());
        let hit = r
            .issues
            .iter()
            .find(|i| i.kind == IssueKind::Overuse)
            .expect("使いすぎが拾えていない");
        assert!(hit.message.contains("思う"));
    }

    /// 実際の本文で何が指摘されるかを目で見る。
    /// `cargo test 実際の本文で試す -- --nocapture`
    #[test]
    fn 実際の本文で試す() {
        let lines = [
            "＃第一章　雪の夜",
            "",
            "　夜半の風が硝子戸を鳴らしていた。まだ午前二時、原稿はわずか十二枚しか進んでいない。",
            "　わたしはふと顔を上げた。しばらくのあいだ、その音に耳を澄ませていた。とても静かな夜だった。ずいぶん長く、同じ行を書いては消していたように思う。",
            "　「まだ起きていたのか」",
            "　背後で声がした。振り返ると、兄が立っている。ずいぶん久しぶりに見る顔だった……ように思えたが、実際には昨日も会っている。",
            "　わたしはそう答えて、机の上の原稿用紙を裏返した。まだ誰にも見せたくなかった。",
            "　やがて雪は激しくなり、庭木の輪郭を静かに消していった。とても長い夜だ――と、わたしは思った。",
        ];
        let paras: Vec<ParaInput<'_>> = lines.iter().map(|l| input(l, &[])).collect();
        let r = analyze(&paras, &StyleOptions::default());

        println!(
            "本文 {} 字 / {} 文 / 平均 {:.1} 字 / 最長 {} 字",
            r.chars, r.sentences, r.avg_sentence, r.max_sentence
        );
        println!("会話の割合 {:.0}%", r.dialogue_ratio * 100.0);
        println!("指摘 {} 件", r.issues.len());
        for i in &r.issues {
            println!("  [{:?}] {} … {}", i.kind, i.message, i.excerpt);
        }
    }

    #[test]
    fn 近接した繰り返しを指摘する() {
        let text = "とても静かで、とても長い夜";
        let marks = vec![
            Mark {
                start: 0,
                end: 3,
                pos: PosTag::Adverb,
            },
            Mark {
                start: 7,
                end: 10,
                pos: PosTag::Adverb,
            },
        ];
        let paras = vec![input(text, &marks)];
        let r = analyze(&paras, &StyleOptions::default());
        assert!(r.issues.iter().any(|i| i.kind == IssueKind::NearbyRepeat));
    }
}
