# tauri-tate-editor

形態素解析による文体マーカーつきの、小説執筆用の縦書きエディタ。

副詞・形容詞・形容動詞に自動でマーカーを引き、推敲を支援することを目的とする。原稿用紙のマス目表示と、判型（文庫・新書など）に応じたページ区切りに対応する。

## 構成

| | |
|---|---|
| フレームワーク | Tauri 2（WebView2 / Chromium） |
| フロントエンド | TypeScript（vanilla・Vite） |
| バックエンド | Rust |
| 形態素解析 | Lindera 5 + UniDic（埋め込み） |
| 段落管理 | thunderdome（世代付きアリーナ） |

```
src-tauri/src/
  lib.rs        Tauri コマンドの定義
  document.rs   本文の正本。Arena<Paragraph> で段落を管理
  analyzer.rs   Lindera のラッパー
src/
  main.ts       画面の組み立てとイベント配線
  editor/
    types.ts    Rust と受け渡しする型
    dom.ts      contenteditable の構造維持・キャレット制御
    session.ts  DOM と Rust の同期、解析の依頼
    marker.ts   CSS Custom Highlight API による品詞マーカー
    grid.ts     判型・マス目・文字の正規化
    scroll.ts   縦書きのホイール変換とページ送り
```

## 開発

```bash
npm install
npm run tauri dev
```

初回の `cargo build` は UniDic を埋め込むため非常に時間がかかり、`target/` は数 GB になる。

```bash
cd src-tauri
cargo test
```

## 設計上の要点

### 段落を単位にする

本文は段落の配列として持つ。差分解析・マーカーの再生成・将来の Undo が、すべて同じ単位で揃うため。

正本は Rust 側の `Arena<Paragraph>`。フロントエンドは表示用のミラーを持つだけ。打鍵のたびに IPC を往復させず、入力が止まってから（250ms）まとめて送る。

`Document::set_text` は「同じ位置に同じ本文の段落があれば `Index` と解析結果を引き継ぐ」ため、全文を送っても再解析されるのは編集された段落だけで済む。フロントエンド側で差分を計算する必要がない。

### 段落 ID を IPC に載せるときの注意

`thunderdome::Index::to_bits()` の u64 をそのまま JSON の数値として渡すと、JavaScript の Number（IEEE754 double）では下位ビットが落ちる。`to_bits` は上位 32bit にスロット番号を置くため、この精度落ちの範囲に容易に入る。

そのため `{ slot: u32, gen: u32 }` に分けて受け渡ししている（`document::ParaId`）。

### 見出し

行頭の `＃` の連続を見出しとみなす。数を増やすと下の階層になる。
半角の `#` も認識するが、**半角文字は半角幅で描画されるため、その行だけ升からずれる**。
案内では全角を勧めている。本文の行頭は常に升に揃うので、ずれは見出し行の中だけで収まる。

章別の文字数は「その見出しから、同じか浅いレベルの次の見出しまで」を数える。
下位の見出しの分も含むので、章のすぐ下に節を置いても章の分量が 0 にならない。

### 外部テキストの取り込み

貼り付けとファイル読み込みでは、必ず改行を段落に割ってから取り込む。
`contenteditable` にそのまま入れると生の改行がテキストノードに残り、
`readText` が段落を `\n` で繋ぐためモデル側で段落が余分に割れる。
青空文庫からの貼り付けで実際に起きた。CRLF と CR も同様に扱う。

読み込みの文字コードは BOM → UTF-8 → Shift_JIS → EUC-JP の順に推定する。
改行は内部では常に LF に揃え、元の改行コードは保存時に戻す。

### 文字位置の単位

Rust は UTF-8 バイト、JavaScript は UTF-16 コード単位で文字列を数える。マーカーの位置は **UTF-16 単位に変換してから** 返す（`analyzer::analyze_text`）。これを怠るとサロゲートペアを含む段落でマーカーがずれる。

## 実装前の検証で分かったこと

着手前に、素の HTML で以下を実測した（`../vertical-editor-probe.html`、`../vertical-grid-probe.html`）。

### CSS Custom Highlight API

- **DOM を書き換えないので、IME 変換中にマーカーを更新しても入力が壊れない。** span を挿す方式との決定的な違い
- `text-decoration` は `::highlight(名前)` の**単体セレクタでしか効かない**。`.クラス ::highlight(名前)` と書くと無視される（`background-color` と `color` は子孫セレクタでも効く）。そのため表示スタイルは CSS クラスではなくハイライト名で切り替えている
- `text-underline-position: right` は効かず、**傍線は必ず文字の左側**に出る
- `overline` と `text-emphasis`（傍点）は描画されない

### 縦書きのマス目

- **禁則処理はマス目を壊さない。** 19 字の行ができても次の行はまた升の先頭から始まるので、行末に空きマスができるだけ。原稿用紙として正常な見た目であり、自前で行分割を実装する必要はない
- マス目を壊すのは**半角幅で描画される文字**だけ。`—`(U+2014 EM DASH) は MS 明朝・BIZ UD 明朝で半角になる。小説のダーシは `―`(U+2015) を使えば揃う（`grid.normalizeText` で置換）
- **游明朝は約物（、。「」）が詰まるためマス目には使えない。** `font-feature-settings: "palt" 0` でも防げない
- `hanging-punctuation` は Chromium 非対応。句読点のぶら下げ組みはできない

### スクロール

- Chromium は縦書き要素の上でも**縦ホイールを横スクロールに変換しない**。自前で `wheel` を横取りする必要がある
- `scrollLeft` の原点と符号が環境によって異なる。`scrollIntoView({inline:"start"})` も期待どおりに動かない。
  そこで起動時に「`scrollLeft` を増やすと中身が画面上でどちらへ何 px 動くか」を実測し、以降はその比率で換算している（`scroll.ts` の `calibrate`）。画面上の座標だけで考えられるので、原点や符号の違いを意識しなくて済む
- **縦書きの CSS multicol はページ送りに使えない。** 段が上下に積まれる新聞レイアウトになる。ページ区切りは背景の `repeating-linear-gradient` で描く

## 進捗

- [x] Tauri 雛形・thunderdome・IPC 基盤
- [x] 縦書き表示・マス目・判型プリセット・ページ区切り
- [x] Lindera 常駐・差分解析・品詞マーカー
- [x] ファイル入出力（Shift_JIS 読み込み）・自動保存・世代バックアップ
- [x] Undo/Redo・検索置換・ページジャンプ
- [x] 文字数カウントの詳細・章アウトライン
- [ ] 文体チェック統計（副詞率・文末連続・語の多用）
- [ ] なろう記法（ルビ・傍点）のプレビューと書き出し
- [ ] 設定の永続化・配色・印刷／PDF
