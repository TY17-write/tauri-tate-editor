/**
 * 縦書きのスクロール制御。
 *
 * 実測で分かったこと:
 *  ・Chromium は縦書き要素の上でも縦ホイールを横スクロールに変換しない。
 *    放っておくとページ全体が上下するので、自前で変換する。
 *  ・scrollLeft の原点と符号は環境によって異なる。scrollIntoView の
 *    inline:"start" も期待どおり右端へ寄らなかった。
 *    そこで起動時に一度だけ符号を実測して持っておく。
 */

export class VerticalScroller {
  /** scrollLeft を増やすと読み進む向きなら +1、逆なら -1 */
  private sign = 1;
  /** ホイールをページ単位で送るか */
  pageWise = false;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly pageWidth: () => number,
  ) {
    this.detectSign();
    this.bindWheel();
  }

  /** scrollLeft の増加方向を実測する。 */
  private detectSign(): void {
    const before = this.viewport.scrollLeft;
    this.viewport.scrollLeft = before + 10;
    if (this.viewport.scrollLeft > before) {
      this.sign = 1;
    } else {
      this.viewport.scrollLeft = before - 10;
      this.sign = this.viewport.scrollLeft < before ? -1 : 1;
    }
    this.viewport.scrollLeft = before;
  }

  private bindWheel(): void {
    this.viewport.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey) return; // 拡大縮小は邪魔しない
        const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (d === 0) return;

        const before = this.viewport.scrollLeft;
        const delta = this.pageWise ? Math.sign(d) * this.pageWidth() : d;
        this.viewport.scrollLeft = before + this.sign * delta;

        // 端まで来たらページ側のスクロールに譲る
        if (this.viewport.scrollLeft !== before) e.preventDefault();
      },
      { passive: false },
    );
  }

  /** ページ単位で送る。dir は +1 で次ページ、-1 で前ページ。 */
  movePage(dir: number): void {
    this.viewport.scrollLeft += this.sign * dir * this.pageWidth();
  }

  /** 本文の先頭（右端）へ。 */
  toHead(): void {
    this.viewport.scrollLeft = this.sign > 0 ? 0 : this.viewport.scrollWidth;
  }

  // 任意の要素へジャンプする処理（検索・章移動）は未実装。
  // 縦書きでは scrollIntoView が期待どおりに動かず、scrollLeft の
  // 物理的な移動方向も環境依存のため、実装時に実機で測る必要がある。
  // detectSign が見ているのは「scrollLeft に正の値を足せるか」だけで、
  // 内容がどちらへ動くかまでは測っていない点に注意。
}
