/**
 * Shared HTML shell for app proxy pages.
 * These pages render on the storefront, outside of Shopify admin,
 * so we use our own HTML + CSS — no Polaris.
 */
export function proxyLayout({
  title,
  brandName,
  logoUrl,
  body,
  footerHtml = "",
  shopDomain = "",
}: {
  title: string;
  brandName: string;
  logoUrl?: string | null;
  body: string;
  footerHtml?: string;
  shopDomain?: string;
}): string {
  // Extract shop domain from body if not passed (for menu links)
  const shopParam = shopDomain || "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${escapeHtml(title)} — ${escapeHtml(brandName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --ugme-bg: #ffffff;
      --ugme-fg: #1a1a1a;
      --ugme-muted: #6b7280;
      --ugme-border: #e5e7eb;
      --ugme-surface: #f9fafb;
      --ugme-accent: #1a1a1a;
      --ugme-accent-fg: #ffffff;
      --ugme-success: #059669;
      --ugme-warning: #d97706;
      --ugme-radius: 12px;
      --ugme-radius-sm: 8px;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--ugme-bg);
      color: var(--ugme-fg);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .ugme-shell {
      max-width: 480px;
      margin: 0 auto;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    .ugme-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      border-bottom: 1px solid var(--ugme-border);
      position: sticky;
      top: 0;
      background: var(--ugme-bg);
      z-index: 10;
    }
    .ugme-header-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
      color: var(--ugme-fg);
    }
    .ugme-header-logo {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--ugme-surface);
    }
    .ugme-header-dot {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--ugme-accent);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ugme-header-menu {
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      color: var(--ugme-fg);
      font-size: 20px;
      line-height: 1;
    }
    .ugme-content {
      flex: 1;
      padding: 24px 20px;
    }
    .ugme-footer {
      padding: 16px 20px;
      text-align: center;
      font-size: 12px;
      color: var(--ugme-muted);
      border-top: 1px solid var(--ugme-border);
    }
    .ugme-footer a { color: var(--ugme-muted); text-decoration: none; }
    .ugme-footer a:hover { text-decoration: underline; }

    /* Menu overlay (C11a) */
    .ugme-menu-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.4);
      z-index: 100;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.25s ease, visibility 0.25s ease;
    }
    .ugme-menu-backdrop.open {
      opacity: 1;
      visibility: visible;
    }
    .ugme-menu {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(320px, 85vw);
      background: var(--ugme-bg);
      z-index: 101;
      transform: translateX(100%);
      transition: transform 0.25s ease;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .ugme-menu-backdrop.open .ugme-menu {
      transform: translateX(0);
    }
    .ugme-menu-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      border-bottom: 1px solid var(--ugme-border);
    }
    .ugme-menu-close {
      background: none;
      border: none;
      font-size: 22px;
      cursor: pointer;
      color: var(--ugme-fg);
      padding: 4px;
      line-height: 1;
    }
    .ugme-menu-nav {
      padding: 12px 0;
      flex: 1;
    }
    .ugme-menu-link {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 20px;
      text-decoration: none;
      color: var(--ugme-fg);
      font-size: 15px;
      font-weight: 500;
      transition: background 0.15s;
    }
    .ugme-menu-link:hover {
      background: var(--ugme-surface);
    }
    .ugme-menu-link-icon {
      font-size: 18px;
      width: 24px;
      text-align: center;
    }
    .ugme-menu-divider {
      border: none;
      border-top: 1px solid var(--ugme-border);
      margin: 8px 20px;
    }
    .ugme-menu-footer {
      padding: 16px 20px;
      border-top: 1px solid var(--ugme-border);
      font-size: 12px;
      color: var(--ugme-muted);
    }

    /* Shared component styles */
    .ugme-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
    }
    .ugme-badge--reward {
      background: #ecfdf5;
      color: #065f46;
    }
    .ugme-badge--info {
      background: var(--ugme-surface);
      color: var(--ugme-fg);
      border: 1px solid var(--ugme-border);
    }
    .ugme-badge--warning {
      background: #fffbeb;
      color: #92400e;
    }
    .ugme-btn {
      display: block;
      width: 100%;
      padding: 14px 24px;
      border: none;
      border-radius: var(--ugme-radius);
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: opacity 0.15s ease;
    }
    .ugme-btn:hover { opacity: 0.9; }
    .ugme-btn--primary {
      background: var(--ugme-accent);
      color: var(--ugme-accent-fg);
    }
    .ugme-btn--outline {
      background: var(--ugme-bg);
      color: var(--ugme-fg);
      border: 1px solid var(--ugme-border);
    }
    .ugme-section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ugme-muted);
      margin-bottom: 8px;
    }
    .ugme-divider {
      border: none;
      border-top: 1px solid var(--ugme-border);
      margin: 20px 0;
    }
    .ugme-progress-bar {
      height: 6px;
      background: var(--ugme-border);
      border-radius: 3px;
      overflow: hidden;
    }
    .ugme-progress-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--ugme-success);
      transition: width 0.3s ease;
    }
  </style>
</head>
<body>
  <div class="ugme-shell">
    <header class="ugme-header">
      <a href="/apps/ugme${shopParam ? `?shop=${escapeHtml(shopParam)}` : ""}" class="ugme-header-brand">
        ${logoUrl
          ? `<img src="${escapeHtml(logoUrl)}" alt="" class="ugme-header-logo" />`
          : `<div class="ugme-header-dot"></div>`
        }
        ${escapeHtml(brandName)}
      </a>
      <button class="ugme-header-menu" aria-label="Menu" onclick="document.getElementById('ugmeMenu').classList.add('open')">&#9776;</button>
    </header>
    <main class="ugme-content">
      ${body}
    </main>
    <footer class="ugme-footer">
      ${footerHtml}
      Powered by <a href="https://ugme.app" target="_blank" rel="noopener">UG-ME</a>
    </footer>
  </div>

  <!-- Menu overlay (C11a) -->
  <div id="ugmeMenu" class="ugme-menu-backdrop" onclick="if(event.target===this)this.classList.remove('open')">
    <div class="ugme-menu">
      <div class="ugme-menu-header">
        <span style="font-weight: 600; font-size: 15px;">${escapeHtml(brandName)}</span>
        <button class="ugme-menu-close" aria-label="Close menu" onclick="document.getElementById('ugmeMenu').classList.remove('open')">✕</button>
      </div>
      <nav class="ugme-menu-nav">
        <a href="/apps/ugme${shopParam ? `?shop=${escapeHtml(shopParam)}` : ""}" class="ugme-menu-link">
          <span class="ugme-menu-link-icon">📋</span>
          Campaigns
        </a>
        <a href="/apps/ugme/account${shopParam ? `?shop=${escapeHtml(shopParam)}` : ""}" class="ugme-menu-link">
          <span class="ugme-menu-link-icon">📹</span>
          My submissions
        </a>
        <hr class="ugme-menu-divider" />
        <a href="https://${shopParam || "store"}/account" class="ugme-menu-link">
          <span class="ugme-menu-link-icon">👤</span>
          My account
        </a>
      </nav>
      <div class="ugme-menu-footer">
        Powered by UG-ME
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
