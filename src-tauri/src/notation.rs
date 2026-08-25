//! ルビと傍点の記法。投稿先ごとに書き方が違うので相互に変換する。
//!
//! 各記法の仕様はここに集約してある。実際の投稿サイトの仕様と
//! 食い違っていたら、この表を直せば全体に反映される。
//!
//! | 記法 | ルビ | 傍点 |
//! |---|---|---|
//! | 小説家になろう | `|漢字《かんじ》` / `漢字《かんじ》` | なし（`|文字《・》` で代用） |
//! | カクヨム | `|漢字《かんじ》` / `漢字《かんじ》` | `《《文字》》` |
//! | 青空文庫 | `｜漢字《かんじ》` / `漢字《かんじ》` | `［＃「文字」に傍点］` |
//! | pixiv | `[[rb:漢字 > かんじ]]` | なし |
//!
//! 「漢字の直後に《》」の形は、縦棒を省いても漢字列がルビの親になる
//! という書き方。読み込みでは受けるが、書き出しでは常に縦棒を付ける
//! （どこからルビが始まるかが曖昧にならないようにするため）。

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// 対応する記法。
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

impl Notation {
    pub fn label(self) -> &'static str {
        match self {
            Notation::Narou => "小説家になろう",
            Notation::Kakuyomu => "カクヨム",
            Notation::Aozora => "青空文庫",
            Notation::Pixiv => "pixiv",
        }
    }

    /// その記法で傍点を書けるか。
    pub fn supports_emphasis(self) -> bool {
        matches!(self, Notation::Kakuyomu | Notation::Aozora)
    }
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

/// 一行を分解する。
pub fn parse_line(line: &str, from: Notation) -> Vec<Node> {
    // 傍点を先に取り出す。《《…》》 はルビの《》と重なるので順番が要る
    let mut nodes = vec![Node::Text(line.to_string())];

    match from {
        Notation::Kakuyomu => {
            nodes = split_by(&nodes, &RE_KAKUYOMU_EMPHASIS, |c| {
                Node::Emphasis(c[1].to_string())
            });
        }
        Notation::Aozora => {
            nodes = split_by(&nodes, &RE_AOZORA_EMPHASIS, |c| {
                Node::Emphasis(c[1].to_string())
            });
        }
        _ => {}
    }

    if from == Notation::Pixiv {
        nodes = split_by(&nodes, &RE_PIXIV_RUBY, |c| Node::Ruby {
            base: c[1].to_string(),
            ruby: c[2].to_string(),
        });
    } else {
        nodes = split_by(&nodes, &RE_BAR_RUBY, |c| Node::Ruby {
            base: c[1].to_string(),
            ruby: c[2].to_string(),
        });
        nodes = split_by(&nodes, &RE_KANJI_RUBY, |c| Node::Ruby {
            base: c[1].to_string(),
            ruby: c[2].to_string(),
        });
    }

    nodes.retain(|n| !matches!(n, Node::Text(t) if t.is_empty()));
    nodes
}

/// テキストノードだけを正規表現で切り分けていく。
fn split_by<F>(nodes: &[Node], re: &Regex, make: F) -> Vec<Node>
where
    F: Fn(&regex::Captures<'_>) -> Node,
{
    let mut out = Vec::new();
    for node in nodes {
        let Node::Text(text) = node else {
            out.push(node.clone());
            continue;
        };
        let mut last = 0usize;
        for c in re.captures_iter(text) {
            let m = c.get(0).unwrap();
            if m.start() > last {
                out.push(Node::Text(text[last..m.start()].to_string()));
            }
            out.push(make(&c));
            last = m.end();
        }
        if last < text.len() {
            out.push(Node::Text(text[last..].to_string()));
        }
    }
    out
}

/* ============================================================
記法ごとの書き出し
============================================================ */

/// 分解したものを、指定の記法の文字列に戻す。
pub fn render_line(nodes: &[Node], to: Notation) -> String {
    let mut out = String::new();
    for node in nodes {
        match node {
            Node::Text(t) => out.push_str(t),
            Node::Ruby { base, ruby } => match to {
                Notation::Pixiv => out.push_str(&format!("[[rb:{base} > {ruby}]]")),
                Notation::Aozora => out.push_str(&format!("｜{base}《{ruby}》")),
                _ => out.push_str(&format!("|{base}《{ruby}》")),
            },
            Node::Emphasis(t) => match to {
                Notation::Kakuyomu => out.push_str(&format!("《《{t}》》")),
                Notation::Aozora => out.push_str(&format!("{t}［＃「{t}」に傍点］")),
                // 傍点を書けない記法では、文字だけ残す。
                // 記号を残すと投稿先でそのまま表示されてしまう
                _ => out.push_str(t),
            },
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
    /// "text" | "ruby" | "emphasis"
    pub kind: &'static str,
    /// 画面に出す文字（ルビなら親文字）
    pub text: String,
    /// ルビの読み
    pub ruby: String,
    /// 元の記法そのもの。編集後にこれを繋ぎ直して本文に戻す
    pub src: String,
}

/// 一行をプレビュー用の部品に分ける。
pub fn pieces(line: &str, notation: Notation) -> Vec<Piece> {
    parse_line(line, notation)
        .into_iter()
        .map(|n| match n {
            Node::Text(t) => Piece {
                kind: "text",
                src: t.clone(),
                text: t,
                ruby: String::new(),
            },
            Node::Ruby { base, ruby } => {
                let src = render_line(
                    &[Node::Ruby {
                        base: base.clone(),
                        ruby: ruby.clone(),
                    }],
                    notation,
                );
                Piece {
                    kind: "ruby",
                    text: base,
                    ruby,
                    src,
                }
            }
            Node::Emphasis(t) => {
                let src = render_line(&[Node::Emphasis(t.clone())], notation);
                Piece {
                    kind: "emphasis",
                    text: t,
                    ruby: String::new(),
                    src,
                }
            }
        })
        .collect()
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
        // pixiv には傍点がないので、記号を落として文字だけ残す
        assert_eq!(got, "[[rb:硝子戸 > ガラスど]]は絶対に割れない");
    }

    #[test]
    fn カクヨムから青空文庫へ変える() {
        let got = convert("《《絶対に》》違う", Notation::Kakuyomu, Notation::Aozora);
        assert_eq!(got, "絶対に［＃「絶対に」に傍点］違う");
    }

    #[test]
    fn 往復しても崩れない() {
        let src = "彼は|硝子戸《ガラスど》を見た。それは《《絶対に》》割れない。";
        let to_pixiv = convert(src, Notation::Kakuyomu, Notation::Pixiv);
        let back = convert(&to_pixiv, Notation::Pixiv, Notation::Kakuyomu);
        // 傍点は pixiv で表せないので落ちる。ルビは戻る
        assert!(back.contains("|硝子戸《ガラスど》"));
        assert!(back.contains("絶対に割れない"));
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
    fn 改行をまたがない() {
        // ルビ記法が行をまたいで誤検出しないこと
        let nodes = parse_line("|途中で", Notation::Narou);
        assert_eq!(nodes, vec![Node::Text("|途中で".into())]);
    }
}
