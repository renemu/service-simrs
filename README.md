# SIMRS Backend Supporting Services (Node.js)

Service pendukung berbasis **Express.js 5 (ES Modules)** untuk aplikasi **SIMRS Rawat Jalan (PT Inova Medika Solusindo)** sesuai batas arsitektur pada `docs/02-architecture/component-responsibilities.md`, `FR-06.05`, `FR-08`, dan `FR-10`.

Service ini berperan sebagai **Laboratory Integration Gateway** dan **Dashboard & Reports Aggregation Layer** tanpa duplikasi aturan bisnis inti maupun akses tulis langsung ke database PostgreSQL.

---

## Batas Arsitektur & Prinsip Desain

1. **Zero Direct Database Access**: Service Node.js tidak terhubung langsung ke PostgreSQL. Seluruh data inti dan penulisan otoritatif (termasuk penyimpanan hasil laboratorium) diteruskan ke **Backend Utama Yii2 (`backend-yii2`)** melalui REST API.
2. **Zero Business Rule Duplication**: Validasi otorisasi RBAC (`PermissionFilter`), validasi `session_version`, perhitungan tagihan, dan perubahan status klinis tetap menjadi tanggung jawab penuh Yii2.
3. **Truthful Downstream Error Handling (`BR-13`)**: Timeout atau kegagalan upstream/eksternal tidak pernah dilaporkan sebagai sukses; service mengembalikan `504 Gateway Timeout` atau `502 Bad Gateway` lengkap dengan `correlation_id` untuk kebutuhan rekonsiliasi.

---

## Fitur Utama

- **Health & Upstream Connectivity Check (`GET /`, `GET /health`)**
  - Memantau status service Node.js sekaligus memeriksa konektivitas upstream Yii2 (`yii2_upstream` dengan timeout `2500ms`).
- **Laboratory Integration Gateway (`/node-api/lab/*`)**
  - Mengambil daftar permintaan lab dari Yii2 (`GET /api/lab-orders`) dan melampirkan metadata status dispatch eksternal (`external_dispatch`).
  - Simulasi pengiriman (dispatch) order laboratorium ke LIS/vendor eksternal (`POST /node-api/lab/orders/:id/dispatch`) setelah memverifikasi keberadaan order dan hak akses pengguna ke Yii2.
  - Mendukung parameter uji simulasi kegagalan `?simulate_failure=timeout` (`504`) dan `?simulate_failure=error` (`502`) untuk verifikasi aturan integrasi `BR-13`.
  - Menerima callback hasil laboratorium eksternal (`POST /node-api/lab/results/callback`), memvalidasi payload, lalu meneruskan penyimpanan otoritatif ke Yii2 (`POST /api/lab-orders/:id/result`) dengan propagasi header `Idempotency-Key`.
- **Dashboard & Reports Aggregation (`/node-api/dashboard/*`)**
  - Memvalidasi parameter filter rentang tanggal (`from`, `to` berformat `YYYY-MM-DD`, serta memastikan `from <= to`).
  - Menyajikan ringkasan dashboard rawat jalan (`/summary`), agregasi kunjungan per poliklinik (`/visits-by-department`), dan pemakaian obat teratas (`/medicine-usage`) dari upstream Yii2 (`/api/dashboard/metrics`).
- **Autentikasi JWT, Correlation ID & HTTP Client Tangguh**
  - Verifikasi lokal token **JWT HS256** (`node:crypto` + `crypto.timingSafeEqual`) menggunakan `JWT_SECRET` yang sama dengan `backend-yii2`, lalu meneruskan Bearer token ke Yii2 agar pemeriksaan `session_version` dan RBAC tetap berjalan.
  - Propagasi header `X-Correlation-Id` (mempertahankan header dari klien atau men-generate UUID otomatis) di setiap request & response.
  - Timeout eksplisit menggunakan `AbortController` (`YII_TIMEOUT_MS`), serta kandidat resolusi host lokal (`localhost`, `127.0.0.1`, `[::1]`) untuk kelancaran development lokal.
  - Response error (`401`, `404`, `422`, `502`, `504`, `500`) konsisten dalam format JSON.

---

## Struktur Direktori

```text
backend-node/
├── src/
│   ├── config/
│   │   └── env.js                 # Loader file .env manual & konfigurasi runtime
│   ├── lib/
│   │   └── yiiClient.js           # HTTP client ke backend-yii2 (timeout, correlation ID, error mapping)
│   ├── middleware/
│   │   └── auth.js                # Middleware X-Correlation-Id & verifikasi Bearer JWT (HS256)
│   ├── routes/
│   │   ├── dashboard.routes.js    # Endpoint agregasi dashboard (/node-api/dashboard/*)
│   │   └── lab.routes.js          # Endpoint integrasi lab (/node-api/lab/*)
│   └── index.js                   # Entrypoint Express, CORS, health check, & global error handler
├── .env.example                   # Template variabel environment
├── Dockerfile                     # Container produksi berbasis node:22-alpine + HEALTHCHECK
├── package.json                   # Metadata proyek (ES Modules) & dependensi Express/CORS
├── yarn.lock                      # Lockfile dependensi
└── README.md                      # Dokumentasi ini
```

---

## Persyaratan Sistem

- **Node.js** `>= 20` (disarankan **Node.js 22**, sesuai `Dockerfile`; membutuhkan native `fetch`, `AbortController`, dan ES Modules)
- **npm** atau **Yarn**
- **SIMRS Backend Utama (`backend-yii2`)** aktif dan dapat diakses (default `http://localhost:8080`)

---

## Instalasi & Konfigurasi

### 1. Menjalankan Secara Lokal (Development)

1. **Install Dependencies**
   ```bash
   cd backend-node
   yarn install
   # atau
   npm install
   ```

2. **Konfigurasi Environment (`.env`)**
   Salin `.env.example` menjadi `.env`:
   ```bash
   cp .env.example .env
   ```

   Contoh isi `.env`:
   ```env
   PORT=3001
   NODE_ENV=development
   YII_API_URL=http://localhost:8080
   YII_TIMEOUT_MS=5000
   JWT_SECRET=change-this-jwt-secret-key-in-production
   CORS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173
   ```

   | Variabel | Default | Deskripsi |
   | :--- | :--- | :--- |
   | `PORT` | `3001` | Port HTTP tempat service Express berjalan |
   | `NODE_ENV` | `development` | Mode runtime (`development` / `production`); pesan error `5xx` disembunyikan pada `production` |
   | `YII_API_URL` | `http://localhost:8080` | Base URL backend utama Yii2 |
   | `YII_TIMEOUT_MS` | `5000` | Batas waktu tunggu request ke Yii2 dalam milidetik |
   | `JWT_SECRET` | *(wajib diisi)* | Secret key HS256 — **harus sama persis** dengan `JWT_SECRET` di `backend-yii2/.env` |
   | `CORS_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Daftar origin frontend yang diizinkan (dipisahkan koma, atau `*`) |

3. **Jalankan Server**
   ```bash
   npm start
   # atau
   yarn start
   ```
   Service akan berjalan di `http://localhost:3001`.

### 2. Menjalankan via Docker Compose (Root Repository)

Service ini sudah terintegrasi di `docker-compose.yml` pada root repository bersama `postgres`, `backend-yii2`, dan `frontend`:

```bash
# Dari direktori root repository (simrs-apps/)
docker compose up -d --build
```

Di lingkungan Docker:
- `backend-node` berjalan pada jaringan internal `simrs_network` di port `3001` (`YII_API_URL=http://backend-yii2:8080`).
- Akses eksternal diteruskan oleh reverse proxy Nginx pada container `frontend` melalui prefix `/node-api/`.
- Container dilengkapi `HEALTHCHECK` otomatis ke `http://127.0.0.1:3001/health`.

---

## Dokumentasi Endpoint REST API

Gunakan header berikut untuk endpoint terproteksi:
```http
Authorization: Bearer <jwt_token_dari_yii2>
Content-Type: application/json
X-Correlation-Id: <opsional-uuid-pelacakan>
```

### 1. Health & Service Info

| Method | Endpoint | Auth | Deskripsi |
| :--- | :--- | :---: | :--- |
| `GET` | `/` atau `/health` | Publik | Menampilkan status service Node.js, status konektivitas upstream Yii2 (`yii2_upstream`), `correlation_id`, dan `server_time`. |

### 2. Laboratory Integration API (`/node-api/lab/*`)

| Method | Endpoint | Auth | Deskripsi |
| :--- | :--- | :---: | :--- |
| `GET` | `/node-api/lab/orders` | Bearer JWT | Mengambil daftar order laboratorium dari Yii2 (`?status=`, `?search=`, `?page=`, `?per_page=`) dan melampirkan metadata `external_dispatch`. |
| `POST` | `/node-api/lab/orders/:id/dispatch` | Bearer JWT | Simulasi dispatch order lab ke LIS/vendor eksternal. Mendukung `?simulate_failure=timeout` (`504`) dan `?simulate_failure=error` (`502`). |
| `POST` | `/node-api/lab/results/callback` | Bearer JWT | Menerima & memvalidasi payload hasil lab eksternal (`lab_order_id`, `result_summary`, `reference_notes?`, `result_details?`) lalu meneruskan write ke Yii2 `POST /api/lab-orders/:id/result` (mendukung header `Idempotency-Key`). |

### 3. Dashboard & Analytics API (`/node-api/dashboard/*`)

| Method | Endpoint | Auth | Deskripsi |
| :--- | :--- | :---: | :--- |
| `GET` | `/node-api/dashboard/summary` | Bearer JWT | Ringkasan dashboard rawat jalan (`?from=YYYY-MM-DD&to=YYYY-MM-DD&department_id=`). |
| `GET` | `/node-api/dashboard/visits-by-department` | Bearer JWT | Agregasi kunjungan per poliklinik berdasarkan periode (`?from=YYYY-MM-DD&to=YYYY-MM-DD`). |
| `GET` | `/node-api/dashboard/medicine-usage` | Bearer JWT | Ringkasan top pemakaian obat (dispensed) berdasarkan periode (`?from=YYYY-MM-DD&to=YYYY-MM-DD`). |

---

## Contoh Request & Format Response

### 1. Health Check
```bash
curl http://localhost:3001/health
```
```json
{
  "success": true,
  "service": "simrs-backend-node",
  "version": "1.0.0",
  "environment": "development",
  "status": "online",
  "yii2_upstream": "online",
  "correlation_id": "2c8a9d1e-5f4b-4b2a-9a1c-7e8f0d1b2c3a",
  "server_time": "2026-11-23T14:00:00.000Z"
}
```

### 2. Dispatch Order Lab & Simulasi Kegagalan Downstream
```bash
# Dispatch normal
curl -X POST http://localhost:3001/node-api/lab/orders/1/dispatch \
  -H "Authorization: Bearer <jwt_token>"

# Simulasi timeout vendor eksternal (mengembalikan HTTP 504)
curl -X POST "http://localhost:3001/node-api/lab/orders/1/dispatch?simulate_failure=timeout" \
  -H "Authorization: Bearer <jwt_token>"
```

### 3. Callback Hasil Laboratorium ke Yii2
```bash
curl -X POST http://localhost:3001/node-api/lab/results/callback \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: lab-cb-001" \
  -d '{
    "lab_order_id": 1,
    "result_summary": "Hb 13.8 g/dL, Leukosit 7.200 /uL, Trombosit 265.000 /uL",
    "reference_notes": "Nilai dalam batas normal"
  }'
```

### 4. Ringkasan Dashboard
```bash
curl "http://localhost:3001/node-api/dashboard/summary?from=2026-11-01&to=2026-11-30" \
  -H "Authorization: Bearer <jwt_token>"
```

### 5. Format Standar Error JSON
```json
{
  "success": false,
  "status": 422,
  "error": "Unprocessable Entity",
  "message": "Invalid date filter parameters.",
  "errors": {
    "from": ["from date cannot be after to date."]
  },
  "correlation_id": "2c8a9d1e-5f4b-4b2a-9a1c-7e8f0d1b2c3a"
}
```

---

## Pengujian API (Postman)

Gunakan koleksi Postman yang tersedia di root repository untuk verifikasi endpoint Node.js bersama alur billing & lab:
- Koleksi: `../docs/04-api/postman/simrs-billing-and-node.postman_collection.json`
- Environment: `../docs/04-api/postman/simrs-local.postman_environment.json`
- Referensi endpoint lengkap: `../docs/04-api/node-endpoints.md`

---

## Batasan & Catatan Implementasi

- **Audit Log Dispatch In-Memory**: Log status simulasi dispatch eksternal (`dispatchAuditLog` pada `src/routes/lab.routes.js`) disimpan di memori (`Map`) untuk kebutuhan demo assessment dan akan ter-reset saat service dimulai ulang. Seluruh data order dan hasil laboratorium yang persisten tetap tersimpan di PostgreSQL melalui `backend-yii2`.
- **Ketergantungan `JWT_SECRET`**: Apabila `JWT_SECRET` pada `backend-node/.env` berbeda dengan `backend-yii2/.env`, seluruh request terproteksi akan ditolak dengan `401 Unauthorized`.
