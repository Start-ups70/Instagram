# REELS DOWNLOADER

Download Public Reels. Fast & Simple.

Plain HTML/CSS/JS frontend + one tiny Node file (`backend/server.js`, no packages) that keeps your RapidAPI key private. Public Reels only.

## Run locally

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In `backend/`, copy `.env.example` to `.env` and fill in:
   - `RAPIDAPI_KEY` and `RAPIDAPI_HOST` from your RapidAPI dashboard
   - `RAPIDAPI_ENDPOINT`: your exact endpoint, with `{shortcode}` where the Reel code goes (or `{url}` for the full Reel link)
3. From the `backend/` folder run `npm start`, then open http://localhost:3000

The server serves the website and the API on the same address, so the frontend is already connected.

## Deploy (Render, Railway, any Node host)

- Upload the whole project folder (keep `backend/.env` out of Git; `.gitignore` already does this).
- Start command: `node backend/server.js`
- Add the three variables from `.env.example` in the host's dashboard, plus `TRUST_PROXY=1` and `NODE_ENV=production`.
- Run a single instance (download links are kept in memory).

## Before going live

- Replace `YOURDOMAIN.com` in `index.html`, `pages/*.html`, `robots.txt` and `sitemap.xml`.
- Put real contact emails in `pages/privacy.html`, `terms.html` and `dmca.html`, and have a lawyer review them.

## Security

- The API key exists only in the backend environment, never in HTML, CSS or JS.
- The browser sends a Reel URL; the server accepts only `instagram.com/reel/CODE` and builds the API request itself.
- `/api/stream` only relays videos from Instagram's CDN that the server itself looked up (short-lived random ids). It cannot fetch arbitrary URLs.
- Rate limiting, API timeout, security headers, a static-file allow-list, and generic error messages (details only appear in your server console).
- Private accounts are refused.
