# DoodleDash — Rencana Eksekusi (Step by Step)

> Dokumen kerja turunan dari `prd_doodledash_real_time_pictionary_app.md`.
> Status project: **foundation only** — Expo Router belum aktif, belum ada satu pun screen, Supabase baru berupa client kosong.

---

## 0. Snapshot Kondisi Project Saat Ini

| Item | Kondisi Aktual | Catatan |
| --- | --- | --- |
| Expo SDK | **58.0.16** | PRD menulis "SDK 50+" — acuan yang dipakai: SDK 58 |
| React Native | 0.88.0 | New Architecture aktif by default |
| React | 19.3.0 | |
| Expo Router | 58.0.24 (terpasang) | **Belum dipakai**: `main` masih `index.ts` → `App.tsx`, `src/app/` belum ada |
| Skia | `@shopify/react-native-skia` 2.14.0 | Sudah terpasang, belum dipakai |
| Supabase | `src/lib/supabase.ts` | URL salah (ada suffix `/rest/v1/`), anon key masih hardcoded |
| Zustand | 5.0.15 | Belum ada store |
| `expo-av` | 16.0.8 | **Unmaintained** → ganti `expo-audio` |
| Skill/aset | `assets/` ada, `LICENSE`, `AGENTS.md` | |
| Typecheck | `strict: true` | |

### Hasil `expo-doctor`
- ❌ Missing peer deps: `expo-constants`, `expo-linking` (dibutuhkan `expo-router`), `react-native-worklets` (dibutuhkan `react-native-reanimated` 4.x)
- ❌ `expo-av` unmaintained
- ⚠️ Patch drift: `expo` 58.0.16 → 58.0.17, `expo-router` 58.0.24 → 58.0.25, `expo-status-bar` 58.0.3 → 58.0.4

---

## 1. Keputusan Arsitektur yang Harus Dikunci Dulu

Ini yang tidak dibahas PRD dan berpotensi jadi rework besar kalau salah pilih.

### 1.1. Authority game state → **Postgres RPC, bukan client**
Tanpa backend custom, satu-satunya tempat yang bisa dipercaya adalah database. Jangan biarkan host menghitung skor/timer di device-nya.

- **Rekomendasi:** semua transisi state (`start_game`, `start_round`, `choose_word`, `submit_guess`, `end_round`) lewat fungsi Postgres `SECURITY DEFINER`.
- Timer dibatasi server: simpan `round_end_time` (timestamptz), client hanya render countdown dari selisih waktu (clock offset dihitung sekali saat join).
- Skor hanya bisa naik lewat `submit_guess` di server → mencegah curang dari client.

### 1.2. Transport realtime → 3 channel terpisah per room
| Kebutuhan | Mekanisme | Alasan |
| --- | --- | --- |
| Goresan kanvas | **Broadcast** (`room:{code}:draw`) | Harus cepat, tidak perlu persist per titik |
| Chat & tebakan | **Broadcast** (`room:{code}:chat`) + insert ke tabel `guesses` | Chat instan, tapi tetap perlu history untuk reconnect |
| Status pemain / lobby | **Presence** (`room:{code}:presence`) | Built-in join/leave + daftar online |
| Perubahan state game (score, round, status) | **Postgres Changes** (`rooms`, `players`, `rounds`) | Sumber kebenaran tunggal, otomatis tersync ulang saat reconnect |

> Jangan pakai `postgres_changes` untuk tiap titik goresan — itu akan membombardir DB.

### 1.3. Snapshot kanvas untuk late joiner / reconnect
Broadcast bersifat *fire-and-forget*, client yang join di tengah ronde tidak akan melihat gambar sebelumnya.
- **Rekomendasi:** simpan `rooms.canvas_strokes JSONB` (array stroke), di-throttle update maksimal **1x/2 detik** oleh artist, plus broadcast `canvas:sync` saat ada event `canvas:request`.
- Undo/Clear cukup kirim ulang snapshot penuh — ukurannya kecil.

### 1.4. Identitas pemain → anonim, tanpa auth
- Tidak perlu Supabase Auth untuk MVP. Pakai `client_id` (UUID) yang disimpan di `AsyncStorage`.
- Username diinput di layar Join/Create, disimpan lokal untuk prefill.
- RLS: aktifkan, tapi tabel `rooms/players/rounds/guesses` diakses lewat RPC `SECURITY DEFINER`; direct `select` hanya untuk `rooms` (by code) dan `words` (kategori publik).

### 1.5. Undo semantics
Undo HANYA menghapus stroke terakhir **milik artist saat ini** (bukan history global). Implementasi: array stroke lokal, `pop()`, lalu broadcast snapshot.

---

## 2. Struktur Folder Target

```
src/
  app/                          # route-only (Expo Router), tidak ada komponen reusable
    _layout.tsx                 # providers, gesture handler root, theme
    index.tsx                   # Home: Create / Join
    create.tsx                  # form room settings
    join.tsx                    # input 4-digit code + username
    room/
      [code]/
        lobby.tsx
        game.tsx
        summary.tsx
  components/
    ui/                         # Button, Card, Input, Modal, Avatar, Badge
    game/
      Timer.tsx
      WordChoices.tsx
      Scoreboard.tsx
      ChatPanel.tsx
      PlayerList.tsx
    canvas/
      DrawingCanvas.tsx         # Skia surface
      BrushToolbar.tsx          # warna, ukuran, undo, clear
      StrokeRenderer.tsx
  hooks/
    useRoomChannel.ts           # subscribe broadcast draw/chat/presence
    useCountdown.ts             # server-clock-aware timer
    useGameState.ts             # baca rooms+players+rounds -> state
  lib/
    supabase.ts                 # FIX: URL + env
    realtime.ts                 # channel builder & typing event payload
    scoring.ts                  # mirror rumus server (untuk display)
    words.ts                    # konstanta kategori
  stores/
    useRoomStore.ts             # room, players, myPlayerId
    useGameStore.ts             # phase, word, timer, strokes, chat
    useSettingsStore.ts         # username, haptics/sound toggles
  types/
    game.ts                     # Room, Player, Round, Stroke, ChatMessage, Phase
    database.ts                 # generated Supabase types
  theme/
    colors.ts, spacing.ts, typography.ts
supabase/
  migrations/
    0001_init.sql
    0002_rpc_game_flow.sql
    0003_seed_words.sql
  README.md
docs/
  DEVELOPMENT_PLAN.md           # dokumen ini
```

Aturan: **`src/app/` hanya berisi route**. Semua logic di `components/hooks/lib/stores`.

---

## 3. Fase Pengerjaan

Setiap fase punya **Definition of Done (DoD)**. Jangan lanjut fase berikutnya sebelum `npx tsc --noEmit` dan `npx expo lint` bersih.

---

### Fase 0 — Perbaikan Fondasi & Tooling
Estimasi: 0.5 hari

**Tugas**
1. `npx expo install expo-constants expo-linking react-native-worklets` (peer deps wajib).
2. `npx expo install --fix` untuk patch drift.
3. Ganti `expo-av` → `npx expo install expo-audio`, hapus `expo-av` dari `package.json`.
4. `npx expo install @react-native-async-storage/async-storage`.
5. Setup lint: `npx expo lint` (ikutkan wizard), tambahkan script `"typecheck": "tsc --noEmit"`.
6. Aktifkan Expo Router:
   - `package.json`: `"main": "expo-router/entry"`
   - hapus `index.ts` + `App.tsx`, buat `src/app/_layout.tsx`
   - pastikan `app.json` punya `"scheme": "doodledash"` dan `"plugins": ["expo-router"]`
   - `tsconfig.json`: tambah `"paths": { "@/*": ["./src/*"] }`
7. Perbaiki `src/lib/supabase.ts`:
   - URL jadi `https://<project-ref>.supabase.co` (**tanpa** `/rest/v1/`)
   - pindah ke `.env`: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`
   - tambahkan `.env` ke `.gitignore`, buat `.env.example`
   - `auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }`
8. Tambah `expo-document-picker`? **Tidak** — belum perlu.
9. Jalankan `npx expo start` → pastikan Home kosong tampil dan tidak crash.

**DoD**
- `expo-doctor` 20/20 (atau warning yang memang di-exclude sadar).
- Router aktif, deep link `doodledash://` resolve.
- Tidak ada secret hardcoded di source.

---

### Fase 1 — Skema Database & RPC Game Flow
Estimasi: 1–1.5 hari

**Tugas**
1. Buat `supabase/migrations/0001_init.sql`:
   - `rooms`: `id uuid pk`, `code char(4) unique`, `host_player_id uuid`, `status text check in ('LOBBY','CHOOSING','PLAYING','SUMMARY','FINISHED')`, `max_players int`, `round_duration int`, `category text`, `current_round int`, `current_artist_id uuid`, `current_word text`, `word_choices text[]`, `round_started_at timestamptz`, `round_end_time timestamptz`, `canvas_strokes jsonb default '[]'`, `created_at`, `updated_at`
   - `players`: `id uuid pk`, `room_id fk cascade`, `client_id text`, `username text`, `score int default 0`, `is_host bool`, `is_ready bool default false`, `is_drawing bool`, `joined_at`, `last_seen_at`; unique `(room_id, client_id)`
   - `rounds`: `id uuid pk`, `room_id fk`, `round_number int`, `artist_id uuid`, `word text`, `started_at`, `ended_at`, `solved_by uuid[] default '{}'`
   - `words`: `id`, `category text`, `word text`, `difficulty smallint`, unique `(category, word)`
   - `guesses`: `id`, `room_id`, `player_id`, `message text`, `is_correct bool`, `created_at`
2. Index: `rooms(code)`, `players(room_id)`, `guesses(room_id, created_at)`, `words(category)`.
3. Enable RLS + policy minimal (lihat §1.4). Realtime publication untuk `rooms`, `players`, `rounds`, `guesses`.
4. Buat `0002_rpc_game_flow.sql` — semua `SECURITY DEFINER`, `search_path = public`:
   - `create_room(p_username, p_max_players, p_round_duration, p_category)` → generate 4-digit code unik (retry loop), buat room + player host, return row room & player.
   - `join_room(p_code, p_client_id, p_username)` → validasi room `LOBBY`/`PLAYING` (izin rejoin), validasi slot, upsert player.
   - `set_ready(p_player_id, p_ready)`
   - `leave_room(p_player_id)` → hapus; kalau host, transfer host ke pemain terlama atau tutup room kalau kosong.
   - `start_game(p_room_id, p_player_id)` → cek host & min 2 pemain, status → `CHOOSING`, pilih artist random, isi `word_choices` (3 kata dari kategori).
   - `choose_word(p_player_id, p_word)` → validasi artist & kata ada di `word_choices`, set `current_word`, `round_end_time = now() + round_duration`, status → `PLAYING`, buat row `rounds`.
   - `submit_guess(p_player_id, p_guess)` → return `{correct boolean, points int, correct_word text}`; hitung poin (lihat §5), insert `guesses`, update `players.score`, append `solved_by`; kalau semua guesser benar → `end_round` otomatis.
   - `end_round(p_room_id)` → status `SUMMARY`, isi `ended_at`; kalau `current_round >= max_round` → `FINISHED`, selain itu siap rotasi.
   - `next_round(p_room_id, p_player_id)` → host only, increment round, artist = pemain berikutnya yang belum jadi artist (round-robin), reset `canvas_strokes`.
   - `sync_canvas(p_room_id, p_strokes jsonb)` → validasi hanya artist; throttle dicek di client.
   - `get_server_time()` → `select now()`; dipakai untuk clock offset.
5. Buat `0003_seed_words.sql` — minimal **3 kategori × 40 kata** (Hewan, Makanan, Benda).
6. Generate types: `npx supabase gen types typescript --project-id <ref> > src/types/database.ts` (atau tulis manual tipe sempit dulu).
7. Dokumentasikan cara apply migration di `supabase/README.md`.

**DoD**
- Semua RPC bisa dipanggil via SQL editor dengan data dummy.
- Uji manual: create → join 2 orang → start → choose → guess benar → score berubah → next round.
- Tidak ada RPC yang bisa dipanggil untuk mengubah skor room lain.

---

### Fase 2 — Design System & Shell Navigasi
Estimasi: 1 hari

**Tugas**
1. `theme/colors.ts` (palet playful: primary, accent, surface, text, success, danger), `spacing.ts` (4/8/12/16/24/32), `typography.ts`.
2. `components/ui/`: `Button` (variant primary/secondary/ghost, loading, disabled), `Input`, `Card`, `Avatar`, `Badge`, `Screen` wrapper (SafeArea + KeyboardAvoiding).
3. `app/_layout.tsx`: `GestureHandlerRootView`, `StatusBar`, `Stack` dengan header disembunyikan untuk game, theme.
4. `app/index.tsx`: logo + tombol **Create Room** / **Join Room** + toggle haptics/sound.
5. Setup `expo-haptics` helper (`lib/haptics.ts`, no-op kalau setting mati).

**DoD**
- Home screen rapi di iOS & Android, aman dari notch (safe area).
- Semua komponen dipakai minimal 1x, tidak ada inline style berulang.

---

### Fase 3 — Room Management (Create / Join / Lobby)
Estimasi: 1.5 hari

**Tugas**
1. `stores/useSettingsStore.ts` + `stores/useRoomStore.ts` (persist username & client_id via AsyncStorage).
2. `app/create.tsx`: input username, max players (2–8), durasi (60/90/120), kategori → panggil `create_room` → `router.replace('/room/[code]/lobby')`.
3. `app/join.tsx`: input 4 digit (auto-focus per digit / single input dengan mask), username → `join_room` → lobby. Error state: room tidak ada, penuh, sudah mulai.
4. `hooks/useRoomChannel.ts`:
   - subscribe presence untuk daftar online
   - subscribe `postgres_changes` pada `players` (insert/update/delete) + `rooms` (status)
   - cleanup channel di `useEffect` return
5. `app/room/[code]/lobby.tsx`: kode room besar + tombol copy/share (`Share` API), list pemain + badge host, tombol **Ready** (semua non-host), tombol **Start** (host, enabled kalau ≥2 pemain & semua ready), tombol **Leave**.
6. Redirect otomatis ke `game` saat `rooms.status` berubah dari `LOBBY`.

**DoD**
- Dua device bisa create + join + lihat satu sama lain realtime tanpa refresh.
- Keluar dari lobby menghapus pemain dari list device lain (<2 detik).
- Deep link `doodledash://room/1234` membuka join dengan code terisi.

---

### Fase 4 — Kanvas Menggambar (Lokal)
Estimasi: 2 hari  ← **fase paling berisiko, kerjakan sendiri dulu sebelum realtime**

**Tugas**
1. `hooks/useDrawingGestures.ts`: `Gesture.Pan()` dari `react-native-gesture-handler`, ambil titik via `onBegin/onUpdate/onEnd`.
2. `components/canvas/StrokeRenderer.tsx` dengan Skia:
   - render `Skia.Path` per stroke memakai `Path.Make()` + `quadTo` (smoothing antar titik)
   - `strokeCap: 'round'`, `strokeJoin: 'round'`, `style: 'stroke'`
   - **jangan** simpan titik di React state per-frame → simpan di `useRef`/Reanimated shared value, render via `<Canvas>` imperatif atau `Picture` yang di-recreate hanya saat commit.
3. Batasi rate commit ke React (~30fps) untuk hemat JS thread.
4. `components/canvas/BrushToolbar.tsx`: 8 swatch warna, slider ukuran (2–24), Undo, Clear (dengan konfirmasi).
5. `types/game.ts`: `Stroke = { id, color, width, points: {x,y}[] }` — koordinat **ternormalisasi 0..1** (penting: biar konsisten beda ukuran layar).
6. Test di device fisik: 60fps, tidak ada input lag.

**DoD**
- Menggambar terasa mulus di Android mid-range.
- Undo menghapus stroke terakhir, Clear mengosongkan.
- Koordinat ternormalisasi terbukti (rotate/resize tidak merusak gambar tersimpan).

---

### Fase 5 — Sinkronisasi Kanvas Realtime
Estimasi: 1.5 hari

**Tugas**
1. `lib/realtime.ts`: definisi event payload bertipe:
   - `stroke:start { id, color, width }`
   - `stroke:points { id, points: number[] }` (flat x,y for size)
   - `stroke:end { id }`
   - `canvas:sync { strokes: Stroke[] }`
   - `canvas:clear {}`
   - `canvas:request {}`
2. Artist: buffer titik, flush **tiap 50ms** atau 20 titik (mana dulu), kirim flat array.
3. Guesser: terima dan render dengan pipeline yang sama; pakai `useRef` per stroke, commit ke render tree secara batched.
4. Throttle `sync_canvas` RPC tiap 2 detik (bukan setiap flush) — simpan `lastSyncRef`.
5. Saat `canvas:request` diterima (late joiner), artist kirim `canvas:sync` full.
6. Saat komponen mount dengan status `PLAYING`, kirim `canvas:request` dan render dari `rooms.canvas_strokes` sebagai fallback instan.
7. Artist-only writing; client lain mengabaikan event dari non-artist (validasi `payload.playerId === current_artist_id`).

**DoD**
- Latensi goresan antar device < 300ms di jaringan lokal.
- Late joiner melihat gambar dalam < 2 detik.
- Undo/Clear tersinkron ke semua client.
- Tidak ada memory leak (jumlah path stabil selama 60 detik menggambar terus).

---

### Fase 6 — Game Loop (State Machine)
Estimasi: 2 hari

**Tugas**
1. `stores/useGameStore.ts`: `phase: 'CHOOSING' | 'PLAYING' | 'SUMMARY' | 'FINISHED'` diturunkan dari `rooms.status`, bukan state lokal.
2. `hooks/useCountdown.ts`: hitung `round_end_time - (now + clockOffset)`; `clockOffset` didapat sekali via `get_server_time()`. Pause saat app background? — **tidak**, timer server tetap jalan (lebih adil).
3. `app/room/[code]/game.tsx` sebagai orchestrator: pilih sub-view berdasarkan phase & role (`isArtist`).
4. **Artist view:** tampilkan 3 pilihan kata (modal) → `choose_word`; setelah itu kanvas + toolbar + timer + jumlah guesser benar.
5. **Guesser view:** kanvas read-only + timer + chat + input tebakan. Kata ditampilkan tersamar (`_ _ _ _` + panjang huruf).
6. Auto `end_round` saat timer habis (client pemicu, RPC idempotent: kalau `round_end_time > now()` abaikan).
7. Rotasi artist via `next_round` — tombol host di summary, atau auto setelah 5 detik.
8. Guard: kalau `current_artist_id === myPlayerId` jangan tampilkan input chat (artist tidak menebak).

**DoD**
- Alur penuh 3 ronde berjalan tanpa intervensi DB.
- Timer konsisten di semua device (selisih < 1 detik).
- Tidak ada kondisi macet di satu phase (state machine punya tepat 1 transisi keluar per phase).

---

### Fase 7 — Chat & Guessing
Estimasi: 1 hari

**Tugas**
1. `components/game/ChatPanel.tsx`: FlatList inverted, auto-scroll, bubble sistem (join/leave/benar).
2. Kirim via broadcast `room:{code}:chat`, lalu `submit_guess` RPC.
3. Jika `correct`:
   - pesan **tidak** ditampilkan publik, ganti jadi badge "✅ <nama> menebak dengan benar"
   - haptics `notificationAsync(Success)`
   - update skor dari respons RPC (jangan hitung lokal)
4. Jika salah: tampilkan tebakan apa adanya.
5. Pesan dari artist tidak bisa ditebak (artist chat = chat biasa, tapi PRD bilang artist hanya menggambar → **artist tidak punya input chat**, hanya sistem).
6. Rate limit client: 1 tebakan / 1.5 detik (debounce) supaya tidak spam RPC.

**DoD**
- Kata benar tidak pernah muncul di layar guesser sebelum round selesai.
- `submit_guess` menolak tebakan setelah `round_end_time`.
- Riwayat chat tetap tampil setelah reconnect.

---

### Fase 8 — Round Summary & Scoreboard
Estimasi: 1 hari

**Tugas**
1. `app/room/[code]/summary.tsx` (atau modal overlay): kata benar, daftar penebak + poin yang didapat, total skor, countdown ke ronde berikut.
2. `components/game/Scoreboard.tsx`: urut skor desc, highlight pemain yang naik.
3. Layar akhir (`FINISHED`): podium top 3, tombol **Play Again** (reset skor, kembali ke lobby) & **Exit**.
4. Animasi masuk sederhana pakai `react-native-reanimated` (fade/slide), hormati `reduceMotion`.

**DoD**
- Skor di summary identik dengan nilai di DB.
- Play Again mengosongkan skor & canvas, kembali ke lobby.

---

### Fase 9 — Polish Native (Haptics, Audio, Simpan Gambar)
Estimasi: 1 hari

**Tugas**
1. `expo-audio`: SFX `tick` (10 detik terakhir), `correct`, `wrong`, `round-end`, `game-end`. Load sekali via `useAudioPlayer`, mute mengikuti setting.
2. Haptics: goresan awal (`selectionAsync`), tebakan benar (`Success`), salah (`Error`), timer kritis (`ImpactMedium`).
3. `expo-media-library`: tombol **Save** di summary → ambil snapshot kanvas via `makeImageSnapshot()` (Skia) → `saveToLibraryAsync`. Minta permission `requestPermissionsAsync` + tangani penolakan dengan pesan jelas.
4. `app.json`: tambah `plugins` `expo-media-library` (dengan `savePhotosPermission`), `expo-audio`; atur `userInterfaceStyle` dan splash.
5. Cek: haptics tidak jalan di web (guard `Platform.OS`).

**DoD**
- Tidak ada crash karena audio player belum siap.
- Permission media library ditolak → app tetap jalan, muncul toast.

---

### Fase 10 — Robustness & Edge Cases
Estimasi: 1.5 hari

**Tugas**
1. **Reconnect:** `AppState` listener + `supabase.realtime.onHeartbeat`? Gunakan: saat app aktif kembali → refetch `rooms`/`players`/`rounds` + re-subscribe channel + `canvas:request`.
2. **Host keluar:** RPC `leave_room` transfer host; client lain otomatis lihat badge host baru.
3. **Artist keluar saat PLAYING:** `leave_room` → jika artist, paksa `end_round` dengan alasan "artist left".
4. **Room penuh / code habis (4 digit = 10.000 kombinasi):** RPC retry 10x lalu error jelas; tambahkan cleanup room `FINISHED` > 24 jam (SQL function manual atau pg_cron kalau tersedia).
5. **Duplikat username** di room yang sama → auto-suffix ` (2)`.
6. **Tebakan mengandung kata di dalam kalimat** — keputusan: exact match case-insensitive & trim. Dokumentasikan.
7. **App background saat menggambar:** flush buffer sebelum blur.
8. **Error boundary** di `_layout.tsx` + fallback layar "Something went wrong" dengan tombol retry.
9. **Koneksi lambat:** indikator "Reconnecting…" di header game.

**DoD**
- Skenario uji: matikan wifi 10 detik saat PLAYING → nyalakan → state dan gambar pulih tanpa restart app.
- Artist di-kill paksa → ronde berakhir, tidak stuck.

---

### Fase 11 — QA, Build & Rilis Internal
Estimasi: 1–2 hari

**Tugas**
1. `npx tsc --noEmit` dan `npx expo lint` bersih.
2. Matriks uji manual (2–4 device): create/join, 3 ronde penuh, rejoin, host leave, permission ditolak, timer habis.
3. `npx expo-doctor` bersih.
4. Development build: `eas build --profile development` (Skia & media library lebih aman di dev build; Expo Go tetap bisa untuk tes cepat).
5. `eas.json` dengan profile `development`, `preview` (APK), `production`.
6. Rilis internal (APK / TestFlight) untuk uji lapangan.

**DoD**
- Build sukses di Android & iOS.
- Tidak ada crash pada sesi 10 menit.

---

## 4. Ringkasan Timeline

| Fase | Fokus | Hari |
| --- | --- | --- |
| 0 | Fondasi & tooling | 0.5 |
| 1 | DB + RPC | 1.5 |
| 2 | Design system | 1 |
| 3 | Room & lobby | 1.5 |
| 4 | Kanvas lokal | 2 |
| 5 | Sinkronisasi kanvas | 1.5 |
| 6 | Game loop | 2 |
| 7 | Chat & guessing | 1 |
| 8 | Summary & scoreboard | 1 |
| 9 | Polish native | 1 |
| 10 | Robustness | 1.5 |
| 11 | QA & build | 1.5 |
| **Total** | | **~16 hari kerja** |

Urutan ini sengaja menaruh kanvas (risiko tertinggi) di tengah, setelah fondasi stabil, dan sebelum game loop.

---

## 5. Aturan Skor (Usulan, perlu persetujuan)

```
sisa_rasio     = (round_end_time - now()) / round_duration   // 0..1
poin_guesser   = round(50 + 100 * sisa_rasio)                // 50..150
bonus_urutan   = max(0, 20 - 10 * (urutan_benar - 1))        // penebak pertama lebih besar
poin_artist    = 25 * jumlah_guesser_yang_benar
```

Semua dihitung di `submit_guess` / `end_round`, **bukan** di client. `lib/scoring.ts` hanya untuk menampilkan preview.

---

## 6. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Skia gesture → render tree per titik bikin lag | Tinggi | Simpan titik di ref/Reanimated, commit batched 30fps, uji di device low-end sejak Fase 4 |
| Broadcast hilang di jaringan buruk | Sedang | Snapshot `canvas_strokes` + `canvas:request` + Postgres Changes untuk state |
| Timer drift antar device | Sedang | `get_server_time()` → clock offset, jangan pakai jam device |
| RPC jadi bottleneck saat tebakan spam | Sedang | Debounce client + index `guesses(room_id, created_at)` |
| RLS terlalu longgar (anon key publik) | Tinggi | Semua mutasi lewat RPC `SECURITY DEFINER`; `insert/update` langsung diblok |
| `expo-av` deprecated | Rendah | Sudah diganti `expo-audio` di Fase 0 |
| Kode room 4 digit tabrakan | Rendah | Unique constraint + retry loop |
| Sesi 60 detik menggambar terus → memori naik | Sedang | Batasi jumlah stroke per ronde (mis. 400) + kompresi path |

---

## 7. Yang Masih Perlu Keputusan Product

1. **Max ronde:** PRD tidak menyebut. Usul: `max_round = jumlah pemain` (setiap orang jadi artist sekali).
2. **Minimal pemain:** 2 atau 3? (2 sudah bisa jalan).
3. **Exact match vs fuzzy:** usul exact match (case-insensitive, trim). Fuzzy berisiko false positive.
4. **Artist boleh chat?** Usul: tidak, hanya menggambar.
5. **Room publik / quick match?** PRD hanya kode room. Usul: di luar MVP.
6. **Bahasa kata:** Indonesia saja untuk MVP?
7. **Poin artist** diberikan atau tidak? (usul: ya, 25/penebak benar).
8. **Batas pemain:** PRD menyebut host menentukan; usul default 6, max 8.

---

## 8. Command Reference

```bash
npx expo start                 # dev server
npx tsc --noEmit               # typecheck
npx expo lint                  # lint
npx expo-doctor                # diagnosa dependency/config
npx expo install --fix         # sinkronkan versi SDK
npx supabase db push           # apply migration (jika pakai Supabase CLI)
npx supabase gen types typescript --project-id <ref> > src/types/database.ts
```

---

## 9. Urutan Eksekusi Pertama (hari ini)

1. Fase 0 langkah 1–7 (tooling + router + env).
2. Fase 1 skema SQL.
3. Fase 3 create/join (DB dulu, UI menyusul).
4. Baru masuk Fase 4 kanvas.
