# LIGHT TEST

pointLight が XRift のアバター (VRM / MToon) を照らすかを実機で判定するだけの検証用ワールド。KALEID DOME とは別ワールドとしてアップロードする (上書きしないこと)。

## 問い

2026-11-11 にユーザーが聞いた「xriftってアバターを照らすライトをpoint lightみたいにして、動的に制御できる？」への回答を、文献ではなく実機で決める。MToon が directional + 環境光のみという説があり、Web 検索では決着がつかなかった。

## 仕組み

| 要素 | 実装 |
| --- | --- |
| 検証対象 | `pointLight` 1個。`useUsers().getLocalMovement()` で自分のアバター位置に追従 (高さ 2.2m 固定)。色 `#ffd9a0`、強さ 40、distance 12、decay 2 (three r155+ の物理単位)。強さ・色は一定で、明るさの変化が位置だけに起因する |
| 対照物 | `meshStandardMaterial` の床・奥の壁・球5個 (x = -4, -2, 0, 2, 4)。これらは point light を確実に受けるので「ライト自体が動いているか」の確認になる |
| 光源マーカー | ライトと同位置の小球 (`meshBasicMaterial` = ライトを受けない)。位置の目印であって、判定には使わない |
| 全体光 | わざと暗く: ambient 0.12 / directional 0.25。point light の効果が見えやすくするため |

## 判定手順 (XRift 上で 1 回入れば終わる)

1. アップロードして入室。できれば他の人にも入ってもらう (他人のアバターで見るため)。
2. 球の列に沿って歩く。**球・床・壁が近づくと明るくなるか** → Yes ならライト自体は機能している (A 成立)。
3. 自分のアバターと、近くにいる他人のアバターを見る。**ライトが近づくと服・肌が明るくなるか** (B)。
   - A のみ成立 → アバターは point light を受けない。代替案: directional / ambient の動的制御、発光マテリアルやグローのビルボードによる「照らされてる風」の演出。
   - A + B 成立 → point light でアバターを照らせる。KALEID DOME 等への組み込みに進める (Quest 前提なら 1〜3 個まで)。
4. 結果をこの README に 1 行で追記する。

## 実行

```powershell
cd public/Light_Test
npm run dev        # http://127.0.0.1:5177/ (全景プレビュー / 歩行プレビュー切替)
npm run typecheck
npm run build      # dist/ に remoteEntry.js を出力
npx @xrift/cli upload world   # 新規ワールドとして登録される。KALEID DOME は上書きしない
```

## 注意

- `public/thumbnail.png` は KALEID DOME のものを仮コピーしている。アップロード前にこのワールドのキャプチャに差し替えること。
- KALEID DOME とは完全に分離した独立プロジェクト (依存も共有しない。独自の `node_modules` / `package-lock.json` を持つ)。
- 未コミット・未アップロードのローカル作業。アップロードとコミットはユーザーの判断で行う。
