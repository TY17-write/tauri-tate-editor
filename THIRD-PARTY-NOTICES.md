# 第三者ソフトウェアの表示

本ソフトウェアには、以下の第三者による成果物が含まれています。

## UniDic (unidic-mecab 2.1.2)

形態素解析の辞書として、UniDic を実行ファイルに埋め込んでいます
（`lindera-unidic` クレート経由）。

配布元: <https://unidic.ninjal.ac.jp/>

UniDic は BSD 3-Clause ライセンスで提供されており、バイナリ形式で再配布する
場合には以下の表示を添えることが求められています。

```
Copyright (c) 2011-2017, The UniDic Consortium
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

 * Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.

 * Neither the name of the UniDic Consortium nor the names of its
   contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 主な依存ライブラリ

いずれも MIT または Apache-2.0（あるいはその両方）で提供されています。

| ライブラリ | 用途 | ライセンス |
|---|---|---|
| [Tauri](https://tauri.app/) | アプリケーションの枠組み | MIT / Apache-2.0 |
| [Lindera](https://github.com/lindera/lindera) | 形態素解析 | MIT |
| [thunderdome](https://github.com/LPGhatguy/thunderdome) | 世代付きアリーナ | MIT / Apache-2.0 |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | 文字コードの判定 | MIT / Apache-2.0 |
| [regex](https://github.com/rust-lang/regex) | 記法の解析 | MIT / Apache-2.0 |
| [serde](https://serde.rs/) | 受け渡しの直列化 | MIT / Apache-2.0 |
| [once_cell](https://github.com/matklad/once_cell) | 辞書の常駐 | MIT / Apache-2.0 |
| [Vite](https://vite.dev/) | フロントエンドの構築 | MIT |

各ライブラリの全文は、それぞれの配布元を参照してください。
