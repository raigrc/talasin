import type { MetadataRoute } from "next";

/**
 * PWA manifest (Next 16 metadata route). Static — no request-time APIs — so it is
 * cached by default, which is fine.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Talasin — daily mental gym",
    short_name: "Talasin",
    description:
      "Sharpen your reasoning and delivery: spot-the-fallacy drills, voice interview practice, and a progress streak.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0b12",
    theme_color: "#0b0b12",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
