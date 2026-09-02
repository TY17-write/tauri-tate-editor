//! ルビと傍点の記法。投稿先ごとに書き方が違うので相互に変換する。
//!
//! 各記法の仕様はここに集約してある。実際の投稿サイトの仕様と
//! 食い違っていたら、この表を直せば全体に反映される。
//!
//! | 記法 | ルビ | 傍点 |
//! |---|---|---|
//! | 小説家になろう | `|漢字《かんじ》` / `漢字《かんじ》` | `|文字《・・》`（ルビで代用） |
//! | カクヨム | `|漢字《かんじ》` / `漢字《かんじ》` | `《《文字》》` |
//! | 青空文庫 | `｜漢字《かんじ》` / `漢字《かんじ》` | `［＃「文字」に傍点］` |
//! | pixiv | `[[rb:漢字 > かんじ]]` | `[[rb:文字 > ・・]]`（ルビで代用） |
//!
//! 傍点の書き方がない記法では、親文字と同じ字数の中黒をルビとして
//! 振る。読み取りでもこの形を傍点として受けるので、記法を移しても
//! 傍点が消えない。
//!
//! 「漢字の直後に《》」の形は、縦棒を省いても漢字列がルビの親になる
//! という書き方。読み込みでは受けるが、書き出しでは常に縦棒を付ける
//! （どこからルビが始まるかが曖昧にならないようにするため）。

use std::ops::Range;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// 対応する記法。
///
/// 画面に出す名前と、傍点を書けるかどうかは画面側（`notation.ts` の
/// `NOTATIONS`）が持っている。両方に置くと食い違いのもとになるので、
/// ここでは種類の区別だけを扱う。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Notation {
    /// 小説家になろう
    Narou,
    /// カクヨム
    Kakuyomu,
    /// 青空文庫
    Aozora,
    /// pixiv
    Pixiv,
}

/// 本文を分解したもの。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Text(String),
    /// ルビ。base に親文字、ruby に読み
    Ruby {
        base: String,
        ruby: String,
    },
    /// 傍点
    Emphasis(String),
}

/* ============================================================
記法ごとの読み取り
============================================================ */

/// 縦棒つきのルビ。半角 `|` と全角 `｜` の両方を受ける。
static RE_BAR_RUBY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[|｜]([^《》\n]+)《([^《》\n]+)》").unwrap());

/// 縦棒なしのルビ。直前の漢字列を親文字とみなす。
static RE_KANJI_RUBY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"([\p{Han}々〆ヵヶ]+)《([^《》\n]+)》").unwrap());

/// カクヨムの傍点。
static RE_KAKUYOMU_EMPHASIS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"《《([^《》\n]+)》》").unwrap());

/// 青空文庫の傍点注記。
static RE_AOZORA_EMPHASIS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"［＃「([^」\n]+)」に傍点］").unwrap());

/// pixiv のルビ。
static RE_PIXIV_RUBY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[\[rb:\s*([^>\]\n]+?)\s*>\s*([^\]\n]+?)\s*\]\]").unwrap());

/// 傍点の代わりに振る中黒。書き出しでは `・` を使い、
/// 読み取りではゴマ点も受ける。
const DOT_MARKS: [char; 3] = ['・', '\u{fe45}', '\u{fe46}'];

/// そのルビが「傍点の代用」か。
///
/// 親文字と同じ字数の中黒だけが振られていれば、ルビではなく傍点の
/// つもりで書かれたものとみなす。なろうと pixiv には傍点の書き方が
/// ないので、この形が使われる。
fn is_dot_ruby(base: &str, ruby: &str) -> bool {
    !ruby.is_empty()
        && ruby.chars().all(|c| DOT_MARKS.contains(&c))
        && ruby.chars().count() == base.chars().count()
}

/// 行頭の見出し記号。半角 `#` と全角 `＃` の両方を受ける。
/// 画面側の `outline.ts` が使う規則と揃えてある。
static RE_HEADING: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[#＃]{1,6}").unwrap());

/// 行頭の見出し記号と、それを取り除いた残りに分ける。
///
/// 記号の後ろの空白はそのまま残す。プレビューでは記号だけを
/// 見えなくするので、後ろの空白は書いた人が置いた字下げとして扱う。
fn split_heading(line: &str) -> (Option<&str>, &str) {
    match RE_HEADING.find(line) {
        Some(m) => (Some(&line[..m.end()]), &line[m.end()..]),
        None => (None, line),
    }
}

/// 分解した一片と、それが元の行のどこにあったか（バイト範囲）。
///
/// プレビューは「元の記法をそのまま」持ち回る必要がある。組み立て
/// 直した文字列を使うと、縦棒を省いたルビ（`漢字《かんじ》`）が
/// `|漢字《かんじ》` に化けるなど、本文が勝手に書き換わってしまう。
#[derive(Debug, Clone)]
struct Span {
    range: Range<usize>,
    node: Node,
}

/// 一行を分解する。
pub fn parse_line(line: &str, from: Notation) -> Vec<Node> {
    parse_spans(line, from)
        .into_iter()
        .map(|s| s.node)
        .collect()
}

/// 一行を、元の行での位置つきで分解する。
fn parse_spans(line: &str, from: Notation) -> Vec<Span> {
    // 傍点を先に取り出す。《《…》》 はルビの《》と重なるので順番が要る
    let mut items = vec![Span {
        range: 0..line.len(),
        node: Node::Text(line.to_string()),
    }];

    match from {
        Notation::Kakuyomu => {
            items = split_spans(line, &items, &RE_KAKUYOMU_EMPHASIS, |c| {
                Node::Emphasis(c[1].to_string())
            });
        }
        Notation::Aozora => {
            items = split_aozora_emphasis(line, &items);
        }
        _ => {}
    }

    if from == Notation::Pixiv {
        items = split_spans(line, &items, &RE_PIXIV_RUBY, |c| Node::Ruby {
            base: c[1].to_string(),
            ruby: c[2].to_string(),
        });
    } else {
        items = split_spans(line, &items, &RE_BAR_RUBY, |c| Node::Ruby {
            base: c[1].to_string(),
            ruby: c[2].to_string(),
        });
        items = split_spans(line, &items, &RE_KANJI_RUBY, |c| Node::Ruby {
            base: c[1].to_string(),
            ruby: c[2].to_string(),
        });
    }

    // 傍点の書き方がない記法では、中黒を振ったルビが傍点の代用。
    // ルビとして読んだあとに読み替える。本来の傍点の書き方がある
    // 記法では、そちらで書かれているはずなので触らない。
    if matches!(from, Notation::Narou | Notation::Pixiv) {
        for item in &mut items {
            if let Node::Ruby { base, ruby } = &item.node {
                if is_dot_ruby(base, ruby) {
                    item.node = Node::Emphasis(base.clone());
                }
            }
        }
    }

    items.retain(|s| !matches!(&s.node, Node::Text(t) if t.is_empty()));
    items
}

/// 元の行の一部を、テキストの一片にする。
fn text_span(line: &str, range: Range<usize>) -> Span {
    Span {
        node: Node::Text(line[range.clone()].to_string()),
        range,
    }
}

/// テキストの一片だけを正規表現で切り分けていく。
fn split_spans<F>(line: &str, items: &[Span], re: &Regex, make: F) -> Vec<Span>
where
    F: Fn(&regex::Captures<'_>) -> Node,
{
    let mut out = Vec::new();
    for item in items {
        if !matches!(item.node, Node::Text(_)) {
            out.push(item.clone());
            continue;
        }
        let base = item.range.start;
        let text = &line[item.range.clone()];
        let mut last = 0usize;
        for c in re.captures_iter(text) {
            let m = c.get(0).unwrap();
            if m.start() > last {
                out.push(text_span(line, base + last..base + m.start()));
            }
            out.push(Span {
                range: base + m.start()..base + m.end(),
                node: make(&c),
            });
            last = m.end();
        }
        if last < text.len() {
            out.push(text_span(line, base + last..base + text.len()));
        }
    }
    out
}

/// 青空文庫の傍点注記を読む。
///
/// `絶対に［＃「絶対に」に傍点］` は「注記の直前にある同じ文字列に
/// 傍点を振る」という書き方。注記だけを傍点にすると、親文字が本文に
/// 残ったまま傍点も出て二重になる。直前の文字列ごと 1 つの傍点にする。
///
/// 直前が注記の指す文字列と違うときは、どこに掛かるのか決められない。
/// 勝手に解釈せず、注記をそのまま文字として残す。
fn split_aozora_emphasis(line: &str, items: &[Span]) -> Vec<Span> {
    let mut out = Vec::new();
    for item in items {
        if !matches!(item.node, Node::Text(_)) {
            out.push(item.clone());
            continue;
        }
        let base = item.range.start;
        let text = &line[item.range.clone()];
        let mut last = 0usize;
        for c in RE_AOZORA_EMPHASIS.captures_iter(text) {
            let m = c.get(0).unwrap();
            let word = &c[1];
            let before = &text[last..m.start()];
            match before.strip_suffix(word) {
                Some(head) => {
                    if !head.is_empty() {
                        out.push(text_span(line, base + last..base + last + head.len()));
                    }
                    out.push(Span {
                        range: base + last + head.len()..base + m.end(),
                        node: Node::Emphasis(word.to_string()),
                    });
                }
                None => out.push(text_span(line, base + last..base + m.end())),
            }
            last = m.end();
        }
        if last < text.len() {
            out.push(text_span(line, base + last..base + text.len()));
        }
    }
    out
}

/* ============================================================
記法ごとの書き出し
============================================================ */

/// 記法ごとの書き方の型紙。`{0}` `{1}` `{.}` が差し込み口。
///
/// ルビは `{0}` が親文字、`{1}` が読み。傍点は `{0}` が文字で、
/// `{.}` は「`{0}` と同じ字数の中黒」に開く。傍点の書き方がない
/// 記法で、ルビによる代用を型紙のまま表せるようにするため。
///
/// 画面側もプレビューでルビや傍点を直したときにこの型紙を使うので、
/// 書き方の定義はここ一箇所だけに置く。
#[derive(Debug, Clone, Serialize)]
pub struct NotationForms {
    pub ruby: String,
    pub emphasis: String,
}

/// その記法の書き方。
pub fn forms(n: Notation) -> NotationForms {
    let (ruby, emphasis) = match n {
        Notation::Narou => ("|{0}《{1}》", "|{0}《{.}》"),
        Notation::Kakuyomu => ("|{0}《{1}》", "《《{0}》》"),
        Notation::Aozora => ("｜{0}《{1}》", "{0}［＃「{0}」に傍点］"),
        Notation::Pixiv => ("[[rb:{0} > {1}]]", "[[rb:{0} > {.}]]"),
    };
    NotationForms {
        ruby: ruby.to_string(),
        emphasis: emphasis.to_string(),
    }
}

/// 型紙に文字を差し込む。差し込み口でない中かっこはそのまま残す。
fn fill(form: &str, a: &str, b: &str) -> String {
    let mut out = String::with_capacity(form.len() + a.len() + b.len());
    let mut rest = form;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if let Some(r) = tail.strip_prefix("{0}") {
            out.push_str(a);
            rest = r;
        } else if let Some(r) = tail.strip_prefix("{1}") {
            out.push_str(b);
            rest = r;
        } else if let Some(r) = tail.strip_prefix("{.}") {
            for _ in a.chars() {
                out.push(DOT_MARKS[0]);
            }
            rest = r;
        } else {
            out.push('{');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

/// 分解したものを、指定の記法の文字列に戻す。
pub fn render_line(nodes: &[Node], to: Notation) -> String {
    let f = forms(to);
    let mut out = String::new();
    for node in nodes {
        match node {
            Node::Text(t) => out.push_str(t),
            Node::Ruby { base, ruby } => out.push_str(&fill(&f.ruby, base, ruby)),
            Node::Emphasis(t) => out.push_str(&fill(&f.emphasis, t, t)),
        }
    }
    out
}

/// 一行を別の記法に直す。
pub fn convert_line(line: &str, from: Notation, to: Notation) -> String {
    if from == to {
        return line.to_string();
    }
    render_line(&parse_line(line, from), to)
}

/// 本文全体を別の記法に直す。
pub fn convert(text: &str, from: Notation, to: Notation) -> String {
    if from == to {
        return text.to_string();
    }
    text.split('\n')
        .map(|l| convert_line(l, from, to))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 本文にルビや傍点がいくつあるか。記法を変える前の確認に使う。
#[derive(Debug, Clone, Default, Serialize)]
pub struct NotationCount {
    pub ruby: usize,
    pub emphasis: usize,
}

pub fn count(text: &str, notation: Notation) -> NotationCount {
    let mut c = NotationCount::default();
    for line in text.split('\n') {
        for node in parse_line(line, notation) {
            match node {
                Node::Ruby { .. } => c.ruby += 1,
                Node::Emphasis(_) => c.emphasis += 1,
                Node::Text(_) => {}
            }
        }
    }
    c
}

/* ============================================================
表示用
============================================================ */

/// プレビュー用に組み立てた一行。
///
/// ルビや傍点は「編集できない塊」として置き、元の記法を持たせておく。
/// フロントエンドはこれを DOM にして、記法テキストへ戻すときに
/// `src` を読む。
#[derive(Debug, Clone, Serialize)]
pub struct Piece {
    /// "text" | "ruby" | "emphasis" | "heading"
    pub kind: &'static str,
    /// 画面に出す文字（ルビなら親文字）
    pub text: String,
    /// ルビの読み
    pub ruby: String,
    /// 元の行から切り出した記法そのもの。繋ぎ直すと元の行に戻る
    pub src: String,
}

/// 一行をプレビュー用の部品に分ける。
///
/// 行頭の見出し記号は独立した部品にする。プレビューでは記号を
/// 見えなくするが、`src` に残しておけば記法テキストへ戻せる。
pub fn pieces(line: &str, notation: Notation) -> Vec<Piece> {
    let (heading, body) = split_heading(line);
    let mut out = Vec::new();
    if let Some(mark) = heading {
        out.push(Piece {
            kind: "heading",
            text: mark.to_string(),
            ruby: String::new(),
            src: mark.to_string(),
        });
    }

    for item in parse_spans(body, notation) {
        // src は元の行から切り出す。組み立て直してはいけない。
        // 縦棒を省いたルビや、空白の入っていない pixiv 記法が
        // 書き換わって、画面と本文が食い違う
        let src = body[item.range.clone()].to_string();
        out.push(match item.node {
            Node::Text(t) => Piece {
                kind: "text",
                text: t,
                ruby: String::new(),
                src,
            },
            Node::Ruby { base, ruby } => Piece {
                kind: "ruby",
                text: base,
                ruby,
                src,
            },
            Node::Emphasis(t) => Piece {
                kind: "emphasis",
                text: t,
                ruby: String::new(),
                src,
            },
        });
    }
    out
}

/* ============================================================
傍点の付け外し
============================================================ */

/// 傍点を付け外ししたあとの行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EmphasisEdit {
    /// 直したあとの行
    pub text: String,
    /// 付け外しした範囲（直したあとの行での UTF-16 位置）
    pub start: u32,
    pub end: u32,
}

/// 行の `[start, end)` に傍点を付ける、または外す。
///
/// 範囲がすでにある傍点に掛かっていれば外し、掛かっていなければ付ける。
/// ルビや見出し記号に掛かる範囲には付けられない（記法で表せない）ので
/// `None` を返す。位置は UTF-16 で数える（マーカーと同じ数え方）。
pub fn toggle_emphasis(line: &str, start: u32, end: u32, n: Notation) -> Option<EmphasisEdit> {
    let a = utf16_to_byte(line, start)?;
    let b = utf16_to_byte(line, end)?;
    if a >= b {
        return None;
    }

    let spans = parse_spans(line, n);
    let hit = |s: &Span| s.range.start < b && s.range.end > a;
    if !spans.iter().any(hit) {
        return None;
    }

    // 掛かっている傍点があれば外す。付けるより外すを先に見るのは、
    // 傍点の上でもう一度押したときに二重に掛からないようにするため。
    if spans
        .iter()
        .any(|s| hit(s) && matches!(s.node, Node::Emphasis(_)))
    {
        let mut out = String::with_capacity(line.len());
        let mut from = 0usize;
        let mut to = 0usize;
        let mut started = false;
        for s in &spans {
            match &s.node {
                Node::Emphasis(t) if hit(s) => {
                    if !started {
                        from = out.len();
                        started = true;
                    }
                    out.push_str(t);
                    to = out.len();
                }
                // 掛かっていないところは元の記法をそのまま写す
                _ => out.push_str(&line[s.range.clone()]),
            }
        }
        return Some(EmphasisEdit {
            start: byte_to_utf16(&out, from),
            end: byte_to_utf16(&out, to),
            text: out,
        });
    }

    // 付ける。ルビや見出し記号は途中で切れないので、掛かっていたら諦める
    if spans
        .iter()
        .any(|s| hit(s) && !matches!(s.node, Node::Text(_)))
    {
        return None;
    }

    let wrapped = fill(&forms(n).emphasis, &line[a..b], &line[a..b]);
    let out = format!("{}{}{}", &line[..a], wrapped, &line[b..]);
    Some(EmphasisEdit {
        start: byte_to_utf16(&out, a),
        end: byte_to_utf16(&out, a + wrapped.len()),
        text: out,
    })
}

/// UTF-16 の位置をバイト位置に直す。文字の途中を指していたら None。
pub(crate) fn utf16_to_byte(s: &str, target: u32) -> Option<usize> {
    let mut u = 0u32;
    for (i, ch) in s.char_indices() {
        if u == target {
            return Some(i);
        }
        u += ch.len_utf16() as u32;
    }
    (u == target).then_some(s.len())
}

/// バイト位置を UTF-16 の位置に直す。
pub(crate) fn byte_to_utf16(s: &str, byte: usize) -> u32 {
    s[..byte].encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 縦棒つきのルビを読む() {
        let nodes = parse_line("彼は|硝子戸《ガラスど》を見た", Notation::Narou);
        assert_eq!(
            nodes,
            vec![
                Node::Text("彼は".into()),
                Node::Ruby {
                    base: "硝子戸".into(),
                    ruby: "ガラスど".into()
                },
                Node::Text("を見た".into()),
            ]
        );
    }

    #[test]
    fn 全角縦棒も受ける() {
        let nodes = parse_line("｜硝子戸《ガラスど》", Notation::Aozora);
        assert_eq!(
            nodes,
            vec![Node::Ruby {
                base: "硝子戸".into(),
                ruby: "ガラスど".into()
            }]
        );
    }

    #[test]
    fn 縦棒なしでも漢字の直後ならルビになる() {
        let nodes = parse_line("彼は硝子戸《ガラスど》を見た", Notation::Narou);
        assert_eq!(
            nodes,
            vec![
                Node::Text("彼は".into()),
                Node::Ruby {
                    base: "硝子戸".into(),
                    ruby: "ガラスど".into()
                },
                Node::Text("を見た".into()),
            ]
        );
    }

    #[test]
    fn カクヨムの傍点を読む() {
        let nodes = parse_line("それは《《絶対に》》違う", Notation::Kakuyomu);
        assert_eq!(
            nodes,
            vec![
                Node::Text("それは".into()),
                Node::Emphasis("絶対に".into()),
                Node::Text("違う".into()),
            ]
        );
    }

    #[test]
    fn 青空文庫の傍点を読む() {
        let nodes = parse_line("絶対に［＃「絶対に」に傍点］違う", Notation::Aozora);
        assert!(nodes.contains(&Node::Emphasis("絶対に".into())));
    }

    #[test]
    fn pixiv_のルビを読む() {
        let nodes = parse_line("[[rb:硝子戸 > ガラスど]]", Notation::Pixiv);
        assert_eq!(
            nodes,
            vec![Node::Ruby {
                base: "硝子戸".into(),
                ruby: "ガラスど".into()
            }]
        );
    }

    #[test]
    fn なろうからカクヨムへ変える() {
        let got = convert(
            "|硝子戸《ガラスど》を見た",
            Notation::Narou,
            Notation::Kakuyomu,
        );
        assert_eq!(got, "|硝子戸《ガラスど》を見た");
    }

    #[test]
    fn カクヨムから_pixiv_へ変える() {
        let got = convert(
            "|硝子戸《ガラスど》は《《絶対に》》割れない",
            Notation::Kakuyomu,
            Notation::Pixiv,
        );
        // pixiv には傍点の書き方がないので、中黒のルビで代用する
        assert_eq!(
            got,
            "[[rb:硝子戸 > ガラスど]]は[[rb:絶対に > ・・・]]割れない"
        );
    }

    #[test]
    fn 傍点の書き方がない記法では中黒のルビで代用する() {
        let got = convert(
            "それは《《絶対に》》違う",
            Notation::Kakuyomu,
            Notation::Narou,
        );
        assert_eq!(got, "それは|絶対に《・・・》違う");

        // 読み取りでも傍点として受けるので、戻せば元どおり
        assert_eq!(
            convert(&got, Notation::Narou, Notation::Kakuyomu),
            "それは《《絶対に》》違う"
        );
    }

    #[test]
    fn 中黒のルビは傍点として表示する() {
        let ps = pieces("それは|絶対に《・・・》違う", Notation::Narou);
        let kinds: Vec<&str> = ps.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, vec!["text", "emphasis", "text"]);
        assert_eq!(ps[1].text, "絶対に");
        // src は元の行のまま。開いただけで書き換わらない
        assert_eq!(ps[1].src, "|絶対に《・・・》");
    }

    #[test]
    fn 字数の合わない中黒はただのルビ() {
        // 傍点のつもりではないので、ルビのまま扱う
        let ps = pieces("|絶対に《・》", Notation::Narou);
        assert_eq!(ps[0].kind, "ruby");
        assert_eq!(ps[0].ruby, "・");
    }

    #[test]
    fn 本来の傍点がある記法では中黒のルビを読み替えない() {
        let ps = pieces("それは|絶対に《・・・》違う", Notation::Kakuyomu);
        let ruby = ps.iter().find(|p| p.kind == "ruby").unwrap();
        assert_eq!(ruby.ruby, "・・・");
    }

    #[test]
    fn カクヨムから青空文庫へ変える() {
        let got = convert("《《絶対に》》違う", Notation::Kakuyomu, Notation::Aozora);
        assert_eq!(got, "絶対に［＃「絶対に」に傍点］違う");
    }

    #[test]
    fn 往復しても崩れない() {
        let src = "彼は|硝子戸《ガラスど》を見た。それは《《絶対に》》割れない。";
        for to in [Notation::Narou, Notation::Aozora, Notation::Pixiv] {
            let one = convert(src, Notation::Kakuyomu, to);
            let back = convert(&one, to, Notation::Kakuyomu);
            assert_eq!(back, src, "カクヨム → {to:?} → カクヨム");
        }
    }

    #[test]
    fn 同じ記法なら手を触れない() {
        let src = "|硝子戸《ガラスど》と《《傍点》》";
        assert_eq!(convert(src, Notation::Kakuyomu, Notation::Kakuyomu), src);
    }

    #[test]
    fn 数を数える() {
        let c = count(
            "|一《いち》と|二《に》、《《傍点》》もある",
            Notation::Kakuyomu,
        );
        assert_eq!(c.ruby, 2);
        assert_eq!(c.emphasis, 1);
    }

    #[test]
    fn 表示用の部品に分ける() {
        let ps = pieces(
            "彼は|硝子戸《ガラスど》を《《じっと》》見た",
            Notation::Kakuyomu,
        );
        let kinds: Vec<&str> = ps.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, vec!["text", "ruby", "text", "emphasis", "text"]);

        let ruby = &ps[1];
        assert_eq!(ruby.text, "硝子戸");
        assert_eq!(ruby.ruby, "ガラスど");
        assert_eq!(ruby.src, "|硝子戸《ガラスど》");

        // src を繋ぎ直すと元の行に戻る
        let rebuilt: String = ps.iter().map(|p| p.src.clone()).collect();
        assert_eq!(rebuilt, "彼は|硝子戸《ガラスど》を《《じっと》》見た");
    }

    #[test]
    fn 見出し記号を独立した部品にする() {
        let ps = pieces("＃＃ 二　邂逅", Notation::Kakuyomu);
        assert_eq!(ps[0].kind, "heading");
        assert_eq!(ps[0].src, "＃＃");
        // 記号の後ろの空白は本文側に残る
        assert_eq!(ps[1].kind, "text");
        assert_eq!(ps[1].text, " 二　邂逅");

        // src を繋ぎ直すと元の行に戻る
        let rebuilt: String = ps.iter().map(|p| p.src.clone()).collect();
        assert_eq!(rebuilt, "＃＃ 二　邂逅");
    }

    #[test]
    fn 見出しの中のルビも部品に分ける() {
        let ps = pieces("# |序章《じょしょう》", Notation::Kakuyomu);
        let kinds: Vec<&str> = ps.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, vec!["heading", "text", "ruby"]);
        let rebuilt: String = ps.iter().map(|p| p.src.clone()).collect();
        assert_eq!(rebuilt, "# |序章《じょしょう》");
    }

    #[test]
    fn 行の途中の井桁は見出しにしない() {
        let ps = pieces("値段は#3000円", Notation::Kakuyomu);
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].kind, "text");
    }

    /// 部品の src を繋ぎ直すと、必ず元の行に戻ること。
    /// ここが崩れるとプレビューに入っただけで本文が書き換わる。
    #[test]
    fn 部品は元の行にそのまま戻る() {
        let cases = [
            ("彼は硝子戸《ガラスど》を見た", Notation::Narou),
            ("彼は硝子戸《ガラスど》を見た", Notation::Aozora),
            ("彼は|硝子戸《ガラスど》を見た", Notation::Kakuyomu),
            ("彼は｜硝子戸《ガラスど》を見た", Notation::Aozora),
            ("彼は[[rb:硝子戸>ガラスど]]を見た", Notation::Pixiv),
            ("彼は[[rb:硝子戸 > ガラスど]]を見た", Notation::Pixiv),
            ("それは絶対に［＃「絶対に」に傍点］違う", Notation::Aozora),
            ("それは《《絶対に》》違う", Notation::Kakuyomu),
            ("＃＃ 二　邂逅", Notation::Kakuyomu),
            ("＃ |序章《じょしょう》", Notation::Aozora),
        ];
        for (line, n) in cases {
            let back: String = pieces(line, n).iter().map(|p| p.src.clone()).collect();
            assert_eq!(back, line, "記法 {n:?} の行 {line}");
        }
    }

    #[test]
    fn 縦棒なしのルビは縦棒なしのまま残る() {
        let ps = pieces("彼は硝子戸《ガラスど》を見た", Notation::Narou);
        let ruby = ps.iter().find(|p| p.kind == "ruby").unwrap();
        assert_eq!(ruby.src, "硝子戸《ガラスど》");
        assert_eq!(ruby.text, "硝子戸");
        assert_eq!(ruby.ruby, "ガラスど");
    }

    #[test]
    fn 青空文庫の傍点は親文字ごと一つの部品になる() {
        let ps = pieces("それは絶対に［＃「絶対に」に傍点］違う", Notation::Aozora);
        let kinds: Vec<&str> = ps.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, vec!["text", "emphasis", "text"]);
        // 画面に出るのは親文字だけ。二重に出ない
        let shown: String = ps.iter().map(|p| p.text.clone()).collect();
        assert_eq!(shown, "それは絶対に違う");
    }

    #[test]
    fn 青空文庫の傍点を他の記法へ移しても二重にならない() {
        let got = convert(
            "それは絶対に［＃「絶対に」に傍点］違う",
            Notation::Aozora,
            Notation::Kakuyomu,
        );
        assert_eq!(got, "それは《《絶対に》》違う");
    }

    #[test]
    fn 青空文庫の傍点は往復しても増えない() {
        let src = "それは《《絶対に》》違う";
        let a = convert(src, Notation::Kakuyomu, Notation::Aozora);
        assert_eq!(a, "それは絶対に［＃「絶対に」に傍点］違う");
        assert_eq!(convert(&a, Notation::Aozora, Notation::Kakuyomu), src);
    }

    #[test]
    fn 掛かる先の分からない傍点注記は文字として残す() {
        // 直前が注記の指す文字列と違う。勝手に傍点にしない
        let line = "彼は歩いた［＃「走った」に傍点］";
        let ps = pieces(line, Notation::Aozora);
        assert!(ps.iter().all(|p| p.kind == "text"));
        let back: String = ps.iter().map(|p| p.src.clone()).collect();
        assert_eq!(back, line);
    }

    #[test]
    fn 型紙に文字を差し込む() {
        assert_eq!(fill("|{0}《{1}》", "漢字", "かんじ"), "|漢字《かんじ》");
        assert_eq!(
            fill("{0}［＃「{0}」に傍点］", "傍点", "傍点"),
            "傍点［＃「傍点」に傍点］"
        );
        // 差し込み口でない中かっこはそのまま
        assert_eq!(fill("{2}{0}", "あ", "い"), "{2}あ");
    }

    /// 「絶対に」を UTF-16 の位置で指す。
    fn at(line: &str, word: &str) -> (u32, u32) {
        let byte = line.find(word).unwrap();
        let start = line[..byte].encode_utf16().count() as u32;
        (start, start + word.encode_utf16().count() as u32)
    }

    #[test]
    fn 選んだところに傍点を付ける() {
        let line = "それは絶対に違う";
        let (a, b) = at(line, "絶対に");
        let got = toggle_emphasis(line, a, b, Notation::Kakuyomu).unwrap();
        assert_eq!(got.text, "それは《《絶対に》》違う");
        // 付けた範囲は記法の記号ごと指す
        let u: Vec<u16> = got.text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&u[got.start as usize..got.end as usize]),
            "《《絶対に》》"
        );
    }

    #[test]
    fn 傍点の上でもう一度押すと外れる() {
        let line = "それは《《絶対に》》違う";
        let (a, b) = at(line, "絶対に");
        let got = toggle_emphasis(line, a, b, Notation::Kakuyomu).unwrap();
        assert_eq!(got.text, "それは絶対に違う");
        assert_eq!((got.start, got.end), (3, 6));
    }

    #[test]
    fn 記法ごとの書き方で付く() {
        let line = "それは絶対に違う";
        let (a, b) = at(line, "絶対に");
        for (n, want) in [
            (Notation::Narou, "それは|絶対に《・・・》違う"),
            (Notation::Aozora, "それは絶対に［＃「絶対に」に傍点］違う"),
            (Notation::Pixiv, "それは[[rb:絶対に > ・・・]]違う"),
        ] {
            assert_eq!(toggle_emphasis(line, a, b, n).unwrap().text, want, "{n:?}");
            // 付けた行をもう一度押せば外れる
            let on = toggle_emphasis(line, a, b, n).unwrap();
            let (c, d) = at(&on.text, "絶対に");
            assert_eq!(toggle_emphasis(&on.text, c, d, n).unwrap().text, line);
        }
    }

    #[test]
    fn ルビに掛かる範囲には付けられない() {
        let line = "彼は|硝子戸《ガラスど》を見た";
        let (a, b) = at(line, "硝子戸");
        assert_eq!(toggle_emphasis(line, a, b, Notation::Kakuyomu), None);
    }

    #[test]
    fn 空の範囲では何もしない() {
        assert_eq!(
            toggle_emphasis("それは違う", 2, 2, Notation::Kakuyomu),
            None
        );
        assert_eq!(toggle_emphasis("", 0, 0, Notation::Kakuyomu), None);
    }

    #[test]
    fn 傍点を外しても周りの記法は元のまま() {
        // 縦棒を省いたルビが書き換わらないこと
        let line = "彼は硝子戸《ガラスど》を《《じっと》》見た";
        let (a, b) = at(line, "じっと");
        let got = toggle_emphasis(line, a, b, Notation::Kakuyomu).unwrap();
        assert_eq!(got.text, "彼は硝子戸《ガラスど》をじっと見た");
    }

    #[test]
    fn 改行をまたがない() {
        // ルビ記法が行をまたいで誤検出しないこと
        let nodes = parse_line("|途中で", Notation::Narou);
        assert_eq!(nodes, vec![Node::Text("|途中で".into())]);
    }
}
