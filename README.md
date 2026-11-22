# SIMRS Backend Supporting Services (Node.js)

Service pendukung berbasis Express.js (ES Modules) sesuai `FR-10` & `docs/02-architecture/component-responsibilities.md`.

## Tanggung Jawab
- **Laboratory Integration Gateway (`/node-api/lab/*`)**: simulasi dispatch order laboratorium ke sistem eksternal (dengan mode uji simulasi failure `?simulate_failure=timeout|error`) dan penerimaan callback hasil lab yang divalidasi lalu diteruskan secara otoritatif ke Yii2.
- **Dashboard & Reports Aggregation (`/node-api/dashboard/*`)**: validasi filter periode tanggal, autentikasi Bearer JWT (HS256), dan agregasi laporan kunjungan/poli/tindakan/pendapatan/pemakaian obat dari Yii2 tanpa duplikasi aturan bisnis maupun akses tulis langsung ke database.

## Menjalankan Lokal
```bash
cd backend-node
cp .env.example .env
npm start
```
Server berjalan pada `http://localhost:3001` (dapat diubah via `PORT` di `.env`).
