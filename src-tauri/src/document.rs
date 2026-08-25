//! 本文の保持。段落を世代付きアリーナ（thunderdome）で管理する。
//!
//! アリーナを使う理由は、段落を削除したあとにスロットが再利用されても
//! 世代が変わるため、古い `Index` での参照が自動的に無効になること。
//! 解析結果を非同期で受け取る設計では、これで「編集が追い越した結果」を
//! 取りこぼしなく捨てられる。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thunderdome::{Arena, Index};

use crate::analyzer::{self, Mark};
use crate::stats::{self, ParaInput, StyleOptions, StyleReport};

/// 段落の識別子を JSON に載せるための形。
///
/// `thunderdome::Index::to_bits()` は u64 を返すが、これを JSON の数値と
/// して渡すと JavaScript 側で精度が落ちる（Number は IEEE754 double なので
/// 2^53 を超える下位ビットが失われ、上位 32bit にスロット番号が入る
/// `to_bits` の値はこの範囲に容易に入る）。
/// そのため slot と generation に分けて受け渡しする。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParaId {
    pub slot: u32,
    pub gen: u32,
}

impl From<Index> for ParaId {
    fn from(i: Index) -> Self {
        ParaId {
            slot: i.slot(),
            gen: i.generation(),
        }
    }
}

impl ParaId {
    /// `thunderdome::Index::to_bits()` のビット配置は
    /// `(generation << 32) | slot`。順序を取り違えると、
    /// generation が 0 と解釈されて `from_bits` が None を返したり、
    /// 別のスロットを指す Index ができてしまう。
    fn to_index(self) -> Option<Index> {
        Index::from_bits(((self.gen as u64) << 32) | self.slot as u64)
    }
}

/// 一段落。
#[derive(Debug, Clone, Default)]
pub struct Paragraph {
    pub text: String,
    /// 直近の解析結果。本文を書き換えた時点で捨てる。
    pub marks: Option<Vec<Mark>>,
}

/// 本文全体。
#[derive(Default)]
pub struct Document {
    paras: Arena<Paragraph>,
    /// 段落の並び順。アリーナは順序を保証しないので別に持つ。
    order: Vec<Index>,
}

/// フロントエンドへ返す段落一件分。
#[derive(Debug, Clone, Serialize)]
pub struct ParaView {
    pub id: ParaId,
    pub text: String,
}

/// 解析結果一件分。
#[derive(Debug, Clone, Serialize)]
pub struct AnalyzeResult {
    pub id: ParaId,
    pub marks: Vec<Mark>,
}

impl Document {
    pub fn new() -> Self {
        Self::default()
    }

    /// 本文全体を差し替える。改行で段落に分ける。
    ///
    /// 同じ位置に同じ本文の段落が残っていれば、その `Index` と解析結果を
    /// そのまま引き継ぐ。これにより「1文字打った段落だけ再解析される」
    /// という差分解析が、フロントエンド側の差分計算なしで成立する。
    ///
    /// 引き継げなかった段落はアリーナから削除する。世代が上がるので、
    /// 古い `ParaId` を後から渡されても無効と分かる。
    pub fn set_text(&mut self, text: &str) -> Vec<ParaView> {
        let lines: Vec<&str> = text.split('\n').collect();
        let old_order = std::mem::take(&mut self.order);
        let mut new_order: Vec<Index> = Vec::with_capacity(lines.len());
        let mut kept: HashSet<Index> = HashSet::with_capacity(lines.len());

        for (i, line) in lines.iter().enumerate() {
            if let Some(&idx) = old_order.get(i) {
                if self.paras.get(idx).is_some_and(|p| p.text == *line) {
                    new_order.push(idx);
                    kept.insert(idx);
                    continue;
                }
            }
            let idx = self.paras.insert(Paragraph {
                text: (*line).to_string(),
                marks: None,
            });
            new_order.push(idx);
            kept.insert(idx);
        }

        for idx in old_order {
            if !kept.contains(&idx) {
                self.paras.remove(idx);
            }
        }

        self.order = new_order;
        self.views()
    }

    /// 段落の一覧を並び順で返す。
    pub fn views(&self) -> Vec<ParaView> {
        self.order
            .iter()
            .filter_map(|&i| {
                self.paras.get(i).map(|p| ParaView {
                    id: i.into(),
                    text: p.text.clone(),
                })
            })
            .collect()
    }

    /// 本文全体を改行区切りで取り出す。
    pub fn text(&self) -> String {
        self.order
            .iter()
            .filter_map(|&i| self.paras.get(i).map(|p| p.text.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 段落の本文を差し替える。解析結果は無効化する。
    ///
    /// 世代が食い違う `ParaId`（＝すでに削除された段落）を渡された場合は
    /// `false` を返すだけで、何も壊さない。
    pub fn update(&mut self, id: ParaId, text: String) -> bool {
        let Some(idx) = id.to_index() else {
            return false;
        };
        match self.paras.get_mut(idx) {
            Some(p) => {
                p.text = text;
                p.marks = None;
                true
            }
            None => false,
        }
    }

    /// まだ解析していない段落だけを解析して返す。
    ///
    /// 解析済みの段落は返さない。フロントエンドは受け取った分だけ
    /// マーカーを差し替えればよく、段落数が増えても IPC の量は
    /// 「編集された段落の数」に比例する。
    pub fn analyze_pending(&mut self) -> Result<Vec<AnalyzeResult>, String> {
        let targets: Vec<Index> = self
            .order
            .iter()
            .copied()
            .filter(|&i| self.paras.get(i).is_some_and(|p| p.marks.is_none()))
            .collect();

        let mut out = Vec::with_capacity(targets.len());
        for idx in targets {
            let Some(p) = self.paras.get(idx) else {
                continue;
            };
            let marks = analyzer::analyze_text(&p.text)?;
            if let Some(p) = self.paras.get_mut(idx) {
                p.marks = Some(marks.clone());
            }
            out.push(AnalyzeResult {
                id: idx.into(),
                marks,
            });
        }
        Ok(out)
    }

    /// 指定した段落を解析する。解析済みならキャッシュを返す。
    ///
    /// 世代が古い `ParaId`（すでに消えた段落）は黙って読み飛ばす。
    pub fn analyze(&mut self, ids: &[ParaId]) -> Result<Vec<AnalyzeResult>, String> {
        let targets: Vec<Index> = if ids.is_empty() {
            self.order.clone()
        } else {
            ids.iter().filter_map(|id| id.to_index()).collect()
        };

        let mut out = Vec::with_capacity(targets.len());
        for idx in targets {
            let Some(p) = self.paras.get(idx) else {
                continue;
            };
            let marks = match &p.marks {
                Some(m) => m.clone(),
                None => {
                    let m = analyzer::analyze_text(&p.text)?;
                    if let Some(p) = self.paras.get_mut(idx) {
                        p.marks = Some(m.clone());
                    }
                    m
                }
            };
            out.push(AnalyzeResult {
                id: idx.into(),
                marks,
            });
        }
        Ok(out)
    }

    /// 文体を調べて報告を作る。
    ///
    /// まだ解析していない段落があれば先に解析する。品詞の情報が
    /// 揃っていないと、副詞の割合や語の繰り返しが数えられない。
    pub fn style_report(&mut self, opts: &StyleOptions) -> Result<StyleReport, String> {
        self.analyze_pending()?;

        let empty: Vec<Mark> = Vec::new();
        let paras: Vec<ParaInput<'_>> = self
            .order
            .iter()
            .filter_map(|&i| self.paras.get(i))
            .map(|p| ParaInput {
                text: &p.text,
                marks: p.marks.as_ref().unwrap_or(&empty),
            })
            .collect();

        Ok(stats::analyze(&paras, opts))
    }

    /// 改行を除いた文字数。原稿用紙の枚数計算に使う。
    pub fn char_count(&self) -> usize {
        self.order
            .iter()
            .filter_map(|&i| self.paras.get(i))
            .map(|p| p.text.chars().count())
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn para_id_と_index_を往復できる() {
        // ビット配置を取り違えると、slot 0 では None、それ以外では
        // 別のスロットを指す Index ができる。IPC の要なのでここで固める。
        let mut arena: Arena<u32> = Arena::new();
        let a = arena.insert(10);
        let b = arena.insert(20);
        arena.remove(a);
        let c = arena.insert(30); // a のスロットを再利用し、世代が上がる

        for idx in [b, c] {
            let id: ParaId = idx.into();
            assert_eq!(id.to_index(), Some(idx), "往復で一致しない: {id:?}");
        }
        // 削除済みの古い Index は世代違いとして復元はできるが、参照は無効
        let old: ParaId = a.into();
        assert_eq!(old.to_index(), Some(a));
        assert!(arena.get(old.to_index().unwrap()).is_none());
    }

    #[test]
    fn 段落に分割される() {
        let mut d = Document::new();
        let v = d.set_text("一行目\n二行目\n三行目");
        assert_eq!(v.len(), 3);
        assert_eq!(v[1].text, "二行目");
        assert_eq!(d.text(), "一行目\n二行目\n三行目");
    }

    #[test]
    fn 更新すると解析結果が捨てられる() {
        let mut d = Document::new();
        let v = d.set_text("とても静かな夜");
        let id = v[0].id;
        d.analyze(&[id]).unwrap();
        let idx = id.to_index().unwrap();
        assert!(d.paras.get(idx).unwrap().marks.is_some());

        d.update(id, "書き換えた".into());
        assert!(d.paras.get(idx).unwrap().marks.is_none());
    }

    #[test]
    fn 古い世代の_id_は無視される() {
        let mut d = Document::new();
        let v = d.set_text("最初の本文");
        let old = v[0].id;
        // 本文が変われば段落は作り直され、古い Index の世代は無効になる
        d.set_text("別の本文");
        assert!(!d.update(old, "書き換え".into()));
        // 解析要求に混ざっても落ちない
        assert!(d.analyze(&[old]).unwrap().is_empty());
    }

    #[test]
    fn 変わらない段落は_id_と解析結果を引き継ぐ() {
        let mut d = Document::new();
        let a = d.set_text("とても静かな夜\n白い雪が降る\n長い夜だった");
        d.analyze_pending().unwrap();
        // 二段落目だけ書き換える
        let b = d.set_text("とても静かな夜\n白い雨が降る\n長い夜だった");

        assert_eq!(a[0].id, b[0].id, "変わらない段落の id は保たれるべき");
        assert_eq!(a[2].id, b[2].id);
        assert_ne!(a[1].id, b[1].id, "書き換えた段落は新しい id になるべき");

        // 再解析が必要なのは書き換えた段落だけ
        let pending = d.analyze_pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, b[1].id);
    }

    #[test]
    fn 段落を増やしても既存の解析結果は残る() {
        let mut d = Document::new();
        d.set_text("とても静かな夜\n白い雪が降る");
        assert_eq!(d.analyze_pending().unwrap().len(), 2);
        // 末尾に一段落足す
        d.set_text("とても静かな夜\n白い雪が降る\nやがて朝が来る");
        assert_eq!(
            d.analyze_pending().unwrap().len(),
            1,
            "増えた段落だけが解析対象になるべき"
        );
    }

    #[test]
    fn 文字数は改行を含まない() {
        let mut d = Document::new();
        d.set_text("あいう\nえお");
        assert_eq!(d.char_count(), 5);
    }
}
