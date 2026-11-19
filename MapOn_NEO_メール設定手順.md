# MapOn メール送信の設定手順(パスワード再設定を、お店だけで完結させる)

contact@msm-fund.com から、パスワード再設定のメールを自動で送るための設定です。
作業は 4 か所です。**A. Resend(メール送信サービス)→ B. DNS(お名前.comレンタルサーバー)→ C. Supabase → D. 動作確認** の順に進めます。
所要時間の目安は、DNSの反映待ちを除いて 30〜40 分です(反映は、多くの場合 15 分以内。最大 72 時間かかることがあります:Resend公式)。

## 【2026/11/19 追加】名前を「MapOn NEO」から「MapOn」に変えたときの直し方(すでに設定済みの方は、ここだけ)

コードを直しただけでは変わらない、**画面で設定した3か所**があります。次の順に直してください。どれも、数分で終わります。

### ① Supabase:送信者名(Sender name)
1. Supabase のダッシュボード → 対象のプロジェクト(MEO-Dashboard)を開く。
2. 左メニュー **Authentication** → **Notifications** → **Email** → **SMTP Settings**。
3. **Sender name** の欄が `MapOn NEO` になっているので、`MapOn` に書き換える。
4. **Save**。
5. **Password の欄は、空のまま保存して大丈夫か** を、画面で確認してください。「保存済みの値は表示されません」という趣旨の表示なら、空欄のままで、いまのパスワードが残ります。もし「必須」と出て保存できない場合は、Resend の API Keys で新しいキーを作り直し、**Resend の画面から Supabase の Password 欄に直接貼って**ください(チャットには貼らない)。

### ② Supabase:パスワード再設定メールの文面
1. **Authentication** → **Emails**(NOTIFICATIONS の下)→ **Templates** → **Reset Password**。
2. **Subject(件名)** を、次に書き換える。
```
【MapOn】パスワード再設定のご案内
```
3. **Body** の中の、次の2行を直す(全部を貼り直してもよい。下の C-3 に新しい全文があります)。
   - `<p>MapOn NEO のパスワード再設定のご依頼を受け付けました。</p>` → `<p>MapOn のパスワード再設定のご依頼を受け付けました。</p>`
   - `<p>株式会社MSM / MapOn NEO</p>` → `<p>株式会社MSM / MapOn</p>`
4. **Save changes**。

### ③ Vercel:環境変数 `WELCOME_FROM`(設定している場合だけ)
1. Vercel → 対象のプロジェクト → **Settings** → **Environment Variables**。
2. **`WELCOME_FROM`** という名前があるか探す。
   - **ない場合:何もしません。** コードの初期値が、新しい名前(`MapOn <contact@msm-fund.com>`)になっています。
   - **ある場合**:値が `MapOn NEO <contact@msm-fund.com>` なら、`MapOn <contact@msm-fund.com>` に書き換えて保存。そのあと、**Deployments から再デプロイ**(環境変数は、再デプロイ後の動作から反映されます)。

### 直したあとの確認
1. `https://www.mapon-meo.com/login` → **パスワードをお忘れの方** → ご自身の店舗アカウントのメールアドレスで送る。届いたメールの、**差出人の表示名が「MapOn」**、件名が **【MapOn】パスワード再設定のご案内** になっているか。
2. 申し込み後のお迎えメールは、新しい申し込みを1件試して(テスト用のメールアドレスで)、件名が **【MapOn】お申し込みありがとうございます(ログインURLのご案内)** で届くか確認する。

### 変えなくてよいもの
- **Resend のドメイン・DNSレコード・APIキー**:名前とは関係がないので、触りません。
- **送信元のメールアドレス(contact@msm-fund.com)**:そのままです。
- すでに届いてしまった古いメール(「MapOn NEO」表記)は、書き換えられません。

---

## 先に知っておくこと

- **APIキー・SMTPのパスワードは、チャットにも、MEO_UPLOADのファイルにも書かない**でください。Resendの画面で作り、Supabaseの画面に直接貼ります(それ以外に置く場所はありません)。
- 送信サービスは **Resend(無料:月3,000通・1日100通)** を使います。無料枠は、パスワード再設定の用途なら十分です。
- msm-fund.com で、いま使っているメール(contact@msm-fund.com の受信、Gmailとの連携)は、**正しい場所に、足すだけ**なら止まりません。Resendが使うDNSの名前は `send`・`rsend`・`resend._domainkey` の3つで、受信や送信認証に使っているレコード(MX・SPF)とは別の名前です(2026/11/16に、実際の画面で確認)。
- **ただし、DNSを入れる場所を間違えると、サイトやメールが止まるおそれがあります。** msm-fund.com のネームサーバーは **お名前.comのレンタルサーバー(gmoserver.jp)** です(2026/11/16に、公開されているDNSで確認)。お名前.com Navi の「ドメインDNS設定」ではなく、**レンタルサーバーのコントロールパネル**で入れます(下の B)。
- このメールは、パスワード再設定のほか、**Supabase が送るすべての認証メール**(新規登録の確認メールなど)にも使われます。登録の確認メールが有効なら、C-4 の確認が必要です。

## A. Resend の準備

1. https://resend.com でアカウントを作る(contact@msm-fund.com のアドレスで登録するのがおすすめ)。
2. 左メニュー **Domains** → **Add Domain**。
3. ドメインに `msm-fund.com` を入れる。
   - Resend は、ふだん使うドメインとは別の「サブドメイン」(例:`notifications.msm-fund.com`)で送ることを勧めています(送信の評判を分けるため)。
   - 今回は、「差出人を contact@msm-fund.com にしたい」というご希望なので、`msm-fund.com` のまま進めます。送る量が少なく、返信が本物の受信箱に届くためです。のちに販促のメールなどを同じ仕組みで送るときは、サブドメインに分けてください。
4. 地域(Region)は、選べるなかでお客様に近いもの(日本なら Tokyo があればそれ)を選ぶ。
5. 追加の画面の「Tracking options」は、**2つとも(クリック・開封)チェックなし**のまま(2026/11/16の画面では、最初からチェックなしでした)。
6. **Add domain** を押すと、**DNSレコードの一覧**(種類・名前・値)が出る。**この画面は開いたまま**にして、B に進む。
7. 一覧の下にある **Enable receiving(受信)は、オフのまま**にしてください。オンにすると受信用のレコード(`@` のMXなど)が必要になり、contact@msm-fund.com の受信に影響するおそれがあります(Resend公式:受信の設定は任意)。

## B. DNSレコードを入れる(お名前.comレンタルサーバーのコントロールパネル)

Resend の画面に出た一覧を、そのまま入れます(出る内容は、Resend の画面が正です。公式は「Resendが示した値と完全に一致させる。コピー&ペーストで」としています)。

**2026/11/16に、実際に入れたもの(3つ)**
| 種類 | ホスト名(入力欄に入れたもの) | 値 |
|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA…`(DKIM。Resendの画面からコピー) |
| CNAME | `rsend` | `rsend-apne1.forge.rmta.net` |
| CNAME | `send` | `send.forge.rmta.net` |

TTLは、お名前.comの初期値 `600` のまま。DMARC(`_dmarc`)の行も、Resendは「Recommended(推奨)」と出しますが、認証には不要なので、今回は入れていません。Resendの表示が、MX+TXT(`send`)の形で出る場合もあります(公式:SPFはMXまたはCNAME)。**必ず、ご自身の画面に出た表のとおり**に入れてください。

### B-1. 確認済み:msm-fund.com のDNSの現状(2026/11/16、公開されているDNSで確認)
| 項目 | いまの値 | 意味 |
|---|---|---|
| ネームサーバー | `ns-rs1.gmoserver.jp` / `ns-rs2.gmoserver.jp` | DNSを管理しているのは、**お名前.comのレンタルサーバー**。お名前.com公式:RSプランなどを使う場合は、このネームサーバーに変更する |
| メール受信(MX) | `10 mx1036.onamae.ne.jp` | contact@msm-fund.com は、お名前.comのメールサーバーで受信している(Gmailは、そこから転送・取得・「別のアドレスとして送信」で連携しているとみられる) |
| SPF(TXT) | `v=spf1 include:_spf.onamae.ne.jp ~all` | 送信元の認証。**これは変更しません。Resendを足しません** |
| `send.msm-fund.com` / `rsend.msm-fund.com` | 存在しない(DNS一覧の画面でも、ありませんでした) | Resendが使う名前と、衝突しません(CNAMEは、同じ名前に別のレコードがあると入れられません) |
| `resend._domainkey.msm-fund.com` | 存在しない | 同上 |
| DMARC(`_dmarc`) | 存在しない | 今回は、追加しません |

### B-2. 入れる場所(重要)
- **お名前.com Navi の「ドメインDNS設定」→「DNSレコード設定」には、入れません。** そこは「お名前.com提供のDNS」用で、いまのネームサーバー(gmoserver.jp)には反映されません。
- さらに、その画面の **「ネームサーバー変更」にチェックを入れると、ネームサーバーが切り替わります**。お名前.com公式は「gmoserver.jp を使い続ける場合は、チェックを入れないでください」としています。切り替わると、サイトやメールの設定が外れるおそれがあります。
- 正しい場所は、**お名前.comレンタルサーバーのコントロールパネル → 左メニュー「ドメイン」→ msm-fund.com の「DNS」→「DNSレコードを追加」**です(2026/11/16に、実際の画面で確認済み。公式の案内ページ:https://www.onamae-server.com/guide/rs/p/25 )。
- 入れる前に、**いまのレコードの一覧を、画面ごとスクリーンショットで保存**してください(あとで元に戻せるように)。
- 入れるのは **追加だけ**。既存のレコード(MX・SPF(TXT)・Vercelなどへの向け先)は、**編集も削除もしません**。
- 入力は「TYPE を先に選ぶ」。先にホスト名などを入れてから TYPE を変えると、入力が消えることがあります(UTAGEの案内に書かれている注意)。

### B-3. 入力欄の対応
| Resendの画面 | お名前.comの欄 |
|---|---|
| 種類(TXT / MX / CNAME) | TYPE |
| 名前(Name) | **ホスト名**:欄の右に「.選択中のドメイン」と出ているので、`msm-fund.com` の部分は入れない。たとえば `send` / `rsend` / `resend._domainkey`(確認画面で `send.msm-fund.com` のように表示されれば正しい) |
| 値(Value) | VALUE(TXT は、前後の引用符(" ")を付けず、そのまま貼る) |
| 優先度(MXだけ) | MX優先(Resendの画面の数字をそのまま) |
| TTL | そのまま(Auto や 3600 など、近い値でよい) |

- 値の最後に、ドメイン名が自動でつく場合があります。その場合は値の最後に `.`(ピリオド)を足します(Resend公式FAQ)。
- 日本語ドメインでは、TXT・MXが使えません(お名前.com公式)。msm-fund.com は英数字なので問題ありません。
- お名前.comレンタルサーバーの「DNSレコードを追加」画面で選べる種類は、**A・CNAME・MX・TXT・SRV・AAAA**でした(2026/11/16に確認)。TTLは300〜604800の間(初期値600)。「確認する」→ 確認画面 →「追加する」の流れです。
- MXを入れる場合も、**ホスト名は `send` のもの**です。ホスト名を空欄にすると、いまのメール受信(MX)を書き換えてしまいます。**空欄にしない**でください。

### B-4. 確認
1. Resend の初回の画面で、**「I've added the records」**(一覧の下の黒いボタン)を押す。各行に緑のチェックが付き、ドメインの詳細画面で、Pending →(数分で)すべて **Verified** になる(2026/11/16は、約10分で3つとも Verified)。ドメインの詳細画面に、**Verify DNS Records** のボタンが出る場合は、そちらを押す。多くは15分以内。
2. ならない場合は、https://dns.email/ で、レコードが公開されているか確かめる。72時間たっても同じなら Resend の **Restart verification**(Resend公式)。
3. 「Verified」になったら、Resend の **Domains → msm-fund.com の設定** で、**Open Tracking / Click Tracking が両方OFF** なのを確認する(ONだと、メールの中のリンクが書き換えられて、再設定のリンクが壊れることがあります。Supabase公式も、外部サービスのメールトラッキングを無効にするよう勧めています)。

## C. Supabase に送信設定を入れる

Resend の左メニュー **API Keys** で、**Create API Key**(権限は **Sending access**、ドメインは msm-fund.com)。出てきたキーは **この1回しか表示されません**。コピーして、そのまま Supabase に貼ってください。

### C-1. SMTPの設定
Supabase のダッシュボード → 対象のプロジェクト → **Authentication** → **Notifications** → **Email** → **SMTP Settings**。

| 項目 | 入れる値 |
|---|---|
| Sender email | `contact@msm-fund.com` |
| Sender name | `MapOn` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Resend で作ったAPIキー |

**Save** で保存。(値は Resend 公式の「Supabaseとつなぐ手順」のとおりです。)
保存すると、チームの人以外にも送れるようになり、1時間あたりの送信上限は、初期値で **30通/時間**(Supabase公式。Rate Limits で変更できます)になります。

### C-2. サイトのURLの設定
**Authentication** → **URL Configuration**。
- **Site URL**:`https://www.mapon-meo.com`
- **Redirect URLs**:`https://www.mapon-meo.com/reset-password` を追加(Supabase公式:`redirectTo` に使うURLは許可リストに登録する)。

### C-3. メールの文面(パスワード再設定)
**Authentication** → **Emails**(NOTIFICATIONS の下)→ **Templates** → **Reset Password**(2026/11/16の画面。Subject と Body を貼り、**Save changes**。Preview では `{{ .SiteURL }}` などは置き換わらず、そのまま表示されます。送信時に置き換わります)。

**Subject(件名)**
```
【MapOn】パスワード再設定のご案内
```

**Body(本文。HTMLのまま貼る)**
```html
<h2>パスワード再設定のご案内</h2>
<p>MapOn のパスワード再設定のご依頼を受け付けました。</p>
<p>下のボタンを押して、新しいパスワードを設定してください。</p>
<p><a href="{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&amp;type=recovery" style="display:inline-block;padding:12px 24px;background:#4285F4;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">新しいパスワードを設定する</a></p>
<p>ボタンが押せない場合は、次のURLをブラウザに貼り付けて開いてください。<br>{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&amp;type=recovery</p>
<p>このメールに心当たりがない場合は、何もせず、このメールを破棄してください。パスワードは変わりません。</p>
<p>ご不明な点は、このメールへの返信(contact@msm-fund.com)でお問い合わせください。</p>
<p>株式会社MSM / MapOn</p>
```

**なぜ、標準のリンク(`{{ .ConfirmationURL }}`)を使わないのか**
メールを受け取る側のセキュリティ機能(例:Microsoft Defender の Safe Links)が、リンクを先に開いてしまうことがあります。標準のリンクは「開いた時点で使用済み」になるため、本人が押したときには「期限切れ」になります(Supabase公式のメールテンプレートの文書に、この問題と対策が載っています)。上の文面は、メールのリンクでは何も使わず、**サイトの画面のボタンを押したときにはじめて確認する**形にしてあります。画面側は、すでに対応済みです(`reset-password.html`)。

### C-4. ほかの認証メールの確認(忘れやすい)
- 新規登録の「確認メール」(Confirm signup)が有効なら、そのメールも Resend から、**初期の英語の文面**で送られます。**Authentication → Sign In / Providers → Email** の「Confirm email」が ON かを確認してください。ONなら、**Email Templates → Confirm signup** も日本語にします(必要でしたら、文面をお作りします)。
- OFF なら、新規登録のメールは送られないので、追加の作業はありません。

## D. 動作確認(必ず、ご自身で)

**2026/11/16の結果(浦田さんのご確認):** メールは受信トレイに届き、差出人表示名・件名・本文・ボタンとも設定どおり。ボタン → 新しいパスワードの画面 → パスワード変更まで、問題なく完了(下の1〜5)。6の「すぐ再送→1分あけて」の案内、使用済みリンクの期限切れの案内も確認済み(差出人は contact@msm-fund.com)。未実施は、6の「登録していないアドレス」と、7の Outlook・Androidです。

1. 反映(GitHubへアップロード)後、`https://www.mapon-meo.com/login` → **パスワードをお忘れの方**。
2. **ご自身の店舗アカウントのメールアドレス**を入力 → **再設定のメールを送る**。
3. メールが届く(迷惑メールフォルダも確認)。**差出人が contact@msm-fund.com** になっているか、件名・本文が上の文面か。
4. **ボタンを押す** → 「新しいパスワードを設定する」の画面 → もう一度ボタン → 新しいパスワードを入力 → 「ログイン画面へ」のボタンが出る。
5. 新しいパスワードで、ログインできる。
6. 次の2つも試す:
   - **同じメールで、すぐもう一度送る** → 「1分ほどあけて」の案内が出る(Supabaseは、同じ人への再送を60秒あけます)。
   - **登録していないメールアドレス**を入れる → 画面は、登録済みのときと同じ文面(メールは届きません)。登録の有無を、他人が調べられないようにするための仕様です。
7. iPhone(Gmailアプリ・iOSのメール)と、できれば Outlook でも届くか。

## 起きやすいトラブル

| 症状 | 原因と対処 |
|---|---|
| Resend で Verified にならない | ホスト名に `msm-fund.com` まで入れている/TXTに引用符が入っている/**お名前.com Navi に入れてしまっている**(正しくは、レンタルサーバーのコントロールパネル)。B-2・B-3 を確認 |
| サイトが表示されない・メールが届かなくなった | 追加したレコードを、いったん削除して元に戻す。B-2 で保存したスクリーンショットと見比べ、**「ネームサーバー変更」にチェックを入れていないか**確認する |
| メールが届かない | 迷惑メール、Resendの **Logs**(送信の記録)、Supabase の **Logs → Auth** を確認。保存直後の SMTP パスワードの貼り間違いが多い |
| 「Email address not authorized」 | SMTP が保存されていない(標準のSMTPは、チームの人にしか送れない) |
| ボタンを押すと「リンクが使えません」 | 古いメールのリンク(新しいメールが届くと、前のは無効)/Site URL が違う/メールのリンクトラッキングがON |
| 1時間に送れる数が足りなくなる | 初期値は30通/時間。Supabase の Authentication → Rate Limits で上げられます。ただし、Resend 無料の **1日100通** が先に上限になります |

## 注意

- **悪意のある人が、他人のメールアドレスを入れて再設定メールを連続で送らせること**は、画面だけでは完全に防げません。Supabaseは同じ人への再送を60秒あけ、全体も1時間あたりの上限があります。その上限を使い切られると、本物のお客様の再設定メールも一時的に遅れます。店舗が増えて問題になったら、Supabase公式が最も有効としているCAPTCHAの導入を検討します。
- 担当者が発行する「PW再設定URL」(マスター画面)は、**メールが使えないときの予備**として、そのまま残してあります。
- DMARC(なりすましメールを防ぐ設定)は、Resendの公式手順で、検証のあとに追加を勧められています。いまは設定されていません。メールが問題なく届くことを確認してから、追加してください(Gmailとの連携を含め、いまの contact@msm-fund.com の送信に影響する場合があるため、追加の前に、必ずご相談ください)。
