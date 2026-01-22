# Loan Manager

## Backend + Database
The app includes a Node/Express backend with SQLite storage and server-side login.
Data entered in the UI is stored in a central database so authorized users see the same data.

## Instructions

### Implement (install + configure)
1) `npm install`
2) Copy `.env.example` to `.env` and update the values:
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` (min 8 chars)
   - `JWT_SECRET` (long random string; required for production)
   - `PORT` / `DB_PATH` / `TRUST_PROXY` as needed
3) Optional: set `RESET_ADMIN_ON_START=true` once to reset the admin account

### Run (development)
1) `npm run dev:server`
2) `npm run dev`

Or run both with `npm run dev:full`.

### Run (production)
1) `npm run build`
2) `npm start`

The server will serve the built frontend from `dist/` and expose the API under `/api`.

### How to use
- Log in with the admin credentials you set in `.env`.
- Create loans, record payments, and manage users (Admin only).
- Use Reports to generate monthly statements and export PDFs.

### Special instructions
- `JWT_SECRET` is the signing key for session cookies. Set a strong value and keep it private.
- `.env` is ignored by git so secrets do not get committed.
- The database is stored at `data/loan-app.sqlite` by default; back it up as needed.
- `RESET_ADMIN_ON_START=true` will reset the admin user on startup (use once, then set back to `false`).
- First-login password changes are not enforced; rotate admin credentials manually when needed.
- The Windows launcher supports ngrok auto-tunneling when `NGROK_AUTHTOKEN` is set in `.env`.

### Environment variables
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`: bootstrap admin user if none exist (min 8 chars). Defaults to `Admin` / `change-me-please` if unset.
- `JWT_SECRET`: secret used to sign session cookies (required for production)
- `PORT`: server port (default `4000`)
- `DB_PATH`: path to SQLite DB (default `data/loan-app.sqlite`)
- `TRUST_PROXY`: set to `true` if behind a reverse proxy
- `VITE_API_BASE`: optional API base URL if hosting the frontend separately
- `RESET_ADMIN_ON_START`: set to `true` to reset the admin user on server start
- `NGROK_AUTHTOKEN`: optional token used by the Windows launcher to auto-start an ngrok tunnel
