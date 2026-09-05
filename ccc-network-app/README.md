# Creator Carnival Networking Hub — frontend

React 19 + Vite + HeroUI + Tailwind v4. This is the frontend half only —
the backend routes and database logic live in the parent repo
(`../dashboard-server.js`, `../lib/ccc-network*.js`).

**Start here:**
- [`../NETWORKING-HUB.md`](../NETWORKING-HUB.md) — full project handoff:
  architecture, account lifecycle, email delivery, known issues.
- [`DESIGN.md`](./DESIGN.md) — the visual design system. Read before
  touching any screen's styling.

## Local dev

```bash
npm run dev      # Vite dev server, HMR, proxies API calls to the real backend
npm run build    # production build — output is what dashboard-server.js actually serves
npm run lint     # oxlint
```

`npm run dev` expects the backend running locally on port 39281 (see the
proxy config in `vite.config.js`) for API calls to resolve.
