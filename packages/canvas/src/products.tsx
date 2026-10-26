import * as React from "react";
import type { ProductRef } from "./types";

/** Storefront product JSON (/products/<handle>.js) — live price & stock. */
type StoreProduct = {
  title: string;
  url?: string;
  price: number; // cents
  compare_at_price?: number | null;
  available: boolean;
  featured_image?: string | null;
  variants: { id: number; available: boolean; price: number }[];
};

const cache = new Map<string, Promise<StoreProduct | null>>();

function routesRoot(): string {
  const root = (window as any).Shopify?.routes?.root;
  return typeof root === "string" && root ? root : "/";
}

function loadProduct(handle: string): Promise<StoreProduct | null> {
  if (!cache.has(handle)) {
    cache.set(
      handle,
      fetch(`${routesRoot()}products/${encodeURIComponent(handle)}.js`, { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? (r.json() as Promise<StoreProduct>) : null))
        .catch(() => null),
    );
  }
  return cache.get(handle)!;
}

function formatMoney(cents: number): string {
  const currency = (window as any).Shopify?.currency?.active || "USD";
  try {
    return new Intl.NumberFormat(document.documentElement.lang || undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Tell common themes the cart changed (best effort — themes differ). */
function announceCartChange(cart: unknown) {
  for (const name of ["cart:refresh", "cart:updated", "cart:change", "theme:cart:change"]) {
    document.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: { cart } }));
  }
}

type AddState = "idle" | "adding" | "added" | "error";

function ProductCard({ product }: { product: ProductRef }) {
  const [live, setLive] = React.useState<StoreProduct | null | undefined>(undefined);
  const [state, setState] = React.useState<AddState>("idle");

  React.useEffect(() => {
    let alive = true;
    if (product.handle) loadProduct(product.handle).then((p) => alive && setLive(p));
    else setLive(null);
    return () => {
      alive = false;
    };
  }, [product.handle]);

  if (!product.handle || live === null) return null; // unknown or unpublished product → no card
  const url = `${routesRoot()}products/${product.handle}`;
  const image = live?.featured_image || product.imageUrl;
  const variant = live?.variants.find((v) => v.available);

  const add = async () => {
    if (!variant || state === "adding") return;
    setState("adding");
    try {
      const res = await fetch(`${routesRoot()}cart/add.js`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ items: [{ id: variant.id, quantity: 1 }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cart = await fetch(`${routesRoot()}cart.js`).then((r) => r.json()).catch(() => null);
      announceCartChange(cart);
      setState("added");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="ugme-product">
      <a className="ugme-product__media" href={url}>
        {image ? <img src={image} alt="" loading="lazy" /> : <span />}
      </a>
      <div className="ugme-product__body">
        <a className="ugme-product__title" href={url}>
          {live?.title || product.title}
        </a>
        <div className="ugme-product__price">{live ? formatMoney(variant?.price ?? live.price) : " "}</div>
      </div>
      <div className="ugme-product__actions">
        {state === "added" ? (
          <a className="ugme-product__btn ugme-product__btn--done" href={`${routesRoot()}cart`}>
            Added · View cart
          </a>
        ) : live && !variant ? (
          <span className="ugme-product__btn ugme-product__btn--muted">Sold out</span>
        ) : (
          <button type="button" className="ugme-product__btn" onClick={add} disabled={!live || state === "adding"}>
            {state === "adding" ? "Adding…" : state === "error" ? "Try again" : "Add to cart"}
          </button>
        )}
        <a className="ugme-product__link" href={url}>
          View
        </a>
      </div>
    </div>
  );
}

export function ProductCards({ products }: { products: ProductRef[] }) {
  if (!products.length) return null;
  return (
    <div className="ugme-products" onClick={(e) => e.stopPropagation()}>
      {products.slice(0, 3).map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  );
}
