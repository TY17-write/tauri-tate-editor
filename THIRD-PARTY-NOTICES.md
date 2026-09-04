# 第三者ソフトウェアの表示

本ソフトウェアには、以下の第三者による成果物が含まれています。
辞書データはいずれも実行ファイルに埋め込んで再配布しています。

## SudachiDict（sudachidict-20260723）

形態素解析の辞書として、SudachiDict を実行ファイルに埋め込んでいます
（`lindera-sudachidict` クレート経由。埋め込む辞書のアーカイブは
`sudachidict-20260723.tar.gz`）。

配布元: <https://github.com/WorksApplications/SudachiDict>

SudachiDict は Apache License 2.0 で提供されています（全文は末尾の
「Apache License 2.0」を参照）。

```
Copyright (c) 2017-2023 Works Applications Co., Ltd.
```

SudachiDict には UniDic と mecab-ipadic-NEologd の一部が含まれています。
それぞれの表示は次のとおりです。

### UniDic（SudachiDict の構成要素）

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

### mecab-ipadic-NEologd（SudachiDict の構成要素）

配布元: <https://github.com/neologd/mecab-ipadic-neologd>

mecab-ipadic-NEologd は Apache License 2.0 で提供されています。

```
Copyright (c) 2015-2019 Toshinori Sato (@overlast)
```

## Sudachi 同義語辞書（`src-tauri/assets/synonyms.txt`）

類義語検索の「言い換え」の候補を引くために、Sudachi 同義語辞書を
実行ファイルに埋め込んでいます。

配布元: <https://github.com/WorksApplications/SudachiDict>（`synonyms.txt`）

Sudachi 同義語辞書は SudachiDict と同じく Apache License 2.0 で
提供されています。

```
Copyright (c) 2017-2023 Works Applications Co., Ltd.
```

## 日本語 WordNet（`src-tauri/assets/wnjpn-ok.tab`, `wnjpn-links.tsv`）

類義語検索の「同義」「近い意味」の候補を引くために、日本語 WordNet の
語と概念の対応表（`wnjpn-ok.tab`）と、概念のつながりを `wnjpn.db` から
抜き出した表（`wnjpn-links.tsv`）を実行ファイルに埋め込んでいます。

配布元: <https://bond-lab.github.io/wnja/>

日本語 WordNet は以下の条件で提供されており、複製物にはこの表示を
添えることが求められています（原文は `src-tauri/assets/wnja-LICENSE.txt`）。

```
Copyright: 2021-2024 Francis Bond, Takayuki Kuribayashi
Copyright: 2018-2020 Francis Bond
Copyright: 2016-2017 Francis Bond, Takayuki Kuribayashi
Copyright: 2012-2015 Francis Bond
Copyright: 2009-2011 NICT

Japanese WordNet

This software and database is being provided to you, the LICENSEE, by
the National Institute of Information and Communications Technology
under the following license.  By obtaining, using and/or copying this
software and database, you agree that you have read, understood, and
will comply with these terms and conditions:

  Permission to use, copy, modify and distribute this software and
  database and its documentation for any purpose and without fee or
  royalty is hereby granted, provided that you agree to comply with
  the following copyright notice and statements, including the
  disclaimer, and that the same appear on ALL copies of the software,
  database and documentation, including modifications that you make
  for internal use or for distribution.

THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND NICT MAKES NO
REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED.  BY WAY OF EXAMPLE,
BUT NOT LIMITATION, NICT MAKES NO REPRESENTATIONS OR WARRANTIES OF
MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE
OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT INFRINGE
ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.

The name of the National Institute of Information and Communications
Technology may not be used in advertising or publicity pertaining to
distribution of the software and/or database.  Title to copyright in
this software, database and any associated documentation shall at all
times remain with National Institute of Information and Communications
Technology and LICENSEE agrees to preserve same.
```

### Princeton WordNet 3.0（日本語 WordNet の基礎データ）

日本語 WordNet は Princeton WordNet 3.0 の概念（synset）と概念間の
関係を土台にしています。本ソフトウェアが埋め込む概念番号と
「上位・下位」「類似」のつながりは Princeton WordNet 3.0 に由来するため、
その表示も添えます。

配布元: <https://wordnet.princeton.edu/>

```
WordNet Release 3.0

This software and database is being provided to you, the LICENSEE, by
Princeton University under the following license.  By obtaining, using
and/or copying this software and database, you agree that you have
read, understood, and will comply with these terms and conditions.:

Permission to use, copy, modify and distribute this software and
database and its documentation for any purpose and without fee or
royalty is hereby granted, provided that you agree to comply with
the following copyright notice and statements, including the
disclaimer, and that the same appear on ALL copies of the software,
database and documentation, including modifications that you make for
internal use or for distribution.

WordNet 3.0 Copyright 2006 by Princeton University.  All rights
reserved.

THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON
UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON UNIVERSITY
MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE LICENSED SOFTWARE,
DATABASE OR DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY PATENTS,
COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.

The name of Princeton University or Princeton may not be used in
advertising or publicity pertaining to distribution of the software
and/or database.  Title to copyright in this software, database and
any associated documentation shall at all times remain with Princeton
University and LICENSEE agrees to preserve same.
```

## 主な依存ライブラリ

いずれも MIT または Apache-2.0（あるいはその両方）で提供されています。

| ライブラリ | 用途 | ライセンス |
|---|---|---|
| [Tauri](https://tauri.app/) | アプリケーションの枠組み | MIT / Apache-2.0 |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | ファイルダイアログ | MIT / Apache-2.0 |
| [tauri-plugin-opener](https://github.com/tauri-apps/plugins-workspace) | 外部リンクを開く | MIT / Apache-2.0 |
| [Lindera](https://github.com/lindera/lindera) | 形態素解析 | MIT |
| [thunderdome](https://github.com/LPGhatguy/thunderdome) | 世代付きアリーナ | MIT / Apache-2.0 |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | 文字コードの判定 | MIT / Apache-2.0 |
| [regex](https://github.com/rust-lang/regex) | 記法の解析 | MIT / Apache-2.0 |
| [serde](https://serde.rs/) / serde_json | 受け渡しの直列化 | MIT / Apache-2.0 |
| [once_cell](https://github.com/matklad/once_cell) | 辞書の常駐 | MIT / Apache-2.0 |
| [fontdb](https://github.com/RazrFalcon/fontdb) | インストール済み書体の列挙 | MIT |
| [ttf-parser](https://github.com/RazrFalcon/ttf-parser) | 書体の日本語対応の判定 | MIT / Apache-2.0 |
| [Vite](https://vite.dev/) | フロントエンドの構築 | MIT |

各ライブラリの全文は、それぞれの配布元を参照してください。

## Apache License 2.0

SudachiDict・Sudachi 同義語辞書・mecab-ipadic-NEologd に適用される
ライセンスの全文です。

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```
