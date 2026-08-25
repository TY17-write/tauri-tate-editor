/**
 * 編集セッション。DOM と Rust 側の段落モデルを同期し、
 * 解析結果をマーカーとして描画する。
 *
 * 正本は Rust 側の Arena<Paragraph>。フロントエンドは表示用のミラー。
 * 打鍵のたびに IPC を往復させず、入力が止まってからまとめて送る。
 */

import { invoke } from "@tauri-apps/api/core";

import {
  caretOffset,
  createPara,
  insertTextAtCaret,
  normalizeStructure,
  paraOf,
  readText,
  selectionOffsets,
  setCaretOffset,
  setSelectionOffsets,
  splitAtCaret,
  writeText,
} from "./dom";
import { MarkerLayer } from "./marker";
import {
  buildPreviewPara,
  commitPreviewEdits,
  emphasisSource,
  linePieces,
  notationForms,
  previewPieces,
  readPreview,
  readPreviewPara,
  rubyBase,
  rubyReading,
  rubySource,
  toggleEmphasisAt,
} from "./notation";
import type { Notation, NotationForms } from "./notation";
import { domRange, headingEnd, plainOnly, readSegments, srcOffsetAt } from "./segment";
import type { Segment } from "./segment";
import { idKey } from "./types";
import type { AnalyzeResult, ParaId, ParaView } from "./types";

/**
 * 編集の見え方。
 *
 * source  記法をそのまま見せる
 * preview ルビや傍点を実際の形で見せ、見出し記号は伏せる
 *
 * どちらでも編集でき、品詞マーカーも出る。プレビューではルビの
 * 親文字や読みもその場で打ち直せる（notation.ts を参照）。
 */
export type EditMode = "source" | "preview";

/** 入力が止まってから解析を投げるまでの待ち時間(ms)。 */
const DEBOUNCE_MS = 250;

/** 本文の不一致を検知したときに、構造を直して再挑戦する回数の上限。 */
const MISMATCH_RETRY_LIMIT = 3;

/** ルビや傍点のコマンドの結果。画面に出す知らせと、本文を直したかどうか。 */
export interface CommandResult {
  message: string;
  changed: boolean;
}

/** ルビを振る（直す）相手。小窓に出す内容を決めるのに使う。 */
export interface RubyTarget {
  /** 親文字 */
  base: string;
  /** いまの読み。新しく振るときは空 */
  reading: string;
  /** 小窓を出す目安の場所 */
  rect: DOMRect | null;
}

export interface SessionEvents {
  onStatus?: (msg: string, isError?: boolean) => void;
  onSynced?: () => void;
  /** 人の手で本文が編集されたとき。プログラムからの差し替えでは呼ばれない */
  onEdit?: () => void;
  /** 本文を入れる要素が作り直されたとき。参照を持っている側は差し替える */
  onElementReplaced?: (el: HTMLElement) => void;
}

export class Session {
  readonly marker: MarkerLayer;
  private paper: HTMLElement;
  private composing = false;
  private timer: number | null = null;
  private syncing = false;
  private dirty = false;
  /** 直近に Rust へ送った本文。無変化なら送らない。null はまだ一度も送っていない状態 */
  private lastSent: string | null = null;
  /** 本文の不一致が続いている回数 */
  private mismatchRetries = 0;
  /** いまの見え方 */
  private mode: EditMode = "source";
  /** いまの記法。プレビューを組み立てるときに要る */
  private notation: Notation = "kakuyomu";
  /**
   * ルビの小窓が開いているあいだ覚えておく、振る相手の場所。
   *
   * 小窓へフォーカスが移ると本文の選択は失われるので、段落の番号と
   * 記法テキスト上の範囲で持っておく。
   */
  private rubySpot: { index: number; start: number; end: number; base: string } | null = null;
  /**
   * その記法でのルビと傍点の書き方。Rust から取る。
   *
   * プレビューでルビを直したときに、記法テキストを組み立て直すのに使う。
   * 書き方を画面側にも書くと Rust の表と食い違うので、必ず取りに行く。
   */
  private forms: NotationForms | null = null;

  constructor(
    paper: HTMLElement,
    private readonly events: SessionEvents = {},
  ) {
    this.paper = paper;
    this.marker = new MarkerLayer(paper);
    this.bind();
  }

  /** 本文を入れている要素。作り直されることがあるので都度取得すること。 */
  get element(): HTMLElement {
    return this.paper;
  }

  /**
   * 元に戻す履歴を捨てる。
   *
   * ブラウザの undo 履歴は contenteditable の要素ごとに積まれる。
   * `replaceChildren` のようなプログラムからの差し替えはこの履歴に
   * 載らないので、ファイルを開いたあとに元に戻すと、差し替え前の
   * 編集が新しい本文に適用されて内容が混ざる。
   *
   * 実測では contenteditable を false→true にしても履歴は消えず、
   * 要素そのものを作り直すと消える。そこで中身を移した新しい要素に
   * 差し替える。
   */
  resetHistory(): void {
    const fresh = this.paper.cloneNode(false) as HTMLElement;
    while (this.paper.firstChild) fresh.appendChild(this.paper.firstChild);

    const hadFocus = document.activeElement === this.paper;
    this.paper.replaceWith(fresh);
    this.paper = fresh;
    this.marker.rebind(fresh);
    this.bind();
    if (hadFocus) fresh.focus();
    this.events.onElementReplaced?.(fresh);
  }

  private bind(): void {
    // 改行はブラウザ任せにすると <div> や <br> が入って構造が崩れるので横取りする
    this.paper.addEventListener("beforeinput", (e) => {
      const t = (e as InputEvent).inputType;
      if (t === "insertParagraph" || t === "insertLineBreak") {
        e.preventDefault();
        splitAtCaret(this.paper);
        this.schedule();
      }
    });

    // 貼り付けは自前で処理する。ブラウザ任せにすると生の改行が
    // テキストノードに残り、モデル側で段落が余分に割れる。
    // 青空文庫からの貼り付けで実際に起きた。
    this.paper.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      insertTextAtCaret(this.paper, text);
      this.schedule();
    });

    this.paper.addEventListener("input", (e) => {
      this.events.onEdit?.();
      // composing フラグに加えて inputType でも弾く。
      // 変換中の打鍵は insertCompositionText として飛んでくる。
      const t = (e as InputEvent).inputType;
      if (this.composing || t === "insertCompositionText") return;
      this.schedule();
    });

    // IME 変換中は解析を投げない。
    // CSS Custom Highlight API は DOM を触らないので変換中に更新しても
    // 壊れないことは確認済みだが、確定していない文字列を解析するのは
    // IPC の無駄なので止めておく。
    // 傍線（右）の span 方式は DOM を書き換えるため、こちらは
    // 変換中に触ると実際に入力が壊れる。renderMarks() で弾いている。
    this.paper.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.paper.addEventListener("compositionend", () => {
      this.composing = false;
      // 変換中に未確定文字列を送ってしまっていた場合、lastSent が
      // それを覚えていると「変化なし」と判断して送り直さない。
      // 確定後は必ず送り直して、確定後の本文で解析させる。
      this.lastSent = null;
      this.schedule();
    });
  }

  /**
   * マーカーを描き直す。
   *
   * 傍線（右）と、プレビューの傍点の中の印は DOM に span を挿すため
   * キャレットが飛ぶ。本文の先頭からの文字オフセットで保存して戻す。
   *
   * プレビューでも描く。Rust が返すオフセットは記法テキストの
   * 上での位置だが、段落の中身を区間の並びに直してから写すので
   * 対応が付く（segment.ts を参照）。
   */
  renderMarks(): void {
    // 傍線（右）と、プレビューの傍点の中の印は span を挿す。
    // IME 変換中に DOM を触ると入力が壊れるので、確定を待つ。
    if (this.composing && (this.marker.usesDom || this.mode === "preview")) return;

    const focused = document.activeElement === this.paper;
    const at = focused ? selectionOffsets(this.paper) : null;
    this.marker.render();
    // 書き換えていなければ選択は動いていない。戻すとかえって
    // 選び直した範囲（傍点を付けた直後など）を潰してしまう
    if (at && this.marker.touchedDom) setSelectionOffsets(this.paper, at.start, at.end);
  }

  /** 解析を予約する。連続入力中は最後の1回だけ走る。 */
  schedule(): void {
    this.dirty = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, DEBOUNCE_MS);
  }

  /**
   * 本文を差し替える。ファイルを開いたときや正規化で使う。
   *
   * プログラムからの差し替えはブラウザの undo 履歴に載らないため、
   * そのままにすると差し替え前の編集が新しい本文に適用されて
   * 内容が混ざる。ここで履歴を捨てて、この状態を底にする。
   */
  async setText(text: string): Promise<void> {
    writeText(this.paper, text);
    this.resetHistory();
    this.lastSent = null;
    await this.sync();
  }

  /** 現在の本文。プレビュー中でも記法テキストとして取り出せる。 */
  text(): string {
    return this.mode === "preview" ? readPreview(this.paper, this.forms) : readText(this.paper);
  }

  get editMode(): EditMode {
    return this.mode;
  }

  /**
   * 見え方を切り替える。
   *
   * プレビューではルビと傍点を実際の形で見せる。要素は
   * `contenteditable="false"` の塊にしてあるので、キャレットが
   * 中に入り込んで記法が壊れることはない。
   *
   * 品詞マーカーはどちらの見え方でも出す。段落の中身を作り直すので、
   * 切り替えたあとに `refreshMarks()` で引き直す。
   */
  async setMode(mode: EditMode, notation: Notation): Promise<void> {
    if (mode === this.mode) return;
    // いまの本文を確定させてから切り替える
    await this.sync();
    await this.useNotation(notation);

    if (mode === "preview") {
      await this.buildPreview();
    } else {
      writeText(this.paper, readPreview(this.paper, this.forms));
    }

    this.mode = mode;
    this.resetHistory();
    this.lastSent = null;
    await this.sync();
    await this.refreshMarks();
  }

  /** プレビューを組み直す。記法を変えたあとに使う。 */
  async rebuildPreview(notation: Notation): Promise<void> {
    if (this.mode !== "preview") return;
    await this.useNotation(notation);
    await this.buildPreview();
    this.resetHistory();
    this.lastSent = null;
    await this.sync();
    await this.refreshMarks();
  }

  /**
   * 記法を切り替え、その書き方を Rust から取る。
   *
   * プレビューを組み立てる前に必ず通す。型紙が揃っていないと、
   * ルビを直したときに記法テキストを組み立て直せない。
   */
  private async useNotation(notation: Notation): Promise<void> {
    if (this.notation === notation && this.forms) return;
    this.notation = notation;
    this.forms = await notationForms(notation);
  }

  /** Rust から部品をもらってプレビューの段落を並べ直す。 */
  private async buildPreview(): Promise<void> {
    const paras = await previewPieces(this.notation);
    const frag = document.createDocumentFragment();
    for (const pieces of paras) frag.appendChild(buildPreviewPara(pieces));
    this.paper.replaceChildren(frag);
  }

  /**
   * いまの記法を教える。
   *
   * ルビと傍点のコマンドが使う書き方は、この記法で決まる。
   * プレビューを開いていなくても、起動時と記法を変えたときに呼ぶこと。
   */
  async setNotation(notation: Notation): Promise<void> {
    await this.useNotation(notation);
  }

  /**
   * ルビを振る（直す）相手を決めて覚える。
   *
   * 読みは小窓で入れる。rt の中では日本語入力が続かず、変換を始めた
   * 時点で入力が外れてしまうため、本文とは別の入力欄に任せる。
   *
   * 選んだところがルビに掛かっていれば、そのルビを直す相手にする。
   * 何も選んでいなければ、いまの記法の書き方を知らせるだけ。
   */
  rubyTarget(pick?: HTMLElement): { target: RubyTarget | null; message: string } {
    const forms = this.forms;
    if (!forms) return { target: null, message: "記法をまだ読み込めていません" };
    const hint = `ルビの書き方: ${rubySource(forms, "漢字", "かんじ")}`;
    const ask = `${hint}　親文字を選んで Ctrl+R`;

    // ルビそのものを指されたとき（読みをクリックしたなど）
    if (pick) {
      const para = paraOf(this.paper, pick);
      if (!para) return { target: null, message: ask };
      const segs = readSegments(para);
      const seg = segs.find((x) => x.atom === pick);
      if (!seg?.atom) return { target: null, message: ask };
      return this.aimRuby(para, seg.atom, seg.start, seg.end);
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { target: null, message: ask };
    const range = sel.getRangeAt(0);
    if (!this.paper.contains(range.startContainer)) return { target: null, message: ask };

    const para = paraOf(this.paper, range.startContainer);
    if (!para || para !== paraOf(this.paper, range.endContainer)) {
      return { target: null, message: "ルビは段落をまたげません" };
    }

    const segs = readSegments(para);
    const from = srcOffsetAt(para, segs, range.startContainer, range.startOffset, "start");
    const to = srcOffsetAt(para, segs, range.endContainer, range.endOffset, "end");
    if (from === null || to === null) return { target: null, message: ask };

    // すでにルビが掛かっているところなら、その読みを直す
    const seg = segs.find((x) => x.atom?.tagName === "RUBY" && from < x.end && to > x.start);
    if (seg?.atom) return this.aimRuby(para, seg.atom, seg.start, seg.end);

    const start = Math.max(from, headingEnd(segs));
    if (start >= to) return { target: null, message: ask };
    if (!plainOnly(segs, start, to)) {
      return { target: null, message: "ルビや傍点を含む範囲には振れません" };
    }

    const line = this.lineOf(para);
    this.rubySpot = {
      index: Array.from(this.paper.children).indexOf(para),
      start,
      end: to,
      base: line.slice(start, to),
    };
    return {
      target: { base: this.rubySpot.base, reading: "", rect: range.getBoundingClientRect() },
      message: "",
    };
  }

  /** 既にあるルビを直す相手として覚える。 */
  private aimRuby(
    para: HTMLElement,
    atom: HTMLElement,
    start: number,
    end: number,
  ): { target: RubyTarget | null; message: string } {
    const base = rubyBase(atom);
    this.rubySpot = {
      index: Array.from(this.paper.children).indexOf(para),
      start,
      end,
      base,
    };
    return {
      target: { base, reading: rubyReading(atom), rect: atom.getBoundingClientRect() },
      message: "",
    };
  }

  /**
   * 覚えた相手にルビを振る。読みが空ならルビを外す。
   *
   * 小窓へ移ったあいだに本文の選択は失われているので、場所は
   * `rubyTarget()` で覚えたものを使う。
   */
  async applyRuby(reading: string): Promise<CommandResult> {
    const forms = this.forms;
    const spot = this.rubySpot;
    this.rubySpot = null;
    if (!forms || !spot) return { message: "ルビを振る場所が分かりません", changed: false };

    const para = this.paper.children[spot.index] as HTMLElement | undefined;
    if (!para) return { message: "ルビを振る場所が分かりません", changed: false };

    const line = this.lineOf(para);
    if (spot.end > line.length || line.slice(spot.start, spot.end).length === 0) {
      return { message: "本文が変わりました。選び直してください", changed: false };
    }

    const src = rubySource(forms, spot.base, reading.trim());
    const next = line.slice(0, spot.start) + src + line.slice(spot.end);
    this.paper.focus();
    await this.replaceLine(para, next, spot.start, spot.start + src.length);
    return {
      message: reading.trim() ? "ルビを振りました" : "ルビを外しました",
      changed: true,
    };
  }

  /** ルビの小窓を閉じただけのときに呼ぶ。 */
  cancelRuby(): void {
    this.rubySpot = null;
  }

  /**
   * 選んだ文字に傍点を付ける、または外す。
   *
   * すでに傍点が掛かっていれば外す。どう書くかは Rust の表が決める
   * （傍点の書き方がない記法では中黒のルビで代用される）。
   */
  async toggleEmphasis(): Promise<CommandResult> {
    const forms = this.forms;
    if (!forms) return { message: "記法をまだ読み込めていません", changed: false };
    const hint = `傍点の書き方: ${emphasisSource(forms, "文字")}`;

    const spot = this.selection();
    if (!spot) return { message: `${hint}　文字を選んで Ctrl+B`, changed: false };

    const edit = await toggleEmphasisAt(spot.line, spot.start, spot.end, this.notation);
    if (!edit) return { message: "ルビを含む範囲には傍点を付けられません", changed: false };

    await this.replaceLine(spot.para, edit.text, edit.start, edit.end);
    const added = edit.text.length > spot.line.length;
    return { message: added ? "傍点を付けました" : "傍点を外しました", changed: true };
  }

  /**
   * いま選んでいるところを、記法テキストの上の範囲として返す。
   *
   * 段落をまたぐ選択は受けない。ルビの一部だけを選んでいたら、
   * ルビ全体を選んだものとして扱う（記法の途中では切れない）。
   * 行頭の見出し記号には掛けない。掛けると見出しでなくなる。
   */
  private selection(): {
    para: HTMLElement;
    segs: Segment[];
    line: string;
    start: number;
    end: number;
  } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    if (!this.paper.contains(range.startContainer)) return null;

    const para = paraOf(this.paper, range.startContainer);
    if (!para || para !== paraOf(this.paper, range.endContainer)) return null;

    const segs = readSegments(para);
    const from = srcOffsetAt(para, segs, range.startContainer, range.startOffset, "start");
    const to = srcOffsetAt(para, segs, range.endContainer, range.endOffset, "end");
    if (from === null || to === null) return null;

    const start = Math.max(from, headingEnd(segs));
    if (start >= to) return null;
    return { para, segs, line: this.lineOf(para), start, end: to };
  }

  /** 段落一つ分の記法テキスト。 */
  private lineOf(para: HTMLElement): string {
    return this.mode === "preview" ? readPreviewPara(para, this.forms) : (para.textContent ?? "");
  }

  /**
   * 段落を書き直し、直した範囲を選び直す。
   *
   * プレビューでは部品に分け直してから組み立てる。記法テキストを
   * そのまま入れると記号が見えてしまう。
   */
  private async replaceLine(
    para: HTMLElement,
    line: string,
    start: number,
    end: number,
  ): Promise<void> {
    const next =
      this.mode === "preview"
        ? buildPreviewPara(await linePieces(line, this.notation))
        : createPara(line);
    para.replaceWith(next);

    const range = domRange(next, start, end);
    if (range) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }

    // 段落を作り直したので、送り直して ID を振り直させる
    this.lastSent = null;
    this.schedule();
  }

  /**
   * すべての段落のマーカーを取り直して描き直す。
   *
   * `analyze_pending` は未解析の段落しか返さない。本文を変えずに
   * 段落の中身だけを作り直したとき（見え方の切り替えなど）は、
   * それでは何も返らずマーカーが消えたままになる。こちらは
   * 解析済みならキャッシュが返るだけなので、呼んでも安い。
   */
  private async refreshMarks(): Promise<void> {
    try {
      const results = await invoke<AnalyzeResult[]>("analyze", { ids: [] });
      this.applyMarks(results);
      this.renderMarks();
    } catch (err) {
      this.events.onStatus?.(`エラー: ${String(err)}`, true);
    }
  }

  /**
   * DOM の内容を Rust に送り、未解析の段落を解析してマーカーを更新する。
   *
   * Rust 側の set_text は「同じ位置に同じ本文の段落があれば Index と
   * 解析結果を引き継ぐ」ので、全文を送っても再解析されるのは
   * 編集された段落だけで済む。
   */
  async sync(): Promise<void> {
    // IME 変換中は未確定文字列が DOM に入っている。この状態で送ると
    // 変換前のひらがなを解析することになり、同じ文でもマーカーが
    // 変わってしまう。確定するまで待つ。
    if (this.composing) {
      this.dirty = true;
      return;
    }
    if (this.syncing) {
      // 実行中に来た変更は、終わってからもう一度回す
      this.schedule();
      return;
    }
    this.syncing = true;
    this.dirty = false;

    try {
      // ブラウザが構造を壊していたら直す。
      // プレビューでは段落の中にルビの塊が入っているので、
      // 構造を直そうとするとそれを潰してしまう。触らない。
      if (this.mode === "source" && normalizeStructure(this.paper)) {
        this.events.onStatus?.("段落の構造を修復しました");
      }

      const text = this.text();
      if (text === this.lastSent) {
        this.renderMarks();
        return;
      }
      this.lastSent = text;

      const t0 = performance.now();
      const views = await invoke<ParaView[]>("set_text", { text });
      this.attachIds(views);

      // DOM の本文と Rust 側の本文がずれていないか検算する。
      // ここがずれるとマーカーの位置が狂い、別の語に線が付いて見える。
      // 過去にゼロ幅スペースの混入で実際に起きたので、常時見張る。
      const mismatch = this.verify(views);
      if (mismatch) {
        this.marker.clear();
        // lastSent はすでに更新されているので、このまま戻ると
        // 次回「変化なし」と判断され、マーカーが二度と復活しない。
        // 送信済みの記録を捨てて、構造を直したうえでやり直す。
        // 直らないまま繰り返しても仕方がないので回数で打ち切る。
        this.lastSent = null;
        this.mismatchRetries += 1;
        if (this.mismatchRetries <= MISMATCH_RETRY_LIMIT) {
          this.events.onStatus?.(`本文の不一致を修復中: ${mismatch}`);
          const caret = caretOffset(this.paper);
          if (this.mode === "preview") {
            // プレビューでは textContent にルビの読みまで入る。
            // readText で組み直すと読みが本文に混ざってルビが壊れる。
            // Rust には送信済みの本文が入っているので、そこから
            // 部品をもらって並べ直す。
            await this.buildPreview();
          } else {
            // 本文を読み直して組み立て直す。readText は段落を \n で繋ぎ、
            // writeText はそれを \n で割るので、段落内に残っていた
            // 生の改行がここで確実に段落の切れ目になる。
            writeText(this.paper, readText(this.paper));
          }
          this.resetHistory();
          if (caret !== null) setCaretOffset(this.paper, caret);
          this.schedule();
        } else {
          this.events.onStatus?.(`本文の不一致が直りません: ${mismatch}`, true);
        }
        return;
      }
      this.mismatchRetries = 0;

      // 送った本文が通ったので、手が入った塊の data-* を今の中身に
      // 揃える。放っておくと data-src が古いままになり、マーカーの
      // 位置合わせ（segment.ts）がずれる。
      if (this.mode === "preview") commitPreviewEdits(this.paper, this.forms);

      const results = await invoke<AnalyzeResult[]>("analyze_pending");
      this.applyMarks(results);
      this.renderMarks();

      const ms = performance.now() - t0;
      this.events.onStatus?.(
        results.length
          ? `${results.length} 段落を解析（${ms.toFixed(0)}ms）`
          : `更新（${ms.toFixed(0)}ms）`,
      );
    } catch (err) {
      this.events.onStatus?.(`エラー: ${String(err)}`, true);
    } finally {
      this.syncing = false;
      // 解析に失敗しても文字数などの表示は更新する
      this.events.onSynced?.();
      if (this.dirty) this.schedule();
    }
  }

  /**
   * Rust から返った段落 ID を DOM 要素に振り直す。
   *
   * 要素そのものやテキストには触らない。触るとキャレットが飛ぶ。
   */
  private attachIds(views: ParaView[]): void {
    const els = Array.from(this.paper.children) as HTMLElement[];
    const seen = new Set<string>();

    for (let i = 0; i < els.length && i < views.length; i++) {
      const id = views[i].id;
      els[i].dataset.slot = String(id.slot);
      els[i].dataset.gen = String(id.gen);
      seen.add(idKey(id));
    }

    // 消えた段落のマーカーを捨てる
    for (const key of this.markerKeys()) {
      if (!seen.has(key)) {
        const [slot, gen] = key.split(":").map(Number);
        this.marker.remove({ slot, gen });
      }
    }
  }

  private markerKeys(): string[] {
    const keys: string[] = [];
    for (const el of Array.from(this.paper.children) as HTMLElement[]) {
      const slot = el.dataset.slot;
      const gen = el.dataset.gen;
      if (slot !== undefined && gen !== undefined) keys.push(`${slot}:${gen}`);
    }
    return keys;
  }

  /** 解析結果を段落 ID に紐づける。DOM 要素は描画時に引き直される。 */
  private applyMarks(results: AnalyzeResult[]): void {
    for (const r of results) this.marker.set(r.id, r.marks);
  }

  /**
   * DOM の段落と Rust 側の段落が一字一句一致しているかを確かめる。
   *
   * マーカーの位置は Rust が返したオフセットで決まるので、
   * DOM 側に余計な文字（かつてのゼロ幅スペースなど）が混ざると
   * 線がずれた語に付く。ずれたら黙って表示するより止めた方がよい。
   *
   * 一致していれば null、していなければ理由を返す。
   */
  private verify(views: ParaView[]): string | null {
    const els = Array.from(this.paper.children) as HTMLElement[];
    if (els.length !== views.length) {
      return `段落数 DOM ${els.length} / モデル ${views.length}`;
    }
    for (let i = 0; i < els.length; i++) {
      // プレビューでは textContent にルビの読みまで入ってしまうので、
      // 記法テキストに戻したうえで見比べる
      const a =
        this.mode === "preview"
          ? readPreviewPara(els[i], this.forms)
          : (els[i].textContent ?? "");
      if (a !== views[i].text) {
        return `${i + 1} 段落目（DOM ${a.length} 字 / モデル ${views[i].text.length} 字）`;
      }
    }
    return null;
  }

  /** 段落 ID の一覧（デバッグ・テスト用）。 */
  paraIds(): ParaId[] {
    return (Array.from(this.paper.children) as HTMLElement[])
      .filter((el) => el.dataset.slot !== undefined)
      .map((el) => ({ slot: Number(el.dataset.slot), gen: Number(el.dataset.gen) }));
  }
}
