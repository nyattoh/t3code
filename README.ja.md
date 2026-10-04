# T3 Code — Jev 判定版

[English / upstream README](./README.md)

T3 Code は、ローカルのコーディングエージェントを web・desktop・mobile から操作するアプリです。このフォークでは、送信前に **Jev がモデルと reasoning effort の組合せを選び、既存の Codex 実行経路へ渡す**機能を追加しています。Jev は独立した判定サービスで、コード生成を実行するエージェントではありません。

この追加機能は開発中です。モックによる選択・実行境界のテストは合格していますが、実 Jev API、実モデルの実行、実クライアントでの UI 動作、アプリ起動は未検証です。品質・速度・費用の改善を測定した結果はありません。

## 対応範囲

- 自動選択は **選択済みの単一 Codex instance** 内に限定します。別アカウント・別プロバイダーへ自動で切り替えません。
- 自動選択の操作を web の composer に追加しています。desktop は同じ web 実装を使います。mobile の自動選択 UI は追加していません。
- 初期状態は手動選択です。他プロバイダーや mobile の既存の手動経路を利用できます。
- 自動選択は新規の idle turn が対象です。実行中の turn への steer、キュー送信、複数エージェント、compact には適用しません。

## ソースから準備・起動する

このフォークの開発ブランチをチェックアウトして使います。upstream の配布版や `npx t3@latest` に、このフォークの追加機能が含まれるとは限りません。

必要なものは Node.js（リポジトリ指定は `^24.13.1`）、Vite+ の `vp`、インストール・認証済みの Codex です。Vite+ の導入は [元 README](./README.md#install-vp)、Codex の接続は [Codex ガイド](./docs/user/providers-codex.md)を参照してください。リポジトリの package manager 指定は `pnpm@11.10.0` です。

Windows / PowerShell の例です。新しい作業ディレクトリは `D:\develop\works` 配下に作成してください。

```powershell
Set-Location -LiteralPath 'D:\develop\works\t3code'
vp i
vp run dev --home-dir 'D:\develop\works\t3code\.t3'
```

現在の checkout にローカルの `vp` がある場合は、最後の行を次に置き換えられます。

```powershell
.\node_modules\.bin\vp.cmd run dev --home-dir 'D:\develop\works\t3code\.t3'
```

この起動例はまだ実行検証していません。URL・ポートは dev-runner の出力で確認します。開発用データは明示した `.t3` を使い、普段使用している `~/.t3/userdata` を開発サーバーへ指定しないでください。desktop の開発起動は `dev:desktop` に置き換えます。詳しくは [開発・構成ガイド](./docs/internals/overview.md)を参照してください。

## TypeSafe API key を環境変数で渡す

自動選択には、**T3 サーバーを起動するプロセス**の `TYPESAFE_API_KEY` が必要です。リモート環境ではサーバー側に設定します。手動選択にこのキーは不要です。

既に環境変数を設定している場合は、その PowerShell から起動してください。有無だけを確認する例です。値を表示しません。

```powershell
[bool]$env:TYPESAFE_API_KEY
```

未設定のときだけ対話入力する例です。キーをコマンド文字列・README・設定ファイルに書かず、現在のセッションから子サーバープロセスへ渡します。この例では既存の環境変数を変更せず、ここで入力した分だけ終了時に解除します。

```powershell
$jevKeySetHere = $false
$jevSecret = $null
try {
    if (-not $env:TYPESAFE_API_KEY) {
        $jevSecret = Read-Host 'TypeSafe API key' -AsSecureString
        $env:TYPESAFE_API_KEY = [Net.NetworkCredential]::new('', $jevSecret).Password
        $jevKeySetHere = $true
    }
    .\node_modules\.bin\vp.cmd run dev --home-dir 'D:\develop\works\t3code\.t3'
} finally {
    if ($jevKeySetHere) {
        Remove-Item Env:TYPESAFE_API_KEY -ErrorAction SilentlyContinue
    }
    if ($null -ne $jevSecret) {
        $jevSecret.Dispose()
    }
}
```

サーバーは TypeSafe の `https://api.typesafe.ai/v1/systemone` に `jev-latest` の typed Choice を要求します。キーをブラウザへ渡さず、provider 子プロセスとターミナルの起動環境からも除外します。TypeSafe に送るのは、明示入力したタスク要約・選択方針・候補のモデルと options です。コード本文・添付内容・アカウント識別子をこの判定リクエストへ自動追加しません。要約や方針に自分で秘密情報を入力しないでください。

## 手動選択と Jev 自動選択

手動で使う場合は **Manual model** のまま、既存の model picker でモデルと effort を指定して送信します。Jev には問い合わせません。

自動選択する場合は composer の **Manual model** を **Jev automatic** に切り替え、次を入力して idle turn を送信します。

1. **Task summary**：判定用のタスク要約（必須、最大 4,000 文字）。
2. **Selection preference**：選択方針（必須、最大 1,000 文字）。

モデルと effort の一覧を固定で用意する実装ではありません。Codex の `model/list` から得た、その instance で認証・利用可能なモデルの `reasoningEffort` options だけを候補にします。未確認の custom model、prompt injection で代用する effort、他の設定 options を維持できない組合せは除外します。候補は最大 254 組で、それを超える場合や候補がない場合は停止します。

この実装は Choice 判定を利用します。Jev の score / noul 判定を並列に追加する実装ではありません。表示する選択理由は、選ばれた組合せと返却信号からアプリが組み立てた説明であり、Jev が生成した自由文の理由ではありません。

## 失敗・キャンセル・再送

キー欠如、未対応 instance、候補なし、Jev の判定保留・不正応答、通信失敗、既定 10 秒のタイムアウト、選択中の候補変更では、コーディング turn を開始せず失敗を表示します。自動再試行、自動の手動モデルへのフォールバック、より大きいモデルへの昇格はしません。入力を確認して明示的に再送するか、手動へ戻してください。

選択・準備中はキャンセルできます。既に TypeSafe が受理した判定リクエストには料金が発生する可能性があります。実行 RPC を送った後は Cancel を解除し、サーバーの応答待ちを表示します。送信済み turn をこの Cancel で停止する実装ではありません。

選択後も実行受付時に候補と選択 ticket を検証します。他のクライアントが先に turn を開始した場合、Jev 付き送信を自動でキューに入れず拒否します。受理済みの同一リクエストは保存済み digest と既存 receipt で照合し、再送による重複実行や添付の再取得を防ぎます。受理後・準備開始前の中断では、既存 launch の復旧処理へ渡します。未受理・不完全なリクエストでは、サーバー再起動や判定キャッシュ失効後に新たな明示選択が必要になる場合があります。

## 検証状況

| 項目                                                             | 結果                                          |
| ---------------------------------------------------------------- | --------------------------------------------- |
| 関連 12 ファイルの Vitest                                        | 247/247 合格                                  |
| Jev 選択・サービスのモックテスト                                 | 20/20 合格                                    |
| server / web の限定 TypeScript、lint、format、限定 export 検査   | 合格（既存 lint 警告あり）                    |
| 移動後の launch 回帰テスト・選択テスト                           | 45/45、20/20 合格                             |
| 実 Jev API、実モデル、アプリ起動、UI・desktop・mobile の実機確認 | 未実施                                        |
| 既存 `ThreadMessageIntake.test.ts` の Windows パス引用テスト     | 1/12 失敗。変更前の intake でも同じ失敗を再現 |

これらは限定検証です。全リポジトリのテスト合格や、実クライアントでの動作確認を意味しません。UI 検証はリポジトリ指定の T3 Browser ツールがないため実施していません。検証環境の Node.js は 24.13.0 で、指定の 24.13.1 より古いことも残課題です。通常の export 検査設定は mobile Expo SDK の不足で停止したため、限定設定で確認しました。

モックテストを個別に実行する例です。実 API を呼ぶテストではありません。

```powershell
Set-Location -LiteralPath 'D:\develop\works\t3code\apps\server'
node --test scripts/jev-routing.check.ts scripts/jev-routing-service.check.ts
```

```powershell
Set-Location -LiteralPath 'D:\develop\works\t3code'
.\node_modules\.bin\vp.cmd test run apps/server/src/orchestration-v2/ThreadLaunchService.test.ts
```

## upstream との差分とライセンス

この実装のベースは [pingdotgg/t3code](https://github.com/pingdotgg/t3code) の `0fe4fa40fe65ac9545621a65633f08d9fa29fd0d` です。upstream の更新をこの追加機能と統合済みとは限りません。

主な追加は、Jev 判定サービスと RPC、web の手動／自動切替、既存 `ModelSelection` による Codex の model・options 指定、実行 ticket と再送 digest（migration 057）、キーの provider／terminal 環境への流出防止、およびモック・実サービス境界の回帰テストです。既存のプロバイダー実行経路を利用し、新しいコーディング用プロバイダーを追加するものではありません。詳しい利用案内は [Codex ガイド](./docs/user/providers-codex.md#choose-a-model-with-jev)を参照してください。

差分を確認する例：

```powershell
git diff --stat 0fe4fa40fe65ac9545621a65633f08d9fa29fd0d HEAD
```

[MIT License](./LICENSE) です。元の著作権・ライセンス表記を保持しています。依存ソフトウェアにはそれぞれのライセンスが適用されます。
