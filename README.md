# ゆっくり生態観察ゲーム（試作）

> **テスト版・作成中です。** 見た目・動き・操作は今後大きく変わります。不具合や未完成の部分が残っています。
> 中断中の作業と既知の問題は [NOTES.md](NOTES.md) にまとめてあります。

「東方Project」の二次創作です。原作（上海アリス幻樂団）とは関係のない、個人のファン活動として作っています。
東方Projectの[二次創作ガイドライン](https://touhou-project.news/guideline/)に沿って、無料で公開します。

## ダウンロード（遊ぶ人向け）

[BOOTH（無料）](https://jinominayama.booth.pm/items/9005769) で配布しています。商品ページは年齢確認があります。
プログラム（コード）は AI（Anthropic の Claude）を使って書いています。画像生成 AI は使っていません。

Three.js + TypeScript + Vite。最終的に Tauri でデスクトップアプリ化する予定。

## 起動（開発）

```bash
npm install
npm run dev
```

## テスト版の配布物を作る

```bash
npm run release
```

`release/yukkuri-sim-test-v<版>/` と、それをまとめた zip ができる。中身は次の2つ。

| ファイル | 内容 |
|---|---|
| `ゆっくり観察.html` | JS をすべて埋め込んだ1つの HTML。ダブルクリックでブラウザが開いて動く（インストール不要・オフラインで動く） |
| `はじめにお読みください.txt` | 遊ぶ人向けの説明（テスト版である旨・操作・既知の不具合）。元は `release-readme.txt` |

- 普通のビルド（`dist/`）は JS が別ファイルなので、HTML を直接開くとブラウザに読み込みを止められる。
  `scripts/make-release.mjs` がビルド結果を1つの HTML にまとめる。
- 版を上げるときは `package.json` の `version` を変える。
- 初めて開いた人（保存した設定がない人）は魔理沙で始まる（`src/yukkuri/Yukkuri.ts` の `FIRST_CHARACTER`）。

## 構成

| パス | 役割 |
|---|---|
| `src/main.ts` | シーン・カメラ・描画ループ |
| `src/yukkuri/Yukkuri.ts` | ゆっくり1体の見た目（描画層） |
| `src/yukkuri/bodyShape.ts` | 体の静止形状（卵形・下ぶくれ・平らな底・傾き） |
| `src/yukkuri/skin.ts` | 細かい描画メッシュを粗い物理メッシュに追従させる |
| `src/physics/SoftBody.ts` | XPBD ソフトボディ（描画に依存しない）。体の「筋肉」入力 actuation を持つ |
| `src/yukkuri/locomotion.ts` | 移動の制御（状態遷移で伸縮・前傾・向きを動かす） |
| `src/render/toonMaterial.ts` | 3段トゥーン＋縁の光 |
| `src/render/outlineMaterial.ts` | 背面法の輪郭線（画面上で一定の太さ） |
| `src/render/blobShadow.ts` | 足元の丸い影 |
| `src/debug/gui.ts` | 調整パネル（lil-gui） |
| `src/yukkuri/presets.ts` | 体型プリセット（ユーザー設定・ボール型〜いもむし型）。保存は各プリセットへの上書き |
| `src/face/` | 顔（表情 × 絵柄）。キャンバスに描いて体に貼る |
| `src/character/` | キャラクターの装飾（髪・帽子・三つ編みなど）。体の表面に追従する |
| `src/platform/storage.ts` | 設定の保存先（ブラウザ版は localStorage、デスクトップ版で差し替え） |

## 表情・絵柄の追加方法

顔は「表情（どのパーツをどの形にするかのデータ）」と「絵柄（パーツの描き方）」に分かれている。
表情はパーツ（目・眉・口・頬・涙の粒・涙の筋・汗・しわ）ごとに選んだ選択肢の組み合わせで、パーツごとに左右反転もできる。
開発中は画面左上の「表情（パーツ選択）」窓で、ボタンを押して選べる（選択は保存され、次回も引き継ぐ）。
座標は顔座標（頭の正面が原点、単位は頭の半径、y が上）。

| ファイル | 役割 |
|---|---|
| `src/face/types.ts` | 型の定義。パーツの種類（目・眉・口の kind）の一覧もここ |
| `src/face/parts.ts` | パーツと選択肢の一覧（データ）。パーツ選択画面のボタンはここから作る |
| `src/face/expressions.ts` | 表情セット（パーツの選択の組み合わせに名前を付けたもの） |
| `src/face/styles/anime.ts` | アニメ調の絵柄。全パーツの描き方を持つ基本の絵柄 |
| `src/face/styles/simple.ts` | シンプルな絵柄（アニメ調を継承し、目の描き方だけ変えた見本） |
| `src/face/styles/index.ts` | 絵柄の一覧 |
| `src/face/Face.ts` | 選択の保持と保存・キャンバスへの描画・まばたき・テクスチャ化 |
| `src/debug/facePanel.ts` | 表情のパーツ選択画面（開発中のみ） |

- **パーツの選択肢を足す**：`parts.ts` の該当パーツの `options` に1件足す（パーツ選択画面にボタンが増える）。
  既存の形の組み合わせ（目の開き具合・まぶたの傾きなど）なら描画の変更は不要。
- **表情セットを足す**：`expressions.ts` の `EXPRESSIONS` に、パーツごとの選択肢の id の組み合わせを1件足す。
  プログラムからは `yukkuri.face.setExpression('id')`（セット）や `yukkuri.face.setPart('mouth', 'grin')`（パーツ単位）で切り替える。
- **パーツの形を足す**（例：新しい口の形）：`types.ts` の `MouthKind` などに名前を足し、
  `anime.ts` の `drawMouth` などに描き方を足す。継承した絵柄は、上書きしなければアニメ調の描き方を使う。
- **絵柄を足す**：`styles/` に `AnimeStyle` を継承したクラスを作り、変えたいパーツのメソッドだけ上書きする
  （配置は `layout`、色は `palette`、線の太さは `lineWidth`）。最後に `styles/index.ts` の `STYLES` に加える。
  まったく別の描き方にする場合は `FaceStyle`（`draw` だけを持つ）を直接実装してもよい。
- 体型ごとの顔の大きさ・高さは、体の形の `faceSize`・`faceHeight` で合わせる。

## キャラクター（髪・帽子など）の追加方法

装飾は「アクセサリー」の集まりで、どれも体の表面の点に追従する。位置は顔と同じ顔座標で指定する。

| ファイル | 役割 |
|---|---|
| `src/character/types.ts` | キャラクター・アクセサリーの型 |
| `src/character/HairShell.ts` | 髪：体の表面から少し浮かせた殻に、髪の形（前髪・横髪）を貼る。変形にそのまま追従 |
| `src/character/WitchHat.ts` | 魔女帽子：頭のまわりの4点から向き・位置を決めて載せる |
| `src/character/Braid.ts` | 三つ編み：体の表面に沿って垂れる編み目の列、リボン、毛先 |
| `src/character/shapes.ts` | 形を作る道具（曲線に沿った管・回転体・リボン） |
| `src/character/marisa.ts` | 魔理沙（髪の形・色、三つ編み、帽子の寸法） |
| `src/character/index.ts` | キャラクターの一覧 |
| `src/character/Outfit.ts` | 選んだキャラクターの装飾を作り、体型の変更・毎フレームの変形に合わせる |

- **キャラクターを足す**：`marisa.ts` を見本に1ファイル作り、`index.ts` の `CHARACTERS` に加える。
  髪は `HairStyle.draw` に前髪・横髪の形を顔座標で描く（mask：髪のある所、lines：毛の線、light：ツヤ）。
- **新しい種類の装飾を足す**（リボン付きのカチューシャ、ナイトキャップなど）：`Accessory` を実装したクラスを作る。
  `rebuild` で静止形状から取り付ける頂点を選び（`ctx.index.nearest(fx, fy)` など）、`update` でその頂点の今の位置・法線に合わせて動かす。

## 進捗

- [x] P1 土台（トゥーン描画・輪郭線・卵形の体・カメラ操作）
- [x] P2 ソフトボディ（XPBD：辺・体積・シェイプマッチング・姿勢保持・地面）
- [x] P3 移動の基本動作（跳ねる・尺取り虫型に這う・向きを変える・目的地へ向かう・うろつく・転倒から起き上がる・腹ばい／仰向けになる）
- [ ] P4 生態の中核（欲求・行動AI・給餌）
