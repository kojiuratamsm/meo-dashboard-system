# MapOn NEO の使い方と反映手順

## 流れ
1. マスター画面の左メニュー「MapOn NEO」→「申し込みフォームのURLをコピー」で、契約者に申し込みフォームを送る
2. 契約者が、名前・メールアドレス・パスワードを入力して申し込む
3. 契約者はログイン画面(/login)からログインすると、MapOn NEO の管理画面が開く
4. 管理画面で、アンケートの作成・公開・QRコードの発行ができる
5. 回答と集計も、管理画面で見られる

マスター(浦田さん)は、マスター画面の「MapOn NEO」に契約者の一覧(名前・メールアドレス)が表示され、「管理画面に入る」で、どの契約者の管理画面にも入れます。

## データベースの設定(Supabase の SQL Editor で実行)
- 初めて設定する場合:`supabase/MapOn_setup.sql`
- すでに MapOn_setup.sql を実行済みの場合:`supabase/追加SQL_2_MapOnNEO契約者.sql` だけ実行

## 本番への反映
MEO_UPLOAD フォルダの中身をアップロードしてください(`_to_delete` のような不要なフォルダは入れないでください)。

## 必要になったときだけ
- パスワード再設定リンク(オーナーがパスワードを忘れたとき):Vercel に `SUPABASE_SECRET_KEY` を登録し、Supabase の「URL Configuration」の Redirect URLs に `https://www.mapon-meo.com/reset-password` を追加してください。
- 平文パスワードの削除(後日):`supabase/あとで実行_平文パスワード列の削除.sql`
