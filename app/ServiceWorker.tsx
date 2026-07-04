"use client";

import { useEffect } from "react";

/**
 * Registers the minimal PWA service worker (public/sw.js). Client-only, no
 * secrets. Registration is a no-op in dev if the browser blocks it; failures are
 * swallowed so a flaky SW never breaks the app.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("[sw] registration failed:", err);
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }, []);

  return null;
}
