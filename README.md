# Loan Manager

## Backend + Database
The app now includes a production-ready Node/Express backend with SQLite storage and server-side login.
Data entered in the UI is stored in a central database so authorized users see the same data.

### Environment variables
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`: bootstrap admin user if none exist (min 8 chars). Defaults to `Admin` / `change-me-please` if unset.
- `JWT_SECRET`: secret used to sign session cookies (required for production)
- `PORT`: server port (default `4000`)
- `DB_PATH`: path to SQLite DB (default `data/loan-app.sqlite`)
- `TRUST_PROXY`: set to `true` if behind a reverse proxy
- `VITE_API_BASE`: optional API base URL if hosting the frontend separately
- `RESET_ADMIN_ON_START`: set to `true` to reset the admin user on server start

### Development
1) `npm install`
2) `npm run dev:server`
3) `npm run dev`

Or run both with `npm run dev:full`.

### Production
1) `npm install`
2) `npm run build`
3) `npm start`

The server will serve the built frontend from `dist/` and expose the API under `/api`.
