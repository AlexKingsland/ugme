// Injected once per page. Class names are prefixed so theme CSS can't collide.
export const CSS = `
.ugme-canvas{display:block!important;position:relative;width:100%;height:var(--ugme-canvas-height,80vh);min-height:320px;overflow:hidden;
  background:var(--ugme-canvas-bg,#fff);touch-action:none;outline:none;-webkit-user-select:none;user-select:none;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.ugme-canvas--full{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;z-index:2147483000}
.ugme-canvas__gl{position:absolute!important;inset:0;width:100%;height:100%;touch-action:none}
.ugme-canvas__gl canvas{display:block;touch-action:none}
.ugme-canvas__chip{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:2;pointer-events:none;
  background:rgba(17,17,17,.78);color:#fff;font-size:12px;line-height:1;padding:9px 14px;border-radius:999px;
  white-space:nowrap;letter-spacing:.01em;transition:opacity .5s ease;backdrop-filter:blur(6px)}
.ugme-canvas__chip--hidden{opacity:0}
.ugme-canvas__btn{position:absolute;top:12px;right:12px;z-index:2;width:36px;height:36px;border-radius:999px;border:0;
  background:rgba(255,255,255,.92);color:#111;box-shadow:0 1px 6px rgba(0,0,0,.18);cursor:pointer;display:grid;place-items:center;padding:0}
.ugme-canvas__btn svg{width:16px;height:16px}
.ugme-canvas__state{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px;color:#6b7280;font-size:14px}
.ugme-canvas__state b{display:block;color:#111;font-size:15px;margin-bottom:4px}
.ugme-canvas__spinner{display:block;width:22px;height:22px;border-radius:50%;border:2px solid rgba(0,0,0,.12);border-top-color:#111;animation:ugme-spin .8s linear infinite}
.ugme-canvas__loading{display:flex;flex-direction:column;align-items:center;gap:10px}
.ugme-canvas__count{font-size:12px;color:#9ca3af;font-variant-numeric:tabular-nums}
@keyframes ugme-spin{to{transform:rotate(360deg)}}
.ugme-canvas__share{position:absolute;top:12px;left:12px;z-index:2;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px 0 11px;
  border-radius:999px;background:#111;color:#fff!important;font-size:13px;font-weight:600;text-decoration:none!important;box-shadow:0 1px 6px rgba(0,0,0,.18);line-height:1}
.ugme-canvas__share svg{width:15px;height:15px}
.ugme-canvas__share:hover{background:#000}
.ugme-empty{display:flex;flex-direction:column;align-items:center;max-width:380px;margin:0 auto;color:var(--ugme-empty-fg,#111)}
.ugme-empty__tiles{position:relative;width:176px;height:112px;margin-bottom:22px}
.ugme-empty__tile{position:absolute;top:0;width:68px;height:104px;border-radius:12px;display:grid;place-items:center;
  background:#f1f1f1;border:1px solid rgba(0,0,0,.07);color:#b5b5b5;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.ugme-empty__tile svg{width:20px;height:20px}
.ugme-empty__tile--l{left:6px;transform:rotate(-9deg) translateY(8px)}
.ugme-empty__tile--r{right:6px;transform:rotate(9deg) translateY(8px)}
.ugme-empty__tile--c{left:54px;z-index:1;background:#fff;color:#9a9a9a;box-shadow:0 12px 30px rgba(0,0,0,.12)}
.ugme-empty__title{margin:0 0 8px;font-size:20px;line-height:1.25;font-weight:700;color:inherit;letter-spacing:-.01em}
.ugme-empty__text{margin:0 0 20px;font-size:15px;line-height:1.5;color:inherit;opacity:.68}
.ugme-empty__cta{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 20px 0 16px;border-radius:999px;background:#111;color:#fff!important;
  font-size:15px;font-weight:600;text-decoration:none!important;box-shadow:0 6px 18px rgba(0,0,0,.18);transition:transform .15s ease,box-shadow .15s ease}
.ugme-empty__cta:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(0,0,0,.22)}
.ugme-empty__cta svg{width:16px;height:16px}

.ugme-overlay{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;padding:24px;
  background:rgba(10,10,10,.82);animation:ugme-fade .18s ease-out;touch-action:auto}
.ugme-overlay__frame{position:relative;max-width:min(92vw,1100px);max-height:86dvh;display:flex;flex-direction:column;align-items:center;gap:10px;
  animation:ugme-pop .26s cubic-bezier(.2,.8,.2,1)}
.ugme-overlay__media{position:relative;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 20px 60px rgba(0,0,0,.45);line-height:0}
.ugme-overlay__media video,.ugme-overlay__media img{display:block;max-width:min(92vw,1100px);max-height:80dvh;width:auto;height:auto;background:#000}
.ugme-overlay__caption{color:rgba(255,255,255,.75);font-size:13px;line-height:1.4;text-align:center;max-width:60ch}
.ugme-overlay__media--with-products video,.ugme-overlay__media--with-products img{max-height:62dvh}
.ugme-overlay__meta{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;color:rgba(255,255,255,.85);font-size:13px;line-height:1}
.ugme-overlay__verified{display:inline-flex;align-items:center;gap:5px;padding:6px 10px 6px 8px;border-radius:999px;background:rgba(16,185,129,.18);color:#6ee7b7;font-weight:600;font-size:12px}
.ugme-overlay__verified svg{width:13px;height:13px}
.ugme-overlay__author{font-weight:600;color:#fff}
.ugme-products{display:flex;flex-direction:column;gap:8px;width:min(calc(100vw - 48px),420px)}
.ugme-product{display:grid;grid-template-columns:52px 1fr auto;align-items:center;gap:12px;padding:8px 10px 8px 8px;border-radius:12px;background:#fff;color:#111;text-align:left;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.ugme-product__media{display:block;width:52px;height:52px;border-radius:8px;overflow:hidden;background:#f3f4f6}
.ugme-product__media img{width:100%;height:100%;object-fit:cover;display:block}
.ugme-product__body{min-width:0}
.ugme-product__title{display:block;font-size:14px;font-weight:600;color:#111!important;text-decoration:none!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ugme-product__price{font-size:13px;color:#4b5563;margin-top:2px}
.ugme-product__actions{display:flex;flex-direction:column;align-items:stretch;gap:4px}
.ugme-product__btn{border:0;border-radius:999px;background:#111;color:#fff!important;font-size:12px;font-weight:600;padding:8px 12px;cursor:pointer;white-space:nowrap;text-align:center;text-decoration:none!important;font-family:inherit;line-height:1.2}
.ugme-product__btn:disabled{opacity:.6;cursor:default}
.ugme-product__btn--done{background:#059669}
.ugme-product__btn--muted{background:#e5e7eb;color:#6b7280!important;cursor:default}
.ugme-product__link{font-size:12px;color:#4b5563!important;text-align:center;text-decoration:underline!important}
.ugme-overlay__close{position:fixed;top:14px;right:14px;width:40px;height:40px;border-radius:999px;border:0;cursor:pointer;
  background:rgba(255,255,255,.14);color:#fff;display:grid;place-items:center;padding:0}
.ugme-overlay__close:hover{background:rgba(255,255,255,.24)}
.ugme-overlay__close svg{width:18px;height:18px}
.ugme-overlay__buffer{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.ugme-overlay__buffer .ugme-canvas__spinner{border-color:rgba(255,255,255,.25);border-top-color:#fff}
@keyframes ugme-fade{from{opacity:0}to{opacity:1}}
@keyframes ugme-pop{from{opacity:0;transform:translate(var(--ugme-dx,0),var(--ugme-dy,0)) scale(.3)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.ugme-overlay,.ugme-overlay__frame{animation:none}}
`;

let injected = false;
export function injectStyles() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.setAttribute("data-ugme-canvas-styles", "");
  el.textContent = CSS;
  document.head.appendChild(el);
}
