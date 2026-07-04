# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

Key Next 16 items already in play here:
- Middleware is renamed **`proxy.ts`** (root-level).
- `cookies()` / `headers()` are **async** — `await cookies()`. `.set` / `.delete` only inside Route Handlers / Server Actions.
- `GET` Route Handlers are NOT cached by default. Do not add `dynamic = 'force-static'` to any handler reading cookies/DB.

See `DESIGN.md` (architecture) and `AI_DESIGN.md` (Gemini integration) for the source-of-truth spec.
