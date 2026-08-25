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
  insertTextAtCaret,
  normalizeStructure,
  readText,
  setCaretOffset,
  splitAtCaret,
  writeText,
} from "./dom";
import { MarkerLayer } from "./marker";
import { idKey } from "./types";
import type { AnalyzeResult, ParaId, ParaView } from "./types";

/** 入力が止まってから解析を投げるまでの待ち時間(ms)。 */
const DEBOUNCE_MS = 250;

/** 本文の不一致を検知したときに、構造を直して再挑戦する回数の上限。 */
const MISMATCH_RETRY_LIMIT = 3;

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
   * 傍線（右）は DOM に span を挿すためキャレットが飛ぶ。
   * 本文の先頭からの文字オフセットで保存して戻す。
   */
  renderMarks(): void {
    if (!this.marker.usesDom) {
      this.marker.render();
      return;
    }
    if (this.composing) return;

    const focused = document.activeElement === this.paper;
    const caret = focused ? caretOffset(this.paper) : null;
    this.marker.render();
    if (caret !== null) setCaretOffset(this.paper, caret);
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

  /** 現在の本文。 */
  text(): string {
    return readText(this.paper);
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
      // ブラウザが構造を壊していたら直す
      if (normalizeStructure(this.paper)) {
        this.events.onStatus?.("段落の構造を修復しました");
      }

      const text = readText(this.paper);
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
          // 本文を読み直して組み立て直す。readText は段落を \n で繋ぎ、
          // writeText はそれを \n で割るので、段落内に残っていた
          // 生の改行がここで確実に段落の切れ目になる。
          const caret = caretOffset(this.paper);
          writeText(this.paper, readText(this.paper));
          this.resetHistory();
          if (caret !== null) setCaretOffset(this.paper, caret);
          this.schedule();
        } else {
          this.events.onStatus?.(`本文の不一致が直りません: ${mismatch}`, true);
        }
        return;
      }
      this.mismatchRetries = 0;

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
      const a = els[i].textContent ?? "";
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
