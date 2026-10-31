# MyDubb — Context khởi động

Bản rút gọn để nạp mặc định (2026-10-30). Bản đầy đủ trước khi rút gọn, gồm milestone, bằng chứng test, PR/SHA và lịch sử: [history/context-before-compaction-2026-10-30.md](history/context-before-compaction-2026-10-30.md) — chỉ đọc khi cần truy nguồn, không nạp mặc định. Nội dung đã tới story **Six output languages** (nội dung bản đầy đủ ghi mốc 2026-10-29); sau đó Chrome extension story 1 (PR #40) và story 2 (Generate trong extension, mục 4).

## 1. Cách dùng file này

- Đọc file này trước, rồi implementation prompt hiện tại và tài liệu liên quan ở mục 7. Task đang chạy nằm ở prompt riêng, không chép vào đây.
- Đối chiếu branch, working tree, PR, CI, deployment thực tế trước khi hành động; không tin SHA/run cũ.
- Phân biệt: yêu cầu đã chốt → đang implement → PR chờ review → đã merge → CI main pass → đã deploy → đã kiểm chứng production. Không dùng thay nhau. **Cấu hình mặc định (code/env example) khác trạng thái production.**
- Tài liệu và code khác nhau: báo rõ khác biệt; quyết định sản phẩm đã chốt vẫn phải được đáp ứng, không tự đổi theo code.
- Context cập nhật **trong chính PR của story**: ghi ngắn chức năng đổi, hành vi cần giữ cho story sau, kiểm chứng thực sự đã làm, giới hạn/việc còn mở. Không ghi theo dõi merge/deploy, test report dài, danh sách CI run/SHA; chi tiết vào docs chuyên biệt hoặc PR.
- Không lưu secrets, Access Code, connection string, transcript người dùng, raw logs.
- [mydubb-context.md](../mydubb-context.md) là planning handoff ban đầu (lịch sử; các yêu cầu chưa bị thay thế vẫn có giá trị).

## 2. Sản phẩm

MyDubb giúp người Việt học nội dung tiếng Anh kỹ thuật: người dùng paste English transcript (hoặc import caption YouTube có sẵn vào form), hệ thống dịch phần diễn giải, giữ thuật ngữ English, tạo giọng đọc, nghe và tải MP3. Mỗi job chọn một trong tám ngôn ngữ đích: `vietnamese` (**mặc định**, sản phẩm chính), `mandarin_simplified`, `hindi`, `spanish`, `arabic`, `french`, `russian`, `japanese`. Nguồn luôn là English.

- Website responsive, truy cập invite-only (email/password qua Amazon Cognito, admin mời) cộng "Try as guest" có quota. Studio: transcript + hai timestamps, voice, speed, ngôn ngữ đích, xem bản dịch, nghe, tải MP3.
- Ngoài scope: video upload/player, tự lấy transcript Udemy, Speech-to-Text, đồng bộ từng câu, native app, Chrome extension ngoài prototype Load unpacked (mục 4 "Chrome extension prototype"), public sign-up, subscription, voice cloning, lưu audio vĩnh viễn, glossary UI, dịch giao diện, tự nhận diện ngôn ngữ nguồn.
- Giữ module boundaries và provider interfaces; không xây microservices/Kafka/Kubernetes/agent runtime cho tương lai giả định.
- Product Owner (người dùng) quyết scope, chi phí, acceptance và **tự merge PR thủ công**. Claude là coding agent chính; Codex hỗ trợ planning/review. Giao tiếp bằng tiếng Việt, giữ technical terms tiếng Anh. Không tự làm feature ngoài task, không nâng paid tier, không đổi quyết định sản phẩm.

## 3. Kiến trúc và provider

| Thành phần | Hiện trạng |
|---|---|
| Frontend | React + TypeScript + Vite, Studio responsive, Light mặc định + Dark, UI tiếng Anh, Vitest, Playwright |
| Backend | Python 3.12, FastAPI, uv; modular monolith, handlers tách business logic |
| Pipeline | TranslationProvider → SpeechProvider → AudioProcessor → ResultStore; wiring ở `services.py`; ngôn ngữ đích cố định ở `backend/app/languages.py` |
| Execution | Một instance, một uvicorn process, worker threads + queue trong RAM, chưa có durable queue |
| Database | PostgreSQL 17, SQLAlchemy/Alembic (Neon Free, Oregon) |
| Hosting | Docker multi-stage, FastAPI phục vụ React build cùng origin; Render Free Oregon; https://mydubb.com |
| Chrome extension | Prototype `extension/` (MV3, TypeScript + esbuild, side panel), Load unpacked, không publish; gọi API MyDubb bằng bearer token của tài khoản invitation (story 2) |
| CI/CD | GitHub Actions, Render auto-deploy sau checks pass |

Provider (mặc định cấu hình đều là mock/off; production khác mặc định):
- Translation `TRANSLATION_PROVIDER=mock|azure` (Azure Translator v3.0, F0). Speech `SPEECH_PROVIDER=mock|azure` (Azure Speech REST, F0, key riêng). Audio `AUDIO_PROCESSOR=mock|ffmpeg`. `PROVIDER_MODE=azure` = cả ba thật. YouTube import `YOUTUBE_IMPORT_PROVIDER=off|supadata|mock` (mặc định `off`; `mock` bị từ chối ở production).
- **Production** (quan sát 2026-10-27, `GET /api/meta`): azure/azure/ffmpeg, `AUTH_MODE=cognito`, guest access bật, YouTube import bật (Supadata). Trạng thái production hiện tại cần kiểm lại, không suy từ file này.
- Chọn provider thật mà thiếu credential/FFmpeg thì app không khởi động. Không retry tự động, không fallback sang mock/ngôn ngữ khác, một chunk lỗi thì job lỗi, không có kết quả một phần. Log không chứa key, transcript, bản dịch, SSML.

Vận hành cần giữ:
- States `queued → translating → synthesizing → processing → completed/failed`; compare-and-set chống stale worker; UI hiện stage thật. Job mất worker → `failed/interrupted`, không tự chạy lại provider khi kết quả chưa rõ.
- Result store publish bằng rename; result TTL 1 giờ, session TTL 12 giờ; mất/hết hạn trả `410 result_expired`. Metadata job chưa tự cleanup. Disk ephemeral, cold start, không scale ngang.
- Transcript xử lý tạm, metadata tối thiểu trong DB, không lưu audio binary vào DB. Production mock cần `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`; có HSTS và CSP.
- **Migrations** chạy khi container khởi động và phải backward compatible; target image phải biết Alembic revision hiện tại. Head hiện tại là **`0011`** (`0003` speed, `0004` glossary candidates, `0005/0006` auth, `0007` guest, `0008` guest import quota, `0009` `jobs.target_language`, `0010` tám ngôn ngữ, `0011` `user_sessions.client` + `extension_auth_codes`). Image cũ hơn các revision đã deploy không còn là rollback target; roll forward là mặc định; bỏ migration step để chạy code cũ là đường khẩn cấp cần Product Owner duyệt; không tự downgrade production DB. Chi tiết: DEPLOYMENT.md, AUTHENTICATION.md.

## 4. Quyết định bắt buộc bảo vệ

### Duration, speed, timing
- Hai input: **First Sentence Start** và **Last Sentence Start** (lúc câu cuối *bắt đầu*). `baseline = last − first` (API: `target_duration_seconds`), backend tính và validate, frontend chỉ preview. Timestamp API `HH:MM:SS`, last > first.
- Audio speed: `0.5, 0.75, 1, 1.25, 1.5, 1.75, 2` (mặc định 1x). Output = baseline / speed; `target_samples = round_half_up(baseline × sample_rate / speed)` bằng số nguyên. 1x là fit về baseline, không phải tốc độ tự nhiên. Speed đổi file tạo ra; player luôn `playbackRate = 1`. Thiếu speed = 1x; job cũ đọc là 1x.
- Đọc đủ transcript kể cả câu cuối; không cộng thời gian câu cuối, không cắt nội dung. Với `AUDIO_PROCESSOR=ffmpeg` output đúng target (PCM và MP3 decode lệch tối đa 1 sample); mock không bảo đảm duration.
- Plain mode (mặc định): tempo toàn bộ audio về target, không căn từng câu.
- Timed mode (`timing_mode: "timed"`, caption YouTube có timestamp riêng dòng): đặt theo caption, baseline nguồn = caption cuối − caption đầu; nếu người dùng sửa baseline thì vị trí được scale. Grouping cố định ngưỡng 2x (2x là mục tiêu, không hard cap); clip ngắn giữ tốc độ tự nhiên + silence, dài thì tăng tempo giữ pitch; không cắt lời, không tràn khung, không fit toàn file lần hai. Đồng bộ là **ước lượng theo nhóm**. Timestamp lỗi → báo lỗi, người dùng tự chọn plain; không fallback âm thầm. SRT/VTT chỉ plain. Cần FFmpeg khi speech thật (`409 timing_mode_unavailable` nếu không). Known limitation chấp nhận cho beta: mapping break sai hiếm vẫn có thể pass (ARCHITECTURE.md "Timed dubbing").
- Ô timestamp: người dùng gõ số, UI chèn ":" theo cặp, không tự thêm chữ số/clamp/đổi 75 phút; backend là nơi validate duy nhất. Transcript cleaning phải giữ nội dung mơ hồ như `10:30 is our meeting time.` (API.md).

### Dịch, giọng đọc, ngôn ngữ, glossary
- Dịch phần diễn giải tự nhiên, **giữ nguyên thuật ngữ English** (technology, chuyên môn, khoa học); không thêm giải thích/tóm tắt/phiên âm. Paid LLM translation chưa được duyệt; provider phải thay được.
- Voices: `AndrewMultilingual` (mặc định) → `en-US-AndrewMultilingualNeural`, `EmmaMultilingual` → `en-US-EmmaMultilingualNeural`. `HoaiMy`/`NamMinh` đã thay thế, request mới dùng bị từ chối; job cũ vẫn đọc được. Một voice, một speaker mỗi audio; SSML `<lang>` cho phần đích và `en-US` cho term English (glossary, và English còn lại trong bản dịch khi chắc chắn; từ có thể là Vietnamese giữ `vi-VN`).
- Ngôn ngữ đích: server map cố định (Translator + Speech locale: `vi`/`vi-VN`, `zh-Hans`/`zh-CN`, `hi-IN`, `es-ES`, `ar-SA`, `fr-FR`, `ru-RU`, `ja-JP`); client không gửi locale/endpoint/voice. Lưu theo job (`jobs.target_language`); thiếu field và job cũ = Vietnamese; UI hiện ngôn ngữ đã lưu của job. Không có sáu pipeline riêng: chỉ quy tắc văn bản theo script (`speech/plan.py`, `pronunciation/policy.py`); Vietnamese và Mandarin không được đổi hành vi. Arabic = MSA `ar-SA`, hiển thị RTL chỉ trong khung bản dịch. Spanish/French chỉ đọc `en-US` cho glossary term có trong source, code, acronym. Quota không tính theo ngôn ngữ. Chi tiết: ARCHITECTURE.md "Output language".
- Glossary: `backend/app/translation/data/glossary.txt` (2.141 entry) là nguồn duy nhất lúc runtime, đổi qua PR được review, có hiệu lực sau deploy; quy tắc/chính sách chọn term trong [GLOSSARY.md](GLOSSARY.md). Có bản dịch chuẩn không phải lý do loại một technical term; loại/dùng `=` cho từ đa nghĩa, từ thường, từ trùng âm tiết Việt. Glossary chưa hứa bảo vệ mọi term, chưa đánh giá riêng cho các ngôn ngữ ngoài Vietnamese. Candidate store (`glossary_candidates`, migration `0004`) là **legacy**, vẫn ghi sau mỗi job; giữ/xoá là task riêng.
- Chi phí: ưu tiên free tier; không tự nâng tier, đổi paid provider hay fallback âm thầm; quota provider hết phải báo rõ. Markup glossary tính vào ký tự Translator.

### Authentication
- Production `AUTH_MODE=cognito`: Cognito user pool riêng (us-west-2, email-only, invite-only, không MFA). MyDubb giữ session riêng (cookie `mydubb_auth` HttpOnly/SameSite=Strict/Secure, DB chỉ lưu SHA-256, TTL 12 giờ), không gửi token Cognito xuống browser; CSRF `X-CSRF-Token` + Origin check; email phải `email_verified`. Job thuộc **user**; user khác hoặc job thời Access Code trả `404`. Challenge dở mã hoá bằng `AUTH_TOKEN_ENCRYPTION_KEY` (giữ cố định). Reset password thu hồi mọi session; fail closed khi không chắc. Hai auth mode loại trừ nhau; `access_code` còn trong code làm đường rollback (đổi cách truy cập production cần Product Owner duyệt; `ACCESS_CODE` vẫn trên Render). Tránh đăng nhập sai/gửi email Cognito không cần thiết trên production. Chi tiết: [AUTHENTICATION.md](AUTHENTICATION.md), [AUTH_API.md](AUTH_API.md), [AUTH_UI.md](AUTH_UI.md).
- Chrome extension: MyDubb tự làm Authorization Code + PKCE (S256) qua trang `/extension/connect` (đăng nhập web bình thường rồi **Connect extension**), extension mở bằng `chrome.identity.launchWebAuthFlow`; redirect duy nhất `https://<id>.chromiumapp.org/` khớp chính xác `EXTENSION_IDS` (mặc định rỗng = tắt, `404 extension_disabled`). Code một lần, 2 phút, bị tiêu ở lần thử đầu kể cả sai. Token opaque là dòng `user_sessions` `client='extension'` (SHA-256, ≤ 12 giờ, không gia hạn) nên mọi revocation hiện có áp dụng; cookie không nhận token extension và bearer không nhận cookie token; bearer chỉ cho `/api/jobs*` + `/api/extension/session|logout`, không CSRF, Origin `chrome-extension://<id>` chỉ cho token/jobs POST/logout. Không đổi Cognito, không CORS, không đọc cookie. Chi tiết: [EXTENSION_AUTH.md](EXTENSION_AUTH.md).

### Guest ("Try as guest")
- Mặc định cấu hình **tắt** (`GUEST_ACCESS_ENABLED=false`), chỉ với `AUTH_MODE=cognito`; production quan sát **bật** (2026-10-27; ngày bật/người bật không ghi trong repo). Guest là principal riêng (`mydubb_guest` cookie, bảng `guest_sessions` lưu SHA-256, 24 giờ tuyệt đối, không gia hạn); chỉ job endpoints, `/api/guest/session` và import nhận guest; endpoint tài khoản không bao giờ nhận. Mở trang, tạo session, đọc quota không gọi Azure/Supadata.
- Quota (backend quyết định, UI chỉ preview): **5 job completed / session**, **20 / client network / 24 giờ trượt**, **1.000 từ / job** (`spoken_text`), **audio ≤ 600 giây** (baseline / speed; `422 guest_duration_limit_exceeded`, không clamp). Quota import riêng: **5 import thành công / session, 20 / network / 24 giờ**, tách hẳn khỏi quota job. Reserve cùng transaction với job (import: commit trước khi gọi Supadata); completed/`used` → dùng; failed/interrupted/lỗi provider → hoàn; settle một lần; recovery chỉ đụng operation có heartbeat stale. Tài khoản invitation không có các giới hạn này và không có quota import.
- Network = IP từ đúng một header `CLIENT_IP_HEADER` (production `cf-connecting-ip`); thiếu/lặp/sai → `503 guest_network_unknown` (fail closed); không đọc `X-Forwarded-For`; IPv6 gom /64; DB chỉ lưu HMAC-SHA256 với `GUEST_IP_HASH_KEY` (khác `AUTH_TOKEN_ENCRYPTION_KEY`). Không fingerprint/CAPTCHA/xác minh email.
- **Chưa xác minh:** chống giả mạo IP trên Render. "Spoofing check" (GUEST_ACCESS.md) chưa có bằng chứng đã chạy trên `mydubb.com` và `mydubb.onrender.com`; không coi là pass. Product Owner quyết định chạy check và giữ hay tắt guest. Chi tiết: [GUEST_ACCESS.md](GUEST_ACCESS.md).

### Import transcript từ YouTube
- Hai đường vào form: paste (mặc định, luôn hoạt động) hoặc YouTube URL → **Import transcript**. Import chỉ **điền form**; không tạo job, không gọi Azure; job dùng nội dung form lúc submit; không lưu link/transcript vào browser storage.
- Chỉ English captions video **đã có**, Supadata `mode=native`; không `auto`/`generate`, không tải audio/video, không STT, không dịch. Việc auto-generated captions có thuộc `native` hay không **chưa kiểm chứng**.
- Format bàn giao ([API.md](API.md#timestamped-transcript-format)): dòng start time `M:SS.mmm` rồi dòng text; không gộp/sort/dedupe; đọc lại qua `clean_transcript`, không biểu diễn được thì từ chối `youtube_import_not_representable`. Hai ô First/Last gợi ý = start caption đầu/cuối **cắt xuống giây**; cùng giây thì để trống.
- Bảo mật/tài nguyên: session + CSRF + Origin; URL canonicalize, endpoint Supadata cố định; request khởi tạo **không bao giờ retry** (tốn credit); `YOUTUBE_IMPORT_MAX_CONCURRENT` (503 khi đầy, không queue); `SUPADATA_API_KEY` chỉ ở backend; Supadata 401/403 không thành 401 của MyDubb. UI hỏi trước khi ghi đè form, bỏ response đến muộn.

### Chrome extension prototype (story 1 + story 2)
- Story 1: Udemy lecture → bôi chọn → context menu **Send to MyDubb** → side panel **riêng của tab đó** hiện đúng text (giữ xuống dòng, không diễn giải HTML), textarea sửa được, Clear, hỏi trước khi thay draft đã sửa. Panel điều khiển video thật: Play/Pause, ±5 s (clamp trong seekable range), time/duration theo media events; không đổi mute/volume/playbackRate. Product Owner đã thử trên Udemy thật và xác nhận pass.
- Story 2: **Connect MyDubb** (chỉ tài khoản invitation, không guest) → form trong panel → **Generate audio** → theo dõi job → bản dịch + player MP3 trong panel. Language/voice/default lấy từ `GET /api/meta`; speed, timestamp input, timed/plain, điền First/Last từ caption, preview length và **body request** dùng chung module web (`frontend/src/lib/*`, gồm `jobRequest.ts` trích từ DubbingForm), không copy. Chỉ gửi transcript + lựa chọn (không URL/tiêu đề/lecture id Udemy). Chi tiết: [extension/README.md](../extension/README.md).
- Giữ cho story sau: quyền chỉ `contextMenus`, `sidePanel`, `storage`, `identity` + host đúng một origin MyDubb của build (`MYDUBB_ORIGIN`, mặc định `https://mydubb.com`) + content script `https://www.udemy.com/*` top frame (không `<all_urls>`/`tabs`/cookies/history/`scripting`); `npm run check:dist` khoá danh sách này và cấm hook test. Draft, form, job record và token chỉ ở `chrome.storage.session` (TRUSTED_CONTEXTS), không bao giờ tới content script/DOM Udemy; xoá khi đóng tab. Content script im lặng tới khi panel kết nối. Nhiều video → không lấy cái đầu tiên. Lệnh mang lecture key + video id (`stale` nếu khác). Draft/job/form gắn lecture key và được so với **mọi** page state; đổi bài → xoá draft, dừng audio, ẩn kết quả (job backend vẫn chạy); reload/mở lại cùng bài → giữ. Service worker không giữ state, không tham gia gọi MyDubb (panel tự poll).
- Job: một POST mỗi click (khoá nút tới khi có trả lời), input chụp lại lúc click; timeout 60 s/mất response → **không retry**, báo "không biết job đã tạo chưa" (record `sending` ghi trước khi gửi, mở lại panel vẫn báo). Poll 1 s ×1.5 tới 10 s, giới hạn 30 phút, 5 lỗi liên tiếp, dừng khi completed/failed/401/đổi bài/đổi tài khoản/đóng panel; mở lại panel cùng tài khoản + bài → theo dõi tiếp. Mọi response so với connection + lecture + operation id, kiểm tra lại sau mỗi await storage; ghi/xoá job record chạy tuần tự và chỉ cho đúng operation (callback cũ không abort polling hay ghi đè record mới). Mở panel: đọc form/account/job đã lưu trước, giữ lại selection/page state đến trong lúc đọc rồi áp dụng sau, nên snapshot cũ không ghi đè timestamp mới (override thủ công cùng draft/bài vẫn giữ). Deadline/cancellation bao cả lúc đọc body (JSON 30 s, POST 60 s, MP3 120 s); phân biệt timeout, huỷ và response không đọc được; tải MP3 lỗi có Check again. MP3 tải bằng bearer thành Blob → object URL (thu hồi khi thay/đổi identity/đổi bài/đóng panel), `playbackRate` 1, không autoplay. Đổi/ngắt tài khoản → mọi panel xoá kết quả; draft (selection Udemy) giữ.
- Đã kiểm chứng **chỉ local/CI**: backend `test_extension_auth.py` (fake Cognito, Postgres disposable), frontend `ExtensionConnect`/`jobRequest` tests, extension Vitest + Playwright nạp extension thật với fixture Udemy tổng hợp và **fake MyDubb** `https://mydubb.test` (hook test thay cửa sổ `launchWebAuthFlow`, chỉ có trong `dist-test/`). Không gọi Cognito/Azure/Supadata, không tạo job production.
- **Chưa kiểm chứng**: `launchWebAuthFlow` thật với mydubb.com (cửa sổ có dùng chung cookie profile hay không — cả hai trường hợp đều xử lý), Story 2 trên Udemy thật, production (chưa có `EXTENSION_IDS`). Product Owner cần: Load unpacked, lấy extension ID, đặt `EXTENSION_IDS=["<id>"]` trên Render (ID unpacked phụ thuộc đường dẫn thư mục; bản Web Store sẽ có ID khác), rồi nghiệm thu theo README "Acceptance".
- Để story sau: guest trong extension, đồng bộ audio–video, floating player, lấy caption tự động, YouTube import trong extension, nút tải MP3, danh sách job, publish Web Store (ID cố định).

## 5. Contract và giới hạn cho story tiếp theo

- API/timing/cleaning/errors: [API.md](API.md). Timestamp field rules: API.md "Timestamp fields in the UI".
- Contract `POST /api/jobs`: `target_language`, `speed`, `timing_mode` đều tùy chọn với default giữ hành vi cũ; mọi trường mới phải backward compatible (job/request cũ không đổi). Studio và extension tạo body bằng cùng `frontend/src/lib/jobRequest.ts`.
- Tempo cực lớn/nhỏ chỉ bị giới hạn kỹ thuật (WAV trung gian ~11 giờ); chưa đo FFmpeg trên CPU Render Free với audio dài.
- Chất lượng chưa có người nghe: Mandarin và sáu ngôn ngữ mới (phát âm xen English, timed mode); mới có mẫu local/live có ngân sách, chưa chạy transcript khóa học dài thật, chưa kiểm production cho các ngôn ngữ này. Timed mode chỉ nghiệm thu trên hai mẫu synthetic.
- Quy tắc test: tests có thể drop/recreate schema → chỉ chạy trên DB test disposable, không production. Production smoke không đăng nhập.

## 6. Quyết định còn mở

- **Metadata retention:** 7 ngày mới là đề xuất, chưa triển khai cleanup.
- **Chi phí/tier:** Product Owner tự xác nhận Azure Translator và Speech là Free F0 và theo dõi allowance (Claude không xem được portal); budget GitHub Actions $0 + hard stop chưa xác nhận. Guest dùng chung allowance Azure F0 và credit Supadata (Free 100 credit/tháng) — cần theo dõi usage.
- **Guest:** Spoofing check chưa có bằng chứng (mục 4); chính sách lạm dụng qua nhiều network; xác nhận lại `cf-connecting-ip`.
- **Duration format:** nếu cần chính xác cả với player bỏ qua metadata MP3 thì phải đổi format (WAV/AAC) — thay đổi API cần quyết định riêng.
- **Glossary quality:** cần transcript khóa học thật để tìm term thiếu/đa nghĩa; chưa xem lại cho các ngôn ngữ ngoài Vietnamese. Glossary UI và auto term detection ngoài scope. Quyết định giữ/ngừng/xoá `glossary_candidates` (legacy).
- **Translation provider:** v3.0 đang dùng; đổi API `2026-06-06` hoặc provider khác cần lý do và live test riêng. Chưa đánh giá English trùng âm tiết Việt (`run`, `Go`), cách đọc code/path.
- **Authentication:** chuyển email sang SES (có phí) nếu vượt giới hạn; cách công bố password policy; thời điểm xoá `ACCESS_CODE` khỏi Render; MFA/account settings/admin portal ngoài scope.
- **Timed mode:** thử transcript dài thật (latency, khung > 2x, speed khác nhau); thu hẹp residual risk mapping; dùng timing của SRT/VTT; ước lượng âm tiết token lạ.
- **Image ~1,04 GB** (Debian `ffmpeg`): chỉ xem lại nếu deploy/disk thành vấn đề.
- Chưa xác nhận: authenticated end-to-end trên iPhone/iPad thật; Safari/iPhone, Firefox, screen reader thật cho UI ngôn ngữ mới.

## 7. Workflow

- Task mới → **worktree/branch riêng** từ `origin/main` mới nhất; không dùng lại branch đã merge; không đụng thay đổi chưa commit của session khác. Một coding agent là mặc định; prompt cho Claude nêu model, effort, session mới hay cũ.
- **Docs cập nhật cùng PR** của story. PR do Claude mở; **Product Owner merge thủ công**. Không merge hộ.
- **CI đúng HEAD cuối** của PR trước merge; sau merge cần CI đúng merge SHA và deploy đúng SHA. Không dựa vào run cũ. `main` chưa có branch protection/ruleset (quan sát 2026-10-27) nên giữ quy tắc bảo vệ main thủ công ([WORKFLOW.md](WORKFLOW.md)).
- Chỉ sửa docs thì không chạy backend/frontend/E2E local; chạy docs checks và required CI.
- Dùng **RTK** (hook đã cài ở máy local, không cấu hình lại; không được mô tả trong repo). Khi cần output đầy đủ (log lỗi, diff dài, test failure) thì bypass RTK để không mất thông tin.
- Giữ sự thật hơn là đoán: thông tin chưa xác minh phải ghi rõ là chưa xác minh.

## 8. Bản đồ tài liệu

| Nhu cầu | Đọc |
|---|---|
| Giới thiệu sản phẩm, demo, giới hạn guest | [README](../README.md) |
| Setup local, checks, cảnh báo test DB | [README-original.md](README-original.md) |
| Module boundaries, lifecycle, timed dubbing, output language | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Glossary: format, chính sách term | [GLOSSARY.md](GLOSSARY.md) |
| API, timestamps, cleaning, errors, ownership | [API.md](API.md) |
| Branch/PR, CI, protections, cost control | [WORKFLOW.md](WORKFLOW.md) |
| Render/Neon, secrets, smoke, deploy, rollback | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Authentication: thiết kế, AWS, cutover/rollback | [AUTHENTICATION.md](AUTHENTICATION.md) |
| Auth HTTP contract / Sign-in UI | [AUTH_API.md](AUTH_API.md), [AUTH_UI.md](AUTH_UI.md) |
| Guest access: quota, cookie, IP, cách bật | [GUEST_ACCESS.md](GUEST_ACCESS.md) |
| Isolated browser tests | [E2E README](../e2e/README.md) |
| Chrome extension prototype: build, Load unpacked, permissions, nghiệm thu | [extension/README.md](../extension/README.md) |
| Kết nối extension với tài khoản (PKCE, `EXTENSION_IDS`, contract) | [EXTENSION_AUTH.md](EXTENSION_AUTH.md) |
| Planning handoff ban đầu (lịch sử) | [mydubb-context.md](../mydubb-context.md) |
| **Lịch sử đầy đủ: milestone, bằng chứng, PR/SHA, test reports** | [history/context-before-compaction-2026-10-30.md](history/context-before-compaction-2026-10-30.md) |
