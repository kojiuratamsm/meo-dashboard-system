// captcha.js
// Cloudflare Turnstile(ロボットでないことの確認)を、申し込み・ログイン・パスワード再設定のページに出す部品。
//
// しくみ:
//  ・ページの確認の欄に Turnstile を表示し、確認が済むと「合言葉(トークン)」を受け取る。
//  ・申し込み・ログインのときに、その合言葉を Supabase に渡す(captchaToken)。
//  ・合言葉が本物かどうかは、Supabase が Cloudflare に問い合わせて確かめる。
//    Supabase の管理画面(Authentication → Bot and Abuse Protection)でオンにしたときだけ、合言葉のない申し込み・ログインを断る。
//    オフの間は、合言葉を渡しても、何も変わらない。
//  ・合言葉は1回しか使えない。使ったら(成功しても失敗しても)reset() で新しくする。
//  ・Turnstile が読み込めないとき(通信の失敗など)は、合言葉なしで進める。最後は Supabase の設定が決める。
//
// サイトキーは公開される値なので、ここに書いてよい。シークレットキーは、Supabase の管理画面にだけ置く(ファイルには書かない)。

export const TURNSTILE_SITE_KEY = '0x4AAAAAAGQDY74KwzzrgQAy';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const WAIT_MS = 12000;   // 押したときに、まだ確認が済んでいなければ、最大でこれだけ待つ

export const CAPTCHA_MESSAGE = 'ロボットでないことの確認ができませんでした。確認の欄にチェックが出ている場合は押してから、もう一度お試しください。うまくいかないときは、ページを再読み込みしてください。';

export const CAPTCHA_CSS = `
.captcha-box { margin: 6px 0 14px; min-height: 65px; display: flex; justify-content: center; }
.captcha-box:empty { min-height: 0; margin: 0; }
`;

let loading = null;
function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SCRIPT_URL;
        s.async = true;
        s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_missing')));
        s.onerror = () => reject(new Error('turnstile_load_failed'));
        document.head.append(s);
    });
    return loading;
}

/** Supabase が、確認(CAPTCHA)の失敗で断ったか */
export function isCaptchaError(error) {
    if (!error) return false;
    return error.code === 'captcha_failed' || /captcha/i.test(String(error.message || ''));
}

/**
 * 確認の欄を用意する。
 * container:確認を表示する要素(または、その id)
 * action:Cloudflare の集計で見分けるための名前(英数字・-・_)
 */
export function createCaptcha(container, action) {
    let box = null, widgetId = null, token = '', unavailable = false, started = false;
    let waiters = [];
    const wake = () => { const w = waiters; waiters = []; w.forEach((fn) => fn()); };

    function mount() {
        if (started) return;
        started = true;
        box = typeof container === 'string' ? document.getElementById(container) : container;
        if (!box) { unavailable = true; return; }
        if (!document.getElementById('captchaCss')) {
            const st = document.createElement('style');
            st.id = 'captchaCss';
            st.textContent = CAPTCHA_CSS;
            document.head.append(st);
        }
        loadTurnstile().then((ts) => {
            widgetId = ts.render(box, {
                sitekey: TURNSTILE_SITE_KEY,
                action,
                language: 'ja',
                // 幅に合わせる(最小300px)。とても狭い画面(300px未満)では、縦長の小さい形にする
                size: box.clientWidth && box.clientWidth < 300 ? 'compact' : 'flexible',
                callback: (t) => { token = t || ''; wake(); },
                'expired-callback': () => { token = ''; },
                'error-callback': () => { token = ''; },   // Turnstile が自分でやり直す
            });
        }).catch(() => { unavailable = true; wake(); });
    }

    return {
        mount,
        /** 合言葉を返す。まだなら、最大 WAIT_MS 待つ。得られなければ ''(合言葉なしで進める) */
        async getToken() {
            mount();
            if (token || unavailable) return token;
            await new Promise((res) => { waiters.push(res); setTimeout(res, WAIT_MS); });
            return token;
        },
        /** 合言葉を使ったあとに呼ぶ(同じ合言葉は2回使えない) */
        reset() {
            token = '';
            if (widgetId !== null && window.turnstile) {
                try { window.turnstile.reset(widgetId); } catch { /* 何もしない */ }
            }
        },
    };
}
