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
@keyframes ugme-spin{to{transform:rotate(360deg)}}

.ugme-overlay{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;padding:24px;
  background:rgba(10,10,10,.82);animation:ugme-fade .18s ease-out;touch-action:auto}
.ugme-overlay__frame{position:relative;max-width:min(92vw,1100px);max-height:86dvh;display:flex;flex-direction:column;align-items:center;gap:10px;
  animation:ugme-pop .26s cubic-bezier(.2,.8,.2,1)}
.ugme-overlay__media{position:relative;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 20px 60px rgba(0,0,0,.45);line-height:0}
.ugme-overlay__media video,.ugme-overlay__media img{display:block;max-width:min(92vw,1100px);max-height:80dvh;width:auto;height:auto;background:#000}
.ugme-overlay__caption{color:rgba(255,255,255,.75);font-size:13px;line-height:1.4;text-align:center;max-width:60ch}
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
