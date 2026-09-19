import { Outlet } from "@remix-run/react";

/**
 * Customer submission portal layout.
 * This is public-facing — no Shopify admin auth, no Polaris.
 */
export default function SubmitLayout() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid #e5e7eb",
          background: "#fff",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
          Submit Your Content
        </h1>
      </header>
      <main style={{ flex: 1, padding: "24px", maxWidth: "720px", margin: "0 auto", width: "100%" }}>
        <Outlet />
      </main>
      <footer
        style={{
          padding: "16px 24px",
          borderTop: "1px solid #e5e7eb",
          textAlign: "center",
          color: "#6b7280",
          fontSize: "14px",
        }}
      >
        Powered by UGME
      </footer>
    </div>
  );
}
