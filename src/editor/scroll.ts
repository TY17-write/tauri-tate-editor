/**
 * 縦書きのスクロール制御。
 *
 * 実測で分かったこと:
 *  ・Chromium は縦書き要素の上でも縦ホイールを横スクロールに変換しない。
 *    放っておくとページ全体が上下するので、自前で変換する。
 *  ・scrollLeft の原点と符号は環境によって異なる。scrollIntoView の
 *    inline:"start" も期待どおり右端へ寄らなかった。
 *
 * そこで「scrollLeft を増やしたとき、中身が画面上でどちらへ何 px 動くか」
 * を起動時に一度実測し、以降はその比率で換算する。これなら原点や符号の
 * 違いを気にせず、画面上の座標だけで考えられる。
 */

export class VerticalScroller {
  /**
   * scrollLeft を 1 増やしたときに、中身が画面上で動く量(px)。
   * 縦書きでは普通 -1（scrollLeft を増やすと中身が左へ動く）。
   */
  private contentPerScroll = -1;
  /** ホイールをページ単位で送るか */
  pageWise = false;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly pageWidth: () => number,
  ) {
    this.calibrate();
    this.bindWheel();
  }

  /**
   * scrollLeft と画面上の動きの関係を実測する。
   *
   * 内容がスクロールできる状態でないと測れないので、呼べる状況に
   * なってからもう一度呼び直せるようにしてある。
   */
  calibrate(): boolean {
    const probe = this.viewport.firstElementChild as HTMLElement | null;
    if (!probe) return false;

    const before = this.viewport.scrollLeft;
    const x0 = probe.getBoundingClientRect().left;

    // 正方向に動かしてみて、駄目なら負方向を試す
    let step = 20;
    this.viewport.scrollLeft = before + step;
    let moved = this.viewport.scrollLeft - before;
    if (moved === 0) {
      step = -20;
      this.viewport.scrollLeft = before + step;
      moved = this.viewport.scrollLeft - before;
    }
    if (moved === 0) {
      this.viewport.scrollLeft = before;
      return false; // スクロールできる余地がない
    }

    const x1 = probe.getBoundingClientRect().left;
    this.viewport.scrollLeft = before;

    const ratio = (x1 - x0) / moved;
    if (Number.isFinite(ratio) && ratio !== 0) this.contentPerScroll = ratio;
    return true;
  }

  private bindWheel(): void {
    this.viewport.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey) return; // 拡大縮小は邪魔しない
        const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (d === 0) return;

        const before = this.viewport.scrollLeft;
        const amount = this.pageWise ? Math.sign(d) * this.pageWidth() : d;
        // 下に回したら読み進む向きへ。読み進むとは中身が左へ動くこと
        this.moveContent(-amount);

        // 端まで来たらページ側のスクロールに譲る
        if (this.viewport.scrollLeft !== before) e.preventDefault();
      },
      { passive: false },
    );
  }

  /** 中身を画面上で dx px 動かす（正で右へ）。 */
  private moveContent(dx: number): void {
    this.viewport.scrollLeft += dx / this.contentPerScroll;
  }

  /** ページ単位で送る。dir は +1 で次ページ、-1 で前ページ。 */
  movePage(dir: number): void {
    this.moveContent(-dir * this.pageWidth());
  }

  /** 本文の先頭（右端）へ。 */
  toHead(): void {
    // 十分大きく動かして端に当てる。原点や符号を知らなくても済む
    this.moveContent(this.viewport.scrollWidth + this.viewport.clientWidth);
  }

  /** 本文の末尾（左端）へ。 */
  toTail(): void {
    this.moveContent(-(this.viewport.scrollWidth + this.viewport.clientWidth));
  }

  /**
   * 画面上の矩形が見えるところまでスクロールする。
   *
   * 検索結果へ飛ぶときに使う。すでに見えていれば動かさない。
   */
  reveal(rect: DOMRect, margin = 48): void {
    const view = this.viewport.getBoundingClientRect();
    let dx = 0;
    if (rect.right > view.right - margin) {
      dx = view.right - margin - rect.right; // 中身を左へ
    } else if (rect.left < view.left + margin) {
      dx = view.left + margin - rect.left; // 中身を右へ
    }
    if (dx !== 0) this.moveContent(dx);
  }

  /** Range が見えるところまでスクロールする。 */
  revealRange(range: Range, margin = 48): void {
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    this.reveal(rect, margin);
  }
}
