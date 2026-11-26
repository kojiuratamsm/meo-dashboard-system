// neo-mobile.js
// スマホで、横に長い表(.table-wrap)が横スクロールできるときだけ、「← 横にスクロールできます →」を出す。
// 画面が切り替わる(中身が変わる)たびと、画面の幅が変わったときに、はみ出しているかを調べ直す。

function mark() {
    document.querySelectorAll('.table-wrap, .sr-table-wrap').forEach((w) => {
        w.classList.toggle('scrolls', w.scrollWidth > w.clientWidth + 1);
    });
}

export function installTableHints() {
    if (window.__tableHints) return;
    window.__tableHints = true;
    let queued = false;
    const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; mark(); }); };
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', later);
    later();
}
