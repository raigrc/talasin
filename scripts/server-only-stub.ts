// No-op stub so the `server-only` import resolves to nothing when the seed
// script runs under tsx (plain Node, outside the Next bundler). In the actual
// Next build, `import "server-only"` resolves to Next's compiled guard instead —
// this stub is used ONLY for standalone scripts via tsconfig.scripts.json paths.
export {};
