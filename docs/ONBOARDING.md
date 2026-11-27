# MyDubb: onboarding cho engineer mới

Tài liệu này giúp bạn hiểu repo trong một buổi: sản phẩm làm gì, code nằm ở đâu, chạy và test thế
nào, và cần chuẩn bị gì trước khi viết feature đầu tiên.

- **Viết ngày:** 2026-11-26, trên commit `482e77d` của `main`.
- **Môi trường kiểm chứng:** Windows 11, Git Bash, Docker 29.9.3 (Docker Desktop), uv 0.13.9 (Python 3.12 do
  uv tự cài), Node 22.23.5, FFmpeg 7.1.1.
- **Quy ước nhãn:** ✅ = lệnh đã được chạy thật trên bản clone sạch và cho kết quả như mô tả;
  ⚠️ = chạy được nhưng có lưu ý; 📖 = chỉ đọc từ code/tài liệu, chưa chạy.
- Số dòng trong các link (`#L123`) đúng với commit trên; code đổi thì số dòng có thể lệch.

Nếu chỉ có 10 phút, đọc [mục 1](#1-mydubb-làm-gì), [mục 2.1](#21-bức-tranh-tổng-thể) và chạy
[kịch bản ở mục 7](#7-kịch-bản-end-to-end-nhỏ-để-tự-chạy).

---

## 1. MyDubb làm gì

**Vấn đề:** người học nội dung kỹ thuật bằng tiếng Anh (talk, khóa học, video) muốn nghe nội dung đó
bằng tiếng mẹ đẻ, nhưng vẫn giữ nguyên thuật ngữ kỹ thuật tiếng Anh.

**Giải pháp:** người dùng đưa vào một English transcript (paste, hoặc import caption tiếng Anh có sẵn
của một video YouTube). MyDubb:

1. dịch sang một trong 8 ngôn ngữ (Vietnamese là mặc định), giữ thuật ngữ trong glossary bằng tiếng Anh;
2. đọc bản dịch bằng giọng Azure Speech (thuật ngữ tiếng Anh được đọc bằng tiếng Anh);
3. co giãn audio (giữ nguyên cao độ) để dài đúng bằng đoạn video tương ứng, chia cho tốc độ đã chọn;
4. trả về bản dịch và file MP3. Kết quả chỉ được giữ 1 giờ.

Production chạy tại <https://mydubb.com>. Ngoài website còn có một Chrome extension (side panel)
gọi cùng API.

### Khái niệm nghiệp vụ chính

| Khái niệm | Ý nghĩa | Nơi định nghĩa |
|---|---|---|
| **Transcript** | Văn bản nguồn, luôn là tiếng Anh. Không bao giờ được lưu vào database, chỉ nằm trong RAM khi job chạy. | [pipeline.py:65](../backend/app/jobs/pipeline.py#L65) |
| **First / Last Sentence Start Time** | Hai mốc `HH:MM:SS` người dùng nhập. | [timestamps.py:19](../backend/app/transcript/timestamps.py#L19) |
| **Baseline** | `last - first` (giây nguyên). Không cộng thêm thời gian đọc câu cuối: đây là quyết định sản phẩm. | [timestamps.py:31](../backend/app/transcript/timestamps.py#L31) |
| **Speed** | Đúng 7 giá trị: 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2. Độ dài file = `baseline / speed`. Tốc độ nằm trong file MP3, không phải cài đặt của player. | [speed.py:20](../backend/app/audio/speed.py#L20), [speed.py:78](../backend/app/audio/speed.py#L78) |
| **Target language** | 8 ngôn ngữ đích; mã của Azure Translator và Azure Speech cố định ở server, không bao giờ lấy từ request. | [languages.py:39](../backend/app/languages.py#L39) |
| **Voice** | `AndrewMultilingual` (mặc định) hoặc `EmmaMultilingual`. | [voices.py:4](../backend/app/speech/voices.py#L4) |
| **Job** | Một lần "Generate audio". Vòng đời: `queued → translating → synthesizing → processing → completed`, hoặc `failed` từ bất kỳ bước nào. | [models.py:20](../backend/app/jobs/models.py#L20) |
| **Timing mode** | `plain`: bỏ hết timestamp trong transcript, co giãn cả audio về đúng target. `timed`: transcript có dạng YouTube (timestamp đứng riêng một dòng), mỗi block được đặt gần thời điểm caption của nó. | [schemas.py:16](../backend/app/jobs/schemas.py#L16), [timed.py:1](../backend/app/transcript/timed.py#L1) |
| **Glossary** | Danh sách hơn 2.000 thuật ngữ giữ nguyên tiếng Anh, mỗi dòng một thuật ngữ. Thêm thuật ngữ = thêm một dòng qua pull request. | [glossary.txt](../backend/app/translation/data/glossary.txt), [glossary.py:76](../backend/app/translation/glossary.py#L76) |
| **Provider** | Cài đặt thật hoặc mock cho từng bước của pipeline: translation (`mock`/`azure`), speech (`mock`/`azure`), audio (`mock`/`ffmpeg`), YouTube import (`off`/`mock`/`supadata`). Mặc định tất cả là mock/off. | [config.py:24](../backend/app/config.py#L24) |
| **Result** | Bản dịch + MP3, lưu tạm trên đĩa với TTL (`RESULT_TTL_SECONDS`, mặc định 3600). | [result_store.py:66](../backend/app/storage/result_store.py#L66) |
| **Principal** | "Ai đang gọi", suy ra từ cookie hoặc bearer token. Có 4 loại: Access Code session, tài khoản Cognito, guest, extension. | [principal.py:14](../backend/app/auth/principal.py#L14) |
| **Auth mode** | `access_code` (một mã chung, mặc định ở local) hoặc `cognito` (email + password qua Amazon Cognito). Hai chế độ loại trừ nhau. | [config.py:53](../backend/app/config.py#L53) |
| **Plan và quota** | Tài khoản Free: 20 job và 5 import mỗi ngày (UTC), mỗi job tối đa 1.000 từ và 600 giây audio. Guest: 5 job mỗi phiên, 20 mỗi mạng trong 24 giờ. Admin được miễn. | [quotas/service.py:74](../backend/app/quotas/service.py#L74), [config.py:257](../backend/app/config.py#L257) |
| **Capacity** | Giới hạn tài nguyên, không phải quota: 2 job chạy song song + 8 job chờ, quá thì trả `503 server_at_capacity`. | [executor.py:57](../backend/app/jobs/executor.py#L57) |

---

## 2. Kiến trúc

### 2.1 Bức tranh tổng thể

MyDubb là một **modular monolith**: một process FastAPI phục vụ cả API (`/api/*`) lẫn bản build React
trên cùng origin, lưu metadata vào PostgreSQL, và chạy job trong một thread pool nằm ngay trong
process. Không có Redis, Celery, message queue hay service phụ.

```mermaid
%%{init: {"theme": "base", "htmlLabels": false, "flowchart": {"htmlLabels": false, "padding": 16}, "themeVariables": {"lineColor": "#e8590c", "edgeLabelBackground": "#fff4e6", "textColor": "#212529", "clusterBkg": "#161b22", "clusterBorder": "#8b949e", "titleColor": "#e6edf3", "fontSize": "14px"}, "themeCSS": ".edgeLabel rect, .edgeLabel .background, .labelBkg { opacity: 1 !important; fill: #fff4e6 !important; background-color: #fff4e6 !important; } .edgeLabel text, .edgeLabel tspan { fill: #7c2d12 !important; } .cluster rect { fill: #161b22 !important; stroke: #8b949e !important; } .cluster-label text, .cluster-label tspan, .cluster-label span { fill: #e6edf3 !important; color: #e6edf3 !important; }"}}%%
flowchart TB
    Browser["Trình duyệt<br/>(React SPA)"]
    Ext["Chrome extension<br/>(side panel)"]

    subgraph App["FastAPI (một process)"]
        direction TB
        MW["RequestGuardMiddleware<br/>security headers<br/>kiểm tra Origin<br/>giới hạn body"]
        Routers["Routers<br/>system · jobs · guest<br/>access hoặc auth<br/>youtube_import<br/>extension · account<br/>admin"]
        Exec["BoundedThreadJobExecutor<br/>2 worker thread<br/>hàng chờ 8"]
        Pipe["JobPipeline"]
        TP["TranslationProvider<br/>mock hoặc azure"]
        SP["SpeechProvider<br/>mock hoặc azure"]
        AP["AudioProcessor<br/>mock hoặc ffmpeg"]
        RS["ResultStore<br/>đĩa cục bộ<br/>TTL 1 giờ"]
        Maint["maintenance<br/>vòng lặp chạy nền"]
    end

    DB[("PostgreSQL 17<br/>sessions · users<br/>jobs (metadata)<br/>quota · usage")]

    Browser -->|"HTTPS /api/*<br/>cookie session<br/>+ X-CSRF-Token khi<br/>POST hoặc DELETE"| MW
    Ext -->|"HTTPS /api/jobs*<br/>Authorization:<br/>Bearer token"| MW
    MW -->|"chuyển request<br/>hợp lệ"| Routers
    Routers -->|"đọc/ghi session,<br/>user, quota;<br/>tạo dòng job queued"| DB
    Routers -->|"POST /api/jobs:<br/>giữ slot, giao job"| Exec
    Routers -->|"GET /result:<br/>đọc bản dịch<br/>và MP3"| RS
    Exec -->|"chạy job trong<br/>worker thread"| Pipe
    Pipe -->|"1. dịch transcript"| TP
    Pipe -->|"2. tạo giọng đọc"| SP
    Pipe -->|"3. co giãn audio<br/>đúng target"| AP
    Pipe -->|"4. lưu bản dịch<br/>và MP3"| RS
    Pipe -->|"cập nhật<br/>trạng thái job"| DB
    Maint -->|"heartbeat,<br/>đánh dấu job mồ côi,<br/>dọn session, quota cũ"| DB
    Maint -->|"xóa kết quả<br/>hết hạn"| RS

    classDef client fill:#e7f5ff,stroke:#1971c2,color:#0b2e4f
    classDef core fill:#f1f3f5,stroke:#495057,color:#212529
    classDef provider fill:#ebfbee,stroke:#2f9e44,color:#0b3d17
    classDef store fill:#f3f0ff,stroke:#6741d9,color:#2b1a66
    class Browser,Ext client
    class MW,Routers,Exec,Pipe,Maint core
    class TP,SP,AP provider
    class RS,DB store
    style App fill:#161b22,stroke:#8b949e,color:#e6edf3
    linkStyle default stroke:#e8590c,stroke-width:2px,color:#7c2d12
```

Cách đọc: mỗi mũi tên (màu cam) ghi việc nó làm; số 1 đến 4 là thứ tự các bước của pipeline.
Màu ô: xanh dương là client, xám là thành phần trong FastAPI, xanh lá là provider thay được
(mock hoặc thật), tím là nơi lưu dữ liệu.

Điểm cần nhớ:

- **Một instance duy nhất.** Trạng thái chạy job nằm trong RAM của process
  ([executor.py:1](../backend/app/jobs/executor.py#L1)). Vì vậy container chỉ chạy một uvicorn worker
  ([entrypoint.sh:20](../docker/entrypoint.sh#L20)).
- **Không fallback ngầm.** Chọn provider thật mà thiếu key hoặc thiếu FFmpeg thì app không khởi động
  ([config.py:342](../backend/app/config.py#L342), [services.py:207](../backend/app/services.py#L207)).
  Một bước lỗi thì cả job lỗi, không có kết quả một phần.
- **Handler mỏng.** Router chỉ validate, phân quyền, tạo dòng job và giao cho executor. Pipeline không
  bao giờ thấy đối tượng HTTP.

### 2.2 Thư mục gốc

| Đường dẫn | Vai trò |
|---|---|
| [backend/](../backend/) | FastAPI app (Python 3.12, quản lý bằng uv), Alembic migrations, test pytest, script vận hành. |
| [frontend/](../frontend/) | React 19 + TypeScript + Vite. Test Vitest (jsdom, mock `fetch`). |
| [extension/](../extension/) | Chrome extension Manifest V3 (TypeScript + esbuild). Test Vitest và Playwright. |
| [e2e/](../e2e/) | Test trình duyệt Playwright chạy trên một Docker stack riêng, dùng xong xóa. |
| [docker/](../docker/) | Entrypoint của container, smoke test, script khởi tạo database test, các script kiểm tra cấu hình dùng trong CI. |
| [docs/](.) | Tài liệu thiết kế, API, triển khai. [context.md](context.md) là bản tóm tắt hiện trạng bằng tiếng Việt. |
| [benchmarks/infra/](../benchmarks/infra/) | Bộ đo tài nguyên một lần (xem [INFRA_BENCHMARK.md](INFRA_BENCHMARK.md)). Không thuộc sản phẩm. |
| [.github/](../.github/) | CI/CD: [ci.yml](../.github/workflows/ci.yml) và script deploy lên Render. |
| [Dockerfile](../Dockerfile) | Build 2 stage: Node build frontend, rồi image Python phục vụ cả API và SPA. |
| [docker-compose.yml](../docker-compose.yml) | PostgreSQL local, tùy chọn kèm container app. |
| [run-app.sh](../run-app.sh), [stop-app.sh](../stop-app.sh) | Bật/tắt toàn bộ bằng Docker. |
| [render.yaml](../render.yaml) | Blueprint cho Render (production). |

### 2.3 Backend: các module trong `backend/app`

| Module | Trách nhiệm | Phụ thuộc vào |
|---|---|---|
| [config.py](../backend/app/config.py) | `Settings` đọc từ biến môi trường; từ chối tổ hợp cấu hình không an toàn ngay khi khởi động. | không |
| [main.py](../backend/app/main.py) | App factory `create_app`, middleware, lifespan, gắn router, phục vụ SPA. | mọi thứ |
| [services.py](../backend/app/services.py) | **Composition root**: dựng provider, store, executor, pipeline từ settings. Đây là nơi duy nhất chọn mock hay thật. | mọi thứ |
| [dependencies.py](../backend/app/dependencies.py) | FastAPI dependencies dùng chung: DB session, xác định principal, kiểm tra CSRF. | access, auth, guest |
| [errors.py](../backend/app/errors.py) | Dạng lỗi thống nhất `{"error": {"code", "message", ...}}`. | không |
| [db.py](../backend/app/db.py) | Engine, session factory, `session_scope`. | không |
| [languages.py](../backend/app/languages.py) | 8 ngôn ngữ đích và mã dịch vụ tương ứng. | không |
| [jobs/](../backend/app/jobs/) | Model `Job`, chuyển trạng thái có bảo vệ, executor, pipeline, router `/api/jobs`. | tất cả provider qua `Protocol` |
| [transcript/](../backend/app/transcript/) | Hàm thuần: parse timestamp, làm sạch transcript, phân tích transcript timed, đếm từ. | `audio.speed` |
| [translation/](../backend/app/translation/) | `TranslationProvider`, mock, Azure Translator, glossary, chia request. | `languages`, `usage` |
| [speech/](../backend/app/speech/) | `SpeechProvider`, voice, mock, Azure Speech, SSML, chia chunk theo ngôn ngữ, rate limiter. | `translation`, `pronunciation`, `audio`, `usage` |
| [pronunciation/](../backend/app/pronunciation/) | Phát hiện tiếng Anh còn sót trong bản dịch để đọc bằng `en-US`. | `translation`, `languages` |
| [audio/](../backend/app/audio/) | `AudioProcessor`, mock, FFmpeg fitter, tính số sample đích, timeline cho timed mode. | `speech.base` |
| [storage/](../backend/app/storage/) | `ResultStore` và bản cài đặt lưu file cục bộ. | không |
| [youtube_import/](../backend/app/youtube_import/) | Import caption YouTube vào form (không tạo job): parse link, `CaptionProvider`, Supadata, mock. | `speech.rate_limit`, `transcript`, `guest`, `quotas` |
| [access/](../backend/app/access/) | Chế độ Access Code: kiểm tra mã, session, chống brute force. | `auth.principal` |
| [auth/](../backend/app/auth/) | Chế độ Cognito: client user pool, user, session, đổi mật khẩu, sign-up công khai, reCAPTCHA. | `access.rate_limit`, `guest` |
| [guest/](../backend/app/guest/) | "Try as guest": session khách, quota theo phiên và theo mạng, import của khách. | `auth`, `jobs` |
| [quotas/](../backend/app/quotas/) | Quota hằng ngày theo plan và shared cap; router `/api/account`. | `auth` |
| [extension/](../backend/app/extension/) | OAuth 2.0 Authorization Code + PKCE cho Chrome extension. | `auth`, `guest`, `quotas` |
| [usage/](../backend/app/usage/) | Ghi nhận usage theo job và chi phí tham chiếu. | `jobs` |
| [admin/](../backend/app/admin/) | API quản trị nội bộ: kiểm tra vai trò, báo cáo Usage & Costs. | `auth`, `usage` |
| [glossary_candidates/](../backend/app/glossary_candidates/) | Đếm ứng viên thuật ngữ mới phát hiện từ các job. | `jobs`, `pronunciation`, `translation` |
| [maintenance.py](../backend/app/maintenance.py) | Heartbeat, đánh dấu job mồ côi, dọn dẹp định kỳ. | jobs, access, storage |
| [system/](../backend/app/system/) | `/api/health`, `/api/ready`, `/api/meta`. | `quotas`, `speech.voices`, `languages` |

Cột "Phụ thuộc vào" lấy từ các câu `import` thực tế, bỏ qua hạ tầng dùng chung (`config`, `db`,
`errors`, `dependencies`, `services`). Có ba cặp phụ thuộc hai chiều cần biết khi tách code:
`speech` ↔ `audio`, `auth` ↔ `access`, `auth` ↔ `guest`.

Mỗi bước của pipeline là một `Protocol` nhỏ, nên thêm provider mới nghĩa là thêm một class và nối
trong `services.py`:
[TranslationProvider](../backend/app/translation/base.py#L17),
[SpeechProvider](../backend/app/speech/base.py#L32),
[AudioProcessor](../backend/app/audio/base.py#L22),
[CaptionProvider](../backend/app/youtube_import/base.py#L104),
[ResultStore](../backend/app/storage/result_store.py#L46).

### 2.4 Đường đi của một job (đọc theo thứ tự này)

1. **Request đến** `POST /api/jobs`. Middleware kiểm tra Origin và kích thước body
   ([main.py:124](../backend/app/main.py#L124)).
2. **Xác định người gọi.** `require_job_access_csrf` chấp nhận bearer token của extension, hoặc cookie
   kèm header `X-CSRF-Token` ([dependencies.py:207](../backend/app/dependencies.py#L207)).
3. **Validate.** `CreateJobRequest` làm sạch transcript, kiểm tra timestamp và speed
   ([schemas.py:30](../backend/app/jobs/schemas.py#L30)).
4. **Nhận job.** `create_job` kiểm tra giới hạn theo plan hoặc guest, giữ một slot executor, tính quota
   và ghi dòng job `queued` trong cùng một transaction, commit, rồi trả `202`
   ([router.py:99](../backend/app/jobs/router.py#L99)).
5. **Chạy.** `JobPipeline._run_stages` chạy trong worker thread: dịch, tổng hợp giọng, xử lý audio,
   lưu kết quả ([pipeline.py:207](../backend/app/jobs/pipeline.py#L207)).
6. **Chuyển trạng thái.** Mỗi bước là một `UPDATE ... WHERE status = <trạng thái mong đợi>`, nên một
   worker cũ không thể ghi đè job đã bị đánh dấu failed
   ([service.py:95](../backend/app/jobs/service.py#L95)).
7. **Lỗi.** Lỗi dự kiến ném `ProcessingError(code, user_message)`; lỗi bất ngờ thành `internal_error`,
   chi tiết chỉ vào log ([pipeline.py:183](../backend/app/jobs/pipeline.py#L183)).
8. **Client poll** `GET /api/jobs/{id}` mỗi giây cho đến trạng thái cuối
   ([useJobPolling.ts:18](../frontend/src/features/jobs/useJobPolling.ts#L18)), rồi lấy `/result` và
   `/result/audio`.

### 2.5 Frontend (`frontend/src`)

- [main.tsx](../frontend/src/main.tsx): điểm vào. Đường dẫn `/extension/connect` hiển thị trang kết
  nối extension, còn lại là `App`.
- [App.tsx](../frontend/src/App.tsx#L73): lấy `/api/meta`, khôi phục session, chọn màn hình đăng nhập
  theo `auth.mode`, rồi hiển thị Studio (`DubbingForm` + `JobPanel`).
- [api/client.ts](../frontend/src/api/client.ts#L46): hàm `request` duy nhất. CSRF token chỉ nằm trong
  RAM, session là cookie HttpOnly.
- `features/`: mỗi thư mục một vùng chức năng (`dubbing`, `jobs`, `auth`, `guest`, `admin`,
  `extension`, `account`, `access`, `providers`).
- `lib/`: logic thuần không phụ thuộc React (timestamp, timing của transcript, build request, theme).
- Không có router library hay state library: định tuyến bằng `pathname`
  ([appRoute.ts](../frontend/src/lib/appRoute.ts#L12)), state bằng hook của React.
- Dev server proxy `/api` sang backend ([vite.config.ts:6](../frontend/vite.config.ts#L6)).

### 2.6 Chrome extension (`extension/src`)

| Phần | Vai trò |
|---|---|
| [background/](../extension/src/background/) | Service worker: context menu "Send to MyDubb", mở side panel. Không giữ state. |
| [panel/](../extension/src/panel/) | Side panel: bản nháp transcript, đăng nhập (PKCE), gọi API, theo dõi job. |
| [content/](../extension/src/content/) | Content script: đọc vùng chọn, điều khiển video trên trang, floating player. |
| [offscreen/](../extension/src/offscreen/) | Offscreen document: giữ audio đang phát cho mọi tab, sống lâu hơn panel. |
| [shared/](../extension/src/shared/) | Hợp đồng message giữa các phần, kèm validator. |

Server mà extension gọi được cố định lúc build bằng `MYDUBB_ORIGIN`
([build.mjs:30](../extension/build.mjs#L30)). Backend chỉ chấp nhận extension có ID nằm trong
`EXTENSION_IDS`, và chỉ ở chế độ Cognito.

---

## 3. Giao diện bên ngoài

### 3.1 Quy ước chung của API

- Mọi endpoint nằm dưới `/api`, cùng origin với web app, body là JSON.
- Lỗi luôn có dạng `{"error": {"code": "...", "message": "...", ...}}`
  ([errors.py:36](../backend/app/errors.py#L36)). Lỗi validate trả `422 validation_error` kèm `fields`.
- Request thay đổi trạng thái dùng cookie phải gửi `X-CSRF-Token`
  ([dependencies.py:144](../backend/app/dependencies.py#L144)). Bearer token thì không cần.
- Ba cookie tách biệt, không dùng lẫn: `mydubb_session` (Access Code), `mydubb_auth` (Cognito),
  `mydubb_guest` (guest) ([dependencies.py:23](../backend/app/dependencies.py#L23)).
- Swagger UI có tại `/api/docs` khi `APP_ENV` khác `production`
  ([main.py:262](../backend/app/main.py#L262)). ✅ Đã mở được ở local (HTTP 200).

### 3.2 Endpoint

Router nào được gắn phụ thuộc `AUTH_MODE` ([main.py:276](../backend/app/main.py#L276)).

**Luôn có**

| Method và path | Tác dụng | Code |
|---|---|---|
| `GET /api/health` | Liveness, không chạm database. | [system/router.py:16](../backend/app/system/router.py#L16) |
| `GET /api/ready` | Readiness: database truy cập được. Trả 503 nếu không. | [system/router.py:22](../backend/app/system/router.py#L22) |
| `GET /api/meta` | Cấu hình công khai UI cần trước khi đăng nhập: provider, voice, ngôn ngữ, auth mode, guest, import. | [system/router.py:52](../backend/app/system/router.py#L52) |
| `POST /api/jobs` | Tạo job. Trả `202` + header `Location`. | [jobs/router.py:99](../backend/app/jobs/router.py#L99) |
| `GET /api/jobs/{id}` | Trạng thái job. Job của người khác trả `404`. | [jobs/router.py:405](../backend/app/jobs/router.py#L405) |
| `GET /api/jobs/{id}/result` | Bản dịch, metadata audio, các notice. `409` nếu chưa xong, `410` nếu đã hết hạn. | [jobs/router.py:414](../backend/app/jobs/router.py#L414) |
| `GET /api/jobs/{id}/result/audio[?download=1]` | File MP3 (inline hoặc attachment). | [jobs/router.py:486](../backend/app/jobs/router.py#L486) |
| `POST /api/transcripts/youtube` | Import caption tiếng Anh của video vào form. `404` khi tính năng tắt. | [youtube_import/router.py:37](../backend/app/youtube_import/router.py#L37) |
| `POST`, `GET`, `DELETE /api/guest/session` | Bắt đầu, đọc, kết thúc phiên guest. `404` khi guest access tắt. | [guest/router.py:173](../backend/app/guest/router.py#L173) |

**Chỉ khi `AUTH_MODE=access_code`** (mặc định ở local)

| Method và path | Tác dụng | Code |
|---|---|---|
| `POST /api/session` | Đăng nhập bằng Access Code. Đặt cookie, trả CSRF token. Sai 5 lần trong 15 phút thì `429`. | [access/router.py:34](../backend/app/access/router.py#L34) |
| `GET /api/session` | Session hiện tại. | [access/router.py:77](../backend/app/access/router.py#L77) |
| `DELETE /api/session` | Đăng xuất. | [access/router.py:84](../backend/app/access/router.py#L84) |

**Chỉ khi `AUTH_MODE=cognito`**

| Method và path | Tác dụng | Code |
|---|---|---|
| `POST /api/auth/login` | Đăng nhập email + password. Có thể trả về bước tiếp theo (đổi mật khẩu, xác minh email). | [auth/router.py:509](../backend/app/auth/router.py#L509) |
| `POST /api/auth/new-password` | Đặt mật khẩu mới sau mật khẩu tạm. | [auth/router.py:536](../backend/app/auth/router.py#L536) |
| `POST /api/auth/email-verification/send`, `/confirm` | Gửi và xác nhận mã xác minh email. | [auth/router.py:571](../backend/app/auth/router.py#L571) |
| `POST /api/auth/forgot-password`, `/reset-password` | Khôi phục mật khẩu. | [auth/router.py:633](../backend/app/auth/router.py#L633) |
| `GET /api/auth/me` | Người dùng hiện tại và CSRF token. | [auth/router.py:705](../backend/app/auth/router.py#L705) |
| `POST /api/auth/logout` | Đăng xuất. | [auth/router.py:719](../backend/app/auth/router.py#L719) |
| `POST /api/auth/signup`, `/confirm`, `/resend` | Tự tạo tài khoản (cần `PUBLIC_SIGNUP_ENABLED=true`, nếu không trả `404`). | [auth/signup.py:125](../backend/app/auth/signup.py#L125) |
| `GET /api/account/usage` | Quota hôm nay của tài khoản. | [quotas/router.py:43](../backend/app/quotas/router.py#L43) |
| `POST /api/extension/authorize`, `/guest/authorize` | Cấp authorization code một lần cho extension. | [extension/router.py:122](../backend/app/extension/router.py#L122) |
| `POST /api/extension/token` | Đổi code + PKCE verifier lấy bearer token. | [extension/router.py:240](../backend/app/extension/router.py#L240) |
| `GET /api/extension/session`, `POST /api/extension/logout` | Session của extension. | [extension/router.py:307](../backend/app/extension/router.py#L307) |
| `GET /api/admin/session` | Kiểm tra quyền admin. | [admin/router.py:21](../backend/app/admin/router.py#L21) |
| `GET /api/admin/usage/summary`, `/jobs`, `/jobs/{id}` | Báo cáo Usage & Costs. | [admin/usage.py:412](../backend/app/admin/usage.py#L412) |

Hợp đồng chi tiết: [API.md](API.md), [AUTH_API.md](AUTH_API.md), [EXTENSION_AUTH.md](EXTENSION_AUTH.md).

### 3.3 Script dòng lệnh

Chạy từ `backend/` bằng `uv run python -m scripts.<tên>`. Trừ khi ghi khác, chúng chưa được chạy
trong đợt kiểm chứng này (📖).

| Script | Tác dụng | Gọi dịch vụ ngoài? |
|---|---|---|
| [auth_users](../backend/scripts/auth_users.py) | Quản lý user phía MyDubb: list, disable, thu hồi session, cấp quyền admin. | Không (chỉ database) |
| [usage_report](../backend/scripts/usage_report.py) | Báo cáo usage, có chế độ `--synthetic`. | Không |
| [glossary_candidates](../backend/scripts/glossary_candidates.py) | Duyệt và xuất ứng viên glossary. | Không |
| [duration_smoke](../backend/scripts/duration_smoke.py) | Kiểm tra co giãn audio bằng FFmpeg thật. | Chỉ khi thêm `--azure` |
| [timed_benchmark](../backend/scripts/timed_benchmark.py) | Đo chi phí của timed mode. | Không |
| `azure_translator_smoke`, `azure_speech_smoke`, `timed_speech_smoke`, `pronunciation_smoke`, `supadata_smoke` | Smoke test trực tiếp với dịch vụ thật. Cần key và tốn quota. | **Có** |

### 3.4 Cấu hình

Mọi cấu hình đến từ biến môi trường; [.env.example](../.env.example) liệt kê đầy đủ kèm chú thích.
Bốn biến bắt buộc: `APP_ENV`, `DATABASE_URL` (chỉ PostgreSQL), `ACCESS_CODE` (khi dùng Access Code),
`PROVIDER_MODE`. Các quy tắc an toàn nằm trong
[`_check_environment_rules`](../backend/app/config.py#L342). Ví dụ: `PROVIDER_MODE=azure` yêu cầu cả
ba thành phần đều là thật, và `APP_ENV=production` cấm mock nếu không bật cờ cho phép.

---

## 4. Tính năng hiện có

- **Studio:** paste transcript, nhập hai mốc thời gian, chọn ngôn ngữ, voice, speed, bấm Generate, đọc
  bản dịch, nghe và tải MP3.
- **8 ngôn ngữ đích:** Vietnamese, Mandarin (Simplified), Hindi, Spanish, Arabic (hiển thị phải sang
  trái), French, Russian, Japanese.
- **Làm sạch transcript:** tự bỏ markup WebVTT, SRT, timestamp trong ngoặc và timestamp đứng riêng;
  giữ lại những gì có thể là lời nói như "10:30 is our meeting time."
  ([cleaning.py:1](../backend/app/transcript/cleaning.py#L1)).
- **Timed dubbing:** transcript dạng YouTube được đặt theo thời điểm caption (ước lượng theo block,
  không phải đồng bộ từng câu).
- **Duration fitting:** FFmpeg đổi tempo toàn bộ audio để dài đúng target đến từng sample, không cắt
  và không lặp ([fitter.py:1](../backend/app/audio/fitter.py#L1)).
- **Glossary và phát âm:** thuật ngữ giữ nguyên tiếng Anh khi dịch và được đọc bằng tiếng Anh; tiếng
  Anh còn sót ngoài glossary được phát hiện và gom làm ứng viên glossary.
- **Import caption YouTube** qua Supadata (không phiên âm audio; video không có caption tiếng Anh thì
  không import được).
- **Đăng nhập:** Access Code, hoặc Cognito (mời qua email, đổi mật khẩu, xác minh email, khôi phục mật
  khẩu), và sign-up công khai có reCAPTCHA (mặc định tắt).
- **Try as guest** với quota theo phiên và theo mạng.
- **Quota Free plan** và shared daily cap (cap mặc định tắt).
- **Vai trò admin** và trang Usage & Costs (`/admin/usage`).
- **Chrome extension:** side panel, "Send to MyDubb", floating player, Sync with video.
- **Vận hành:** heartbeat và khôi phục job sau restart, shutdown có thời gian chờ, dọn kết quả hết
  hạn, giới hạn tần suất gọi Azure Speech và Supadata.
- **Giao diện:** responsive, Light (mặc định) và Dark. Toàn bộ UI bằng tiếng Anh.

Chưa có và nằm ngoài phạm vi: upload video, speech-to-text, đồng bộ từng câu, thanh toán, lưu audio
vĩnh viễn (xem [context.md, mục 2](context.md)).

---

## 5. Chạy, build và test ở máy local

### 5.1 Cần cài gì

| Công cụ | Yêu cầu | Ghi chú |
|---|---|---|
| Docker | Đang chạy | Cho PostgreSQL, build image và E2E. |
| uv | 0.11+ (CI ghim 0.11.30) | ✅ 0.13.9 hoạt động, `uv lock --check` sạch. uv tự cài Python 3.12. |
| Node.js | **≥ 22.22.2** | ⚠️ README ghi "22+", nhưng xem [bẫy số 1](#10-bẫy-thường-gặp). |
| FFmpeg + ffprobe | Có `atempo` và `libmp3lame` | Chỉ cần cho test audio. Thiếu thì test bị skip ở local, fail ở CI. |
| Bash | Git Bash trên Windows | Các script `.sh` cần bash. |

### 5.2 Cách nhanh nhất: mọi thứ trong Docker

```bash
ACCESS_CODE=local-onboarding-code ./run-app.sh   # build image, bật PostgreSQL + app, chờ sẵn sàng
# mở http://127.0.0.1:8000 và đăng nhập bằng mã ở trên
./stop-app.sh            # tắt, giữ dữ liệu
./stop-app.sh --purge    # tắt và xóa volume database
```

✅ Cả `run-app.sh` (có đặt `ACCESS_CODE`) và `stop-app.sh --purge` đã chạy được.

Nếu không đặt `ACCESS_CODE`, `run-app.sh` tự sinh một mã ngẫu nhiên và ghi vào `.env` ở thư mục gốc
(file này bị git ignore) ([run-app.sh:26](../run-app.sh#L26)).

### 5.3 Chế độ phát triển: backend và frontend chạy trên máy

```bash
# 1. PostgreSQL (tạo sẵn hai database: mydubb và mydubb_test)
docker compose up -d db

# 2. Backend
cp .env.example backend/.env        # rồi đổi ACCESS_CODE thành mã của bạn
cd backend
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:create_app --factory --reload --port 8000

# 3. Frontend (terminal khác)
cd frontend
npm ci
npm run dev                          # mở http://localhost:5173
```

✅ Cả ba bước đã chạy được (bước 2 dùng `uv sync --frozen` và chạy uvicorn không có `--reload`). Lưu ý:

- Ở chế độ này backend **không** phục vụ SPA: `GET http://127.0.0.1:8000/` trả 404 vì
  `FRONTEND_DIST_DIR` chưa đặt ([main.py:295](../backend/app/main.py#L295)). Dùng cổng 5173.
- Vite chỉ nghe trên `localhost`. `http://127.0.0.1:5173` không kết nối được trên máy kiểm chứng.
- Trên Windows dùng `127.0.0.1` trong `DATABASE_URL` thay vì `localhost`.

### 5.4 Build

| Mục tiêu | Lệnh | Kết quả |
|---|---|---|
| Frontend | `cd frontend && npm run build` | ✅ `frontend/dist/` (JS 348,63 kB, gzip 104,78 kB) |
| Extension | `cd extension && npm run build && npm run check:dist` | ✅ `extension/dist/`, trỏ tới `https://mydubb.com` |
| Extension cho backend local | `MYDUBB_ORIGIN=http://localhost:8000 npm run build` | 📖 |
| Docker image | `docker build -t mydubb:local .` | ✅ 1 phút 55 giây, image 1,08 GB |

Backend không có bước build (`package = false` trong [pyproject.toml](../backend/pyproject.toml)).

### 5.5 Các loại test

| Loại | Công cụ | Lệnh (từ thư mục tương ứng) | Cần gì |
|---|---|---|---|
| Backend lint + format | Ruff | `uv run ruff check . && uv run ruff format --check .` | không |
| Backend migrations | Alembic | `uv run alembic upgrade head`, `downgrade base`, `upgrade head` | PostgreSQL |
| Backend unit + integration | pytest | `uv run pytest` | PostgreSQL, FFmpeg |
| Frontend lint, types | ESLint, tsc | `npm run lint && npm run typecheck` | không |
| Frontend unit | Vitest + jsdom | `npm test` | không |
| Extension lint, types, unit | ESLint, tsc, Vitest, `node --test` | `npm run lint && npm run typecheck && npm test` | không |
| Extension trong trình duyệt | Playwright | `npx playwright install chromium && npm run test:browser` | Chromium |
| E2E web | Playwright + Docker | `cd e2e && npm ci && npx playwright install chromium && bash run-e2e.sh` | Docker |
| Smoke test container | sh + curl | `BASE_URL=... ACCESS_CODE=... sh docker/smoke-test.sh` | app đang chạy |
| Script CD | ShellCheck + bash | `bash .github/scripts/tests/run-tests.sh` | jq, curl, python3 |

Backend test cần biến môi trường trỏ tới database **dùng xong bỏ**:

```bash
export TEST_DATABASE_URL=postgresql://mydubb:mydubb_local@127.0.0.1:5432/mydubb_test
```

Bộ test **xóa và tạo lại** schema `public` của database này
([conftest.py:73](../backend/tests/conftest.py#L73)). Không bao giờ trỏ nó vào database có dữ liệu
cần giữ. Thiếu biến này thì test fail chứ không skip.

**Profile và cách test được dựng**

- Repo không có khái niệm test profile hay file cấu hình theo môi trường. Mỗi test tự dựng app với
  settings riêng qua fixture
  `make_client(**overrides)` ([conftest.py:118](../backend/tests/conftest.py#L118)). Mặc định là
  `app_env=test`, mock provider, Access Code.
- Chế độ Cognito trong test dùng user pool giả trong RAM (`FakeCognito`), tiêm qua
  `build_services(cognito_client=...)` ([conftest.py:146](../backend/tests/conftest.py#L146)).
- Azure và Supadata được thay bằng `httpx.MockTransport`. Không test nào trong CI gọi dịch vụ thật;
  [e2e/live/](../e2e/live/README.md) là bộ chạy tay riêng với Cognito thật, không nằm trong CI.
- Test audio dùng FFmpeg thật ([conftest.py:200](../backend/tests/conftest.py#L200)).
- E2E có ba stack trong một Compose project: Access Code, Cognito giả + guest, và sign-up
  ([docker-compose.e2e.yml](../e2e/docker-compose.e2e.yml)). Playwright chọn stack theo tên file spec
  (`auth.*.spec.ts`, `signup.*.spec.ts`) ([playwright.config.ts:12](../e2e/playwright.config.ts#L12)).
- Thử kịch bản lỗi bằng tay: đặt `MOCK_FAIL_STAGE=translation|speech|audio|unexpected` trong
  `backend/.env` rồi khởi động lại backend.

**CI** ([ci.yml](../.github/workflows/ci.yml)) chạy 6 job cho mỗi pull request: `frontend`,
`extension`, `backend`, `docker`, `e2e`, `cd-scripts`. Job `ci-success` chỉ xanh khi cả 6 thành công;
đó là check bắt buộc trước khi merge.

---

## 6. Kết quả build và test trên bản clone (2026-11-26)

Repo được giữ nguyên: không file nào được sửa, mọi thứ sinh ra (`.venv`, `node_modules`, `dist`,
`__pycache__`, `backend/.env`) đều đã được xóa sau khi chạy. `git status --ignored` chỉ còn file
này. Container và volume Docker đã được gỡ; các image đã build vẫn nằm trong Docker.

| Hạng mục | Kết quả |
|---|---|
| `uv sync --frozen` | ✅ 12 giây |
| Ruff check + format | ✅ sạch, 206 file |
| Alembic upgrade → downgrade base → upgrade | ✅ |
| **pytest backend** | ⚠️ **2309 passed, 1 failed** trong 15 phút 13 giây (xem 6.1) |
| `npm ci` frontend trên Node 22.14.0 | ❌ `EBADENGINE` (lỗi môi trường, xem bẫy số 1) |
| `npm ci` frontend trên Node 22.23.5 | ✅ |
| Frontend lint, typecheck, build | ✅ |
| **Vitest frontend** (`npm test`) | ⚠️ **flaky**: 490/490 pass khi giới hạn 4 worker; 3 đến 14 test fail khi chạy mặc định (xem 6.2) |
| Extension lint, typecheck, build, `check:dist` | ✅ |
| Vitest extension + `node --test` | ✅ 410/410 và 11/11 |
| Extension trong Chromium (`test:browser`) | ✅ 71/71 trong 8,1 phút |
| e2e `typecheck`, `test:live-tooling` | ✅ 18/18 |
| Docker image build | ✅ 1 phút 55 giây |
| `ACCESS_CODE=... ./run-app.sh` | ✅ app sẵn sàng tại `http://127.0.0.1:8000`, `GET /` trả SPA |
| `docker/smoke-test.sh` | ⚠️ fail với `python3` mặc định trên Windows (stub của Microsoft Store); ✅ pass khi thêm `PYTHON=python` |
| `./stop-app.sh --purge` | ✅ |
| E2E Playwright (`bash run-e2e.sh`) | ✅ 168/168 trong 6,8 phút (desktop + mobile, ba stack) |
| Script CD: ShellCheck + 78 check | ✅ 0 lỗi (chạy trong container Ubuntu 24.04, repo mount read-only, vì máy không có `jq` và `shellcheck`) |

### 6.1 Test backend fail sẵn

**`tests/test_guest_youtube_import.py::test_a_step_the_database_cannot_end_leaves_the_import_engine_open`**

```
>       assert states(db_engine) == ["used"]
E       AssertionError: assert ['reserved'] == ['used']
tests\test_guest_youtube_import.py:1267: AssertionError
```

- **Hiện tượng:** fail 1 lần khi chạy cả bộ. Chạy riêng test này 5 lần liên tiếp đều pass. Đây là
  test flaky, không phải lỗi cố định.
- **Nguyên nhân:** race condition nằm trong chính test. Hàm thay thế `stuck_settle` đặt cờ `finished`
  trong khối `finally`, ngay sau khi `real_settle` trả về
  ([dòng 1225-1231](../backend/tests/test_guest_youtube_import.py#L1225)). Nhưng câu `UPDATE` đó chỉ
  được commit sau, khi `session_scope` thoát ([db.py:45](../backend/app/db.py#L45), gọi từ
  [`_transaction`](../backend/app/guest/imports.py#L541)). Thread của test thức dậy ở
  `finished.wait()` và đọc ngay bằng một connection khác
  ([dòng 1265-1267](../backend/tests/test_guest_youtube_import.py#L1265)). Nếu nó đọc trước khi
  commit xong thì vẫn thấy `reserved`.
- **Đánh giá:** code sản phẩm không sai, dòng đó sau cùng vẫn thành `used`. Trên máy kiểm chứng,
  PostgreSQL chạy sau Docker Desktop nên mỗi round trip chậm hơn, cửa sổ race có thể rộng hơn so
  với CI trên Linux. Phần race là kết luận từ việc đọc code và từ việc test pass khi chạy lại; độ
  trễ commit chưa được đo trực tiếp.
- Không sửa gì, theo yêu cầu.

### 6.2 Test frontend flaky

| Lần chạy | Điều kiện | Kết quả |
|---|---|---|
| 1 | `npm test`, cùng lúc với pytest | 14 fail / 476 pass, 8 file |
| 2 | `npm test`, chạy riêng | 3 fail / 487 pass, 3 file **khác** lần 1 |
| 3 | 4 file từng fail, chạy riêng | 101/101 pass |
| 4 | `npx vitest run --maxWorkers=4` | **490/490 pass** |

Các test fail ở lần 2:

- `src/App.accountUsage.test.tsx` › the plan banner › shows what is left today, the per-job limits and the UTC reset
- `src/App.adminUsage.test.tsx` › who sees Usage & Costs › offers it to an administrator, asking the server once per identity
- `src/App.guest.test.tsx` › Try as guest on the sign-in screen › is not offered when the server does not offer it

Ở lần 1 chỉ còn giữ được log của hai test cuối (cả hai trong `src/App.youtubeImport.test.tsx`), 12
tên còn lại không được ghi lại.

- **Hiện tượng:** tập test fail thay đổi giữa các lần chạy, và biến mất khi giảm số worker.
- **Nguyên nhân:** quá thời gian chờ khi chạy song song quá nhiều. Máy kiểm chứng có 24 luồng logic,
  Vitest mở một môi trường jsdom cho mỗi file trong 32 file (Vitest tự báo "jsdom was created 32
  times · 362.66s total"). Lỗi có hai dạng: `Test timed out in 5000ms` ở các test gõ từng ký tự bằng
  `user.type`, và `Unable to find role=...` khi `findByRole` hết 1000 ms mặc định. Repo không cấu
  hình `testTimeout` ([vitest.config.ts](../frontend/vitest.config.ts)).
- Một test timeout còn kéo theo test kế tiếp fail: request `POST /api/jobs` đến muộn bị ghi nhận là
  "unexpected" ở `afterEach` ([App.youtubeImport.test.tsx:29](../frontend/src/App.youtubeImport.test.tsx#L29)).
- **Đánh giá:** không phải lỗi logic. CI trên GitHub cho đúng commit `482e77d` kết thúc `success`
  (xem 6.3), tức cả 490 test đều pass trên runner Linux.
- **Cách chạy ổn định ở local, không cần sửa repo:** `npx vitest run --maxWorkers=4`.

### 6.3 Đối chiếu với CI

`gh run list --branch main --limit 5` (✅ chạy ngày 2026-11-26): năm lần chạy CI gần nhất trên `main`
đều `success`, kể cả lần cho commit `482e77d` (2026-11-22). Vậy trên runner Linux của GitHub, bộ
test của đúng commit này pass toàn bộ. Hai nhóm lỗi ở 6.1 và 6.2 chỉ xuất hiện trên máy kiểm chứng
và không lặp lại ổn định, nên được xếp là flaky phụ thuộc môi trường, chưa phải regression.

---

## 7. Kịch bản end-to-end nhỏ để tự chạy

Mục tiêu: tạo một job dubbing ở mock mode và tải MP3 về, không cần key của dịch vụ nào.

### 7.1 Qua giao diện

1. `ACCESS_CODE=local-onboarding-code ./run-app.sh`
2. Mở <http://127.0.0.1:8000>, nhập Access Code.
3. Paste vào **English Transcript**: `Spring Boot uses Dependency Injection to manage objects.`
4. **First Sentence Start Time** gõ `000010`, **Last Sentence Start Time** gõ `000040` (dấu hai chấm
   tự xuất hiện).
5. Chọn ngôn ngữ và voice, bấm **Generate audio**.
6. Quan sát các trạng thái Translating → Generating voice → Processing audio → Completed
   ([JobPanel.tsx:14](../frontend/src/features/jobs/JobPanel.tsx#L14)). Mỗi bước
   mock kéo dài 1,5 giây để bạn kịp thấy.
7. Bản dịch là nội dung mock có tiền tố `(VI mock)`, audio là một file mẫu cố định dài khoảng 3 giây.
   Giao diện ghi rõ đây là mock.

📖 Các bước giao diện này chưa được bấm tay trong đợt kiểm chứng. Luồng tương đương (đăng nhập, điền
form, Generate, xem các trạng thái, tải MP3) được bộ E2E Playwright thực hiện trên trình duyệt thật
và đã pass ([workflow.spec.ts](../e2e/tests/workflow.spec.ts)).

### 7.2 Qua API bằng curl

Chạy trong Git Bash khi app đang ở `http://127.0.0.1:8000`. Trên Windows dùng `python`; trên Linux
và macOS đổi thành `python3`.

```bash
B=http://127.0.0.1:8000
CODE=local-onboarding-code          # ACCESS_CODE bạn đã dùng khi bật app
JAR=$(mktemp)
json() { python -c "import sys,json; print(json.load(sys.stdin)$1)"; }

# 1. App sống và đang ở mock mode
curl -s $B/api/health; echo
curl -s $B/api/meta | json "['providers']"

# 2. Đăng nhập: nhận cookie mydubb_session (HttpOnly) và CSRF token
CSRF=$(curl -s -c "$JAR" -X POST -H 'Content-Type: application/json' \
  -d "{\"access_code\":\"$CODE\"}" $B/api/session | json "['csrf_token']")

# 3. Tạo job. Thiếu X-CSRF-Token sẽ nhận 403 csrf_failed.
ID=$(curl -s -b "$JAR" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"transcript":"Spring Boot uses Dependency Injection to manage objects.\nKubernetes schedules the containers.","first_sentence_start":"00:00:10","last_sentence_start":"00:00:40","voice":"EmmaMultilingual","target_language":"japanese","speed":1.25}' \
  $B/api/jobs | json "['id']")
echo "job: $ID"

# 4. Poll đến trạng thái cuối
while :; do
  S=$(curl -s -b "$JAR" $B/api/jobs/$ID | json "['status']"); echo "$S"
  [ "$S" = completed ] || [ "$S" = failed ] && break
  sleep 1
done

# 5. Kết quả và file MP3
curl -s -b "$JAR" $B/api/jobs/$ID/result | json "['notices']"
curl -s -b "$JAR" -o /tmp/mydubb-demo.mp3 "$B/api/jobs/$ID/result/audio?download=1"
ls -l /tmp/mydubb-demo.mp3
```

✅ Đoạn script trên đã chạy nguyên văn với app bật bằng `run-app.sh`. Output thật (dòng `ls` đã lược
tên user):

```
{"status":"ok"}
{'translation': 'mock', 'speech': 'mock', 'audio': 'mock'}
job: ac35e66f-b2ef-42c1-b514-301e169d3859
translating
synthesizing
processing
processing
completed
['The Japanese text is illustrative mock content, not a real translation.', 'The audio is a fixed development fixture. It was NOT generated from your transcript and does NOT match the target duration.', 'Audio speed 1.25x was selected, but this audio processor does not adjust duration, so the audio is neither the baseline length nor the length that speed would give.']
-rw-r--r-- 1 ... 12225 Nov 26 18:01 /tmp/mydubb-demo.mp3
```

Đọc output này thế nào:

- Job trả về ngay với `202`; công việc chạy nền và bạn thấy nó đi qua từng trạng thái.
- Ba notice cho biết đang ở mock mode: bản dịch là minh họa, audio là file mẫu, và speed 1.25x không
  được áp dụng vì audio processor mock không điều chỉnh độ dài
  ([jobs/router.py:427](../backend/app/jobs/router.py#L427)).
- Response của job vẫn tính đúng theo nghiệp vụ: baseline 30 giây, speed 1.25, nên
  `output_duration_seconds` là 24.0.

Thử thêm để hiểu hệ thống (✅ đều đã chạy trên backend local):

- Bỏ header `X-CSRF-Token` ở bước 3 → `403 {"error":{"code":"csrf_failed",...}}`.
- Đổi chỗ hai timestamp → `422 validation_error` với `fields[0].field = "last_sentence_start"`.
- Gọi `GET /api/jobs/$ID` không kèm cookie → `401`.
- Thêm `"timing_mode":"timed"` và transcript có timestamp đứng riêng từng dòng
  (`0:10\nCâu một.\n0:20\nCâu hai.\n0:40\nCâu ba.`) → kết quả có thêm khối `timing` với `captions: 3`,
  `blocks: 2`.
- `DELETE /api/session` kèm CSRF → `204`, sau đó `GET /api/session` trả `401`.

---

## 8. Lộ trình đọc code

Đọc theo thứ tự, mỗi chặng khoảng 30 đến 60 phút.

**Chặng 1: sản phẩm và hiện trạng**
1. [README.md](../README.md): góc nhìn người dùng.
2. [context.md](context.md): hiện trạng, quyết định đã chốt, những gì nằm ngoài phạm vi.
3. [ARCHITECTURE.md](ARCHITECTURE.md): hai phần đầu (module, job lifecycle).

**Chặng 2: xương sống của backend**
4. [main.py:184](../backend/app/main.py#L184) `create_app`: router nào được gắn, lifespan làm gì.
5. [services.py:294](../backend/app/services.py#L294) `build_services`: mọi thứ được nối với nhau ở đây.
6. [config.py:102](../backend/app/config.py#L102) `Settings` và [config.py:342](../backend/app/config.py#L342).
7. [dependencies.py](../backend/app/dependencies.py): ai được gọi endpoint nào.

**Chặng 3: một job từ đầu đến cuối**
8. [jobs/schemas.py:30](../backend/app/jobs/schemas.py#L30) → [jobs/router.py:99](../backend/app/jobs/router.py#L99)
   → [jobs/pipeline.py:207](../backend/app/jobs/pipeline.py#L207) → [jobs/service.py:95](../backend/app/jobs/service.py#L95).
9. Ba bản mock, vì chúng ngắn và cho thấy hợp đồng của từng bước:
   [translation/mock.py](../backend/app/translation/mock.py#L49),
   [speech/mock.py](../backend/app/speech/mock.py#L23),
   [audio/mock.py](../backend/app/audio/mock.py#L11).
10. [tests/conftest.py](../backend/tests/conftest.py) và [tests/test_jobs.py](../backend/tests/test_jobs.py):
    cách viết test.

**Chặng 4: miền nghiệp vụ khó**
11. [transcript/cleaning.py](../backend/app/transcript/cleaning.py) và [transcript/timed.py](../backend/app/transcript/timed.py):
    docstring đầu file giải thích toàn bộ quy tắc.
12. [audio/speed.py](../backend/app/audio/speed.py) rồi [audio/fitter.py](../backend/app/audio/fitter.py).
13. [translation/glossary.py](../backend/app/translation/glossary.py) và [GLOSSARY.md](GLOSSARY.md).

**Chặng 5: frontend**
14. [App.tsx:73](../frontend/src/App.tsx#L73) → [DubbingForm.tsx:80](../frontend/src/features/dubbing/DubbingForm.tsx#L80)
    → [jobRequest.ts:45](../frontend/src/lib/jobRequest.ts#L45) → [JobPanel.tsx:32](../frontend/src/features/jobs/JobPanel.tsx#L32).
15. [test/authFetch.testkit.ts](../frontend/src/test/authFetch.testkit.ts): cách mock `fetch` trong test.

**Chặng 6: tùy việc bạn sắp làm**
- Xác thực: [AUTHENTICATION.md](AUTHENTICATION.md), [auth/router.py](../backend/app/auth/router.py).
- Guest và quota: [GUEST_ACCESS.md](GUEST_ACCESS.md), [API.md, Usage limits](API.md#usage-limits).
- Extension: [extension/README.md](../extension/README.md), [EXTENSION_AUTH.md](EXTENSION_AUTH.md).
- Triển khai: [DEPLOYMENT.md](DEPLOYMENT.md), [WORKFLOW.md](WORKFLOW.md).

---

## 9. Checklist trước khi implement một feature mới

**Trước khi viết code**
- [ ] Đọc [context.md](context.md) để chắc feature không nằm trong danh sách "ngoài phạm vi". Product
      Owner quyết định phạm vi, chi phí và tiêu chí nghiệm thu.
- [ ] Tạo branch từ `main` mới nhất: `git switch main && git pull && git switch -c <type>/<topic>`.
- [ ] Chạy được [kịch bản mục 7](#7-kịch-bản-end-to-end-nhỏ-để-tự-chạy) và bộ test liên quan trên
      máy mình **trước** khi sửa, để biết trạng thái ban đầu (lưu ý hai nhóm flaky ở mục 6).

**Thiết kế**
- [ ] Xác định module chịu trách nhiệm (bảng ở 2.3). Giữ ranh giới: router mỏng, logic trong service
      hoặc hàm thuần, pipeline không biết HTTP.
- [ ] Cần provider mới hoặc dịch vụ ngoài? Thêm một class theo `Protocol` sẵn có, kèm bản mock, và
      nối trong [services.py](../backend/app/services.py). Không fallback ngầm sang mock.
- [ ] Cần cấu hình mới? Thêm field vào `Settings`, thêm quy tắc kiểm tra nếu có tổ hợp không an toàn,
      và cập nhật [.env.example](../.env.example).
- [ ] Đổi schema? Viết migration Alembic mới trong [alembic/versions](../backend/alembic/versions/).
      Migration phải **expand-only** (chỉ thêm, cột mới nullable hoặc có default) vì instance cũ vẫn
      phục vụ trong lúc deploy ([entrypoint.sh:6](../docker/entrypoint.sh#L6)). CI chạy
      upgrade → downgrade → upgrade.
- [ ] Endpoint mới: chọn đúng dependency phân quyền (`require_session`, `require_job_access_csrf`,
      `require_admin`, ...) và trả lỗi qua `ApiError` với `code` riêng.
- [ ] Feature đụng tới guest, quota hoặc extension? Kiểm tra cả bốn loại principal.

**Trong khi viết**
- [ ] Không log, không lưu transcript, bản dịch, key hay token. Log chỉ ghi job ID và mã lỗi.
- [ ] Thêm table mới thì thêm vào câu `TRUNCATE` của fixture
      [`db_engine`](../backend/tests/conftest.py#L81), nếu không test sẽ rò dữ liệu sang nhau.
- [ ] Thêm ngôn ngữ, voice hoặc speed thì phải cập nhật cả enum, `CHECK` constraint trong
      [models.py](../backend/app/jobs/models.py#L42) và migration tương ứng.
- [ ] Frontend: đọc mọi khả năng của server từ `/api/meta`, không hard-code.

**Trước khi mở pull request**
- [ ] Backend: `uv run ruff check . && uv run ruff format --check . && uv run pytest`.
- [ ] Frontend: `npm run lint && npm run typecheck && npm test && npm run build`.
- [ ] Extension (nếu đụng tới): `npm run lint && npm run typecheck && npm test && npm run build && npm run check:dist`.
- [ ] E2E nếu đổi luồng người dùng: `cd e2e && bash run-e2e.sh`.
- [ ] Cập nhật tài liệu liên quan và [context.md](context.md) **trong cùng pull request**
      ([WORKFLOW.md](WORKFLOW.md#branch-workflow)).
- [ ] `git diff --cached`: không có `.env`, key, Access Code thật hay dữ liệu người dùng.
- [ ] Mở PR vào `main`. Chỉ merge khi check **CI success** xanh và Product Owner duyệt, dùng
      **Squash and merge**. Merge vào `main` có thể kích hoạt deploy production.

---

## 10. Bẫy thường gặp

1. **Node 22 chưa chắc đủ.** `frontend/.npmrc` bật `engine-strict`, và một dependency gián tiếp trong
   lockfile (`@asamuzakjp/css-color@7.1.7`, kéo theo bởi jsdom) yêu cầu
   `^22.22.2 || ^24.15.0 || >=26.0.0`. Với Node 22.14.0, `npm ci` dừng với `EBADENGINE`. Dùng Node
   ≥ 22.22.2. Thư mục `extension/` không có `.npmrc` nên chỉ cảnh báo.
2. **`npm test` của frontend flaky trên máy nhiều nhân.** Dùng `npx vitest run --maxWorkers=4`
   (mục 6.2).
3. **pytest chậm trên Windows.** Cả bộ mất hơn 15 phút khi PostgreSQL chạy qua Docker Desktop. Khi
   phát triển, chạy theo file: `uv run pytest tests/test_jobs.py -q`.
4. **`python3` trên Windows có thể là stub của Microsoft Store.** `docker/smoke-test.sh` mặc định
   gọi `python3`; đặt `PYTHON=python` khi chạy ([smoke-test.sh:8](../docker/smoke-test.sh#L8)).
5. **Volume database chỉ khởi tạo một lần.** Script tạo `mydubb_test` chỉ chạy khi volume `pgdata`
   được tạo lần đầu. Nếu thiếu database test, chạy `./stop-app.sh --purge` rồi bật lại.
6. **Sai Access Code 5 lần trong 15 phút sẽ bị khóa** (`429 too_many_attempts`). Bộ đếm nằm trong
   RAM; khởi động lại backend là hết.
7. **Mock mode không điều chỉnh độ dài audio.** Muốn thấy duration fitting thật cần
   `SPEECH_PROVIDER=azure` và `AUDIO_PROCESSOR=ffmpeg`, tức là cần key Azure. Không có key thì đọc
   test trong [test_audio_fitting.py](../backend/tests/test_audio_fitting.py).
8. **Tài liệu có chỗ cũ hơn code.** Sơ đồ đầu [ARCHITECTURE.md](ARCHITECTURE.md) chỉ vẽ ba router,
   trong khi code hiện có mười một router ([main.py:18](../backend/app/main.py#L18)), gắn năm hoặc
   mười cái tùy `AUTH_MODE`.
   [README-original.md](README-original.md) ghi bảng CI có bốn job, còn
   [ci.yml](../.github/workflows/ci.yml) có sáu. Khi tài liệu và code khác nhau, tin code và báo lại.
9. **Cấu hình mặc định khác production.** Mặc định trong code và `.env.example` là mock, Access Code,
   guest tắt. Production dùng cấu hình khác; đừng suy ra trạng thái production từ repo.

---

## 11. Tài liệu đọc tiếp

| Chủ đề | Tài liệu |
|---|---|
| Thiết kế, vòng đời job, từng milestone | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Hợp đồng HTTP | [API.md](API.md), [AUTH_API.md](AUTH_API.md) |
| Xác thực, Cognito, admin | [AUTHENTICATION.md](AUTHENTICATION.md), [AUTH_UI.md](AUTH_UI.md), [SIGNUP.md](SIGNUP.md) |
| Guest access | [GUEST_ACCESS.md](GUEST_ACCESS.md) |
| Extension | [EXTENSION_AUTH.md](EXTENSION_AUTH.md), [extension/README.md](../extension/README.md) |
| Glossary | [GLOSSARY.md](GLOSSARY.md) |
| Usage và chi phí | [USAGE_COSTS.md](USAGE_COSTS.md) |
| Branch, CI, CD | [WORKFLOW.md](WORKFLOW.md) |
| Triển khai Render, Neon, Azure | [DEPLOYMENT.md](DEPLOYMENT.md) |
| E2E | [e2e/README.md](../e2e/README.md) |
