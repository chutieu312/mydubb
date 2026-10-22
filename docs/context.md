# MyDubb — Context và handoff hiện tại

Cập nhật: **2026-10-22**. Mốc hoàn tất gần nhất: **Milestone 2B**. Đây là điểm bắt đầu cho session mới, tóm tắt quyết định sản phẩm và kết quả đã nghiệm thu. Task đang thực hiện được mô tả trong implementation prompt riêng, không chép vào file này.

## 1. Cách đọc và duy trì context

- Đọc file này trước, sau đó đọc implementation prompt hiện tại và tài liệu liên quan trong mục 7. Không cần đọc toàn bộ lịch sử cho mỗi task.
- Đối chiếu branch, working tree, PR, CI và deployment thực tế trước khi hành động. Các SHA dưới đây là mốc bàn giao, không phải giá trị luôn luôn mới nhất.
- Phân biệt: **đã chốt yêu cầu → đang implement → PR chờ review → đã merge → CI trên main pass → đã deploy → đã kiểm chứng production**. Không dùng các trạng thái này thay thế nhau.
- Nếu tài liệu và code khác nhau, báo rõ khác biệt. Code cho biết hành vi đang có; quyết định sản phẩm đã chốt vẫn cần được đáp ứng, không tự đổi theo code.
- Chỉ bổ sung kết quả milestone/task sau khi Product Owner nghiệm thu và các bước review, merge, CI, deploy/kiểm chứng áp dụng cho task đó đã hoàn tất. Code viết xong hoặc CI của PR pass chưa đồng nghĩa đã nghiệm thu.
- Khi được yêu cầu bổ sung một milestone đã hoàn tất, ghi kết quả thực tế, quyết định mới, SHA/bằng chứng kiểm chứng và giới hạn còn lại; không chép nguyên implementation prompt. Giữ file ngắn; đưa chi tiết vào docs chuyên biệt.
- Không lưu secrets, Access Code, connection string thật, transcript người dùng, raw logs hoặc toàn bộ cuộc hội thoại vào đây.
- [mydubb-context.md](../mydubb-context.md) là planning handoff ban đầu. Trạng thái “Planning Phase”, các phase và immediate tasks trong đó là lịch sử; dùng roadmap và trạng thái bên dưới cho công việc hiện tại. Những yêu cầu chưa bị thay thế vẫn có giá trị.

## 2. Sản phẩm và cách làm việc

MyDubb giúp người Việt học nội dung tiếng Anh, đặc biệt nội dung kỹ thuật: người dùng tự paste English transcript, hệ thống dịch phần diễn giải sang Vietnamese, giữ thuật ngữ English, tạo giọng Việt để nghe và download MP3.

- MVP: responsive website, Private Beta Access Code, transcript + hai timestamps, chọn voice, xử lý job, xem bản dịch, nghe và tải MP3.
- Không thuộc MVP: video upload/player, tự lấy transcript YouTube/Udemy, Speech-to-Text, sentence-by-sentence synchronization, browser extension, native apps, user registration, subscriptions, voice cloning và lưu audio vĩnh viễn.
- Tầm nhìn dài hạn: nhiều ngôn ngữ/voice, playback speeds, tích hợp nội dung được phép sử dụng, đồng bộ video, đa nền tảng. Đây là hướng mở rộng, chưa phải scope implement.
- Bắt đầu nhỏ nhưng giữ module boundaries và provider interfaces để mở rộng, thay provider hoặc chuyển Render sang AWS sau này. Không xây microservices/Kafka/Kubernetes/agent runtime chỉ để chuẩn bị giả định tương lai.
- Người dùng là Product Owner, quyết định scope, chi phí và acceptance; **tự merge PR thủ công**. Codex hỗ trợ planning, architecture, implementation prompts và review. Claude là coding agent chính.
- Giao tiếp/prompt/báo cáo bằng tiếng Việt, giữ technical terms bằng tiếng Anh. Không tự triển khai feature ngoài task hoặc nâng paid tier.
- Mỗi prompt cho Claude cần nêu **model, effort, tạo session mới hay giữ session cũ**, cùng context cần đọc. Thường Sonnet medium cho việc thường nhật; nâng effort/model khi task khó. Giữ session/model khi cùng task; task/PR mới là điểm thích hợp tạo session mới. Một coding agent là mặc định.

## 3. Quyết định sản phẩm phải giữ

### Duration và nội dung

- Hai input là **First Sentence Start** và **Last Sentence Start**; input thứ hai là lúc câu cuối bắt đầu, không phải lúc kết thúc.
- `target_duration = last_sentence_start - first_sentence_start`. Ví dụ `00:00:10` đến `00:06:10` cho target **360 giây**. Backend tính và validate; frontend chỉ preview.
- Đọc đầy đủ transcript, kể cả câu cuối. Không cộng thêm thời gian cho câu cuối, không cắt nội dung để khớp target.
- Khi có real audio processing, điều chỉnh tempo của **toàn bộ audio** để khớp target, không căn từng câu. Ví dụ TTS dài 370 giây cho target 360 giây thì phải fit về 360 giây.
- Mong muốn sản phẩm là output bằng target, không tùy ý dài/ngắn hơn. Sai số kỹ thuật phải được thống nhất và kiểm chứng; mock audio hiện chưa có duration guarantee.
- Timestamps theo API `HH:MM:SS`, giờ ít nhất hai chữ số; last phải lớn hơn first.
- Transcript cleaning phải giữ nội dung mơ hồ như `10:30 is our meeting time.`; quy tắc format chi tiết nằm trong API docs.

### Translation, speech và chi phí

- Dịch phần diễn giải tự nhiên, đúng nghĩa; giữ nguyên thuật ngữ English về technology, chuyên môn và khoa học. Không tự thêm giải thích, tóm tắt hoặc phiên âm.
- Bước đầu dùng Azure Translator F0 và glossary backend, không có glossary UI. Glossary bảo vệ term đã biết; chưa hứa tự nhận diện hoàn hảo mọi term ở mọi lĩnh vực. Provider phải thay được nếu chất lượng không đạt; paid LLM translation chưa thuộc scope.
- Ví dụ mong muốn: “A neural network uses gradient descent to minimize the loss function.” → “Một neural network sử dụng gradient descent để giảm thiểu loss function.” Câu Việt có thể khác, các term được bảo vệ phải giữ nguyên.
- Voice API: `HoaiMy` / `NamMinh`, tương ứng `vi-VN-HoaiMyNeural` / `vi-VN-NamMinhNeural`. Mixed English/Vietnamese pronunciation cần đánh giá ở phần Azure Speech.
- Không quota sản phẩm tùy ý như ba job/ngày hoặc cấm transcript dài để hạn chế testing. Có giới hạn tài nguyên thật, admission control, request-body guard và provider limits; chia request khi cần.
- Ưu tiên free tiers; không tự mua/nâng tier, chuyển paid provider hay fallback âm thầm. Provider quota hết phải báo rõ.
- Transcript xử lý tạm; metadata tối thiểu trong DB; translation/audio trong temporary result store. Không lưu audio binary vào DB.

## 4. Hệ thống đã có ở baseline hoàn tất 2B

| Thành phần | Hiện trạng |
|---|---|
| Frontend | React + TypeScript + Vite; responsive; Vitest; Playwright Chromium desktop/mobile viewport |
| Backend | Python 3.12, FastAPI, uv; modular monolith; HTTP handlers tách business logic |
| Pipeline | TranslationProvider → SpeechProvider → AudioProcessor → ResultStore; protocols nhỏ; wiring trong `services.py` |
| Execution | Một instance, một uvicorn process; bounded worker threads và queue trong RAM; chưa có durable queue |
| Database | PostgreSQL 17, SQLAlchemy/Alembic; Neon Free tại AWS US West 2 (Oregon) |
| Hosting | Docker multi-stage, FastAPI phục vụ React build và API cùng origin; Render Free Oregon |
| Domain | https://mydubb.com; `www` và HTTP redirect về HTTPS; DNS GoDaddy |
| CI/CD | GitHub Actions, Render auto-deploy sau checks pass; chưa dùng Jenkins |
| Production providers tại mốc 2B | Translation mock, speech là MP3 fixture khoảng 3 giây, audio processing pass-through |

Giới hạn đã chấp nhận: Render có cold start; disk ephemeral làm mất results sau restart/deploy; session trong PostgreSQL vẫn tồn tại. Không scale ngang với execution/result storage hiện tại. Khoảng overlap khi deploy được hỗ trợ ở mức job ownership/recovery, không biến local results thành shared storage.

Các invariants vận hành:

- Access Code kiểm tra ở server; session cookie HttpOnly/SameSite=Strict, Secure ở production; DB chỉ lưu hash của session token. Có CSRF, Origin check, brute-force protection theo IP và global, job ownership theo session.
- Production mock cần opt-in rõ ràng `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`; không nới bảo mật. Cấm `MOCK_FAIL_STAGE` ở production; Access Code tối thiểu 16 ký tự; có HSTS và CSP.
- States: `queued → translating → synthesizing → processing → completed/failed`; compare-and-set chống stale worker ghi đè. UI hiển thị stages thật, không có phần trăm giả.
- Mỗi process có instance ID; heartbeat chỉ cho job queued/running còn được quản lý trong RAM. Mặc định heartbeat 15 giây, stale 90 giây; shutdown drain 20 giây. Job mất worker sẽ `failed/interrupted`; không tự chạy lại provider khi kết quả gọi trước chưa rõ.
- Result store publish bằng rename, cleanup bỏ qua active staging. Result mất/hết hạn trả `410 result_expired`. Logout chỉ coi thành công khi server trả `204` hoặc session đã hết hạn `401`.
- Defaults đã chạy: result TTL 1 giờ; session TTL 12 giờ; job metadata chưa tự cleanup. Không nhầm với retention đề xuất ở mục 6.
- Migrations chạy ở container startup và phải backward compatible. Expand-only **không đủ** để bảo đảm rollback: target image phải biết Alembic revision hiện tại. Mốc 2B là `0002`. Chi tiết và rehearsal nằm trong DEPLOYMENT.md.
- Roll forward là mặc định khi rollback target không tương thích. Bỏ migration step để chạy code cũ chỉ là đường khẩn cấp có điều kiện, cần Product Owner duyệt; không downgrade production DB tự động.

## 5. Milestones và bằng chứng bàn giao

| Mốc | Kết quả | Trạng thái |
|---|---|---|
| M1 | FastAPI/React, PostgreSQL sessions/jobs, modular providers, mock end-to-end, Docker, local checks và docs | Hoàn tất |
| M1 review | Sửa staging-cleanup race, transcript cleaning mất `10:30`, logout UI báo thành công sai; regression tests và E2E vào repo | Hoàn tất |
| M2A | Private GitHub repo, CI thực cho push/PR, SHA-pinned actions, least-privilege token, aggregate `CI success`; PR #1 handoff | Hoàn tất |
| M2B | Render + Neon + domain/HTTPS, production mock opt-in, heartbeat/recovery, security hardening, smoke tests; PR #2–#7 | Hoàn tất |
| M2B review | PR #8 sửa heartbeat nuôi job mồ côi, cleanup khi mkdtemp/scheduling lỗi; giới hạn rollback và rehearsal | Đã merge/deploy, kiểm chứng production |

Bằng chứng cuối của 2B (không phải kiểm tra live tự động mỗi khi đọc file):

- Repository private: https://github.com/chutieu312/mydubb.
- [PR #8](https://github.com/chutieu312/mydubb/pull/8), reviewed HEAD `c6582d7dddc169f72b403bc2e7db39c1e9ce9643`; merge SHA `d48bb9bf13510f7a097211800deb98514bd83038`.
- [CI trên merge commit main](https://github.com/chutieu312/mydubb/actions/runs/39825528032) pass. Trước merge, [CI PR](https://github.com/chutieu312/mydubb/actions/runs/39821079570) xác nhận 126 backend tests, gồm sáu liveness regression tests; frontend, Docker và E2E checks pass.
- Claude báo GitHub Deployment `7259659232`, Render deploy `dep-dbd4u6nlk1mc73fti8d0`, đúng merge SHA, success; dashboard chưa được đối chiếu độc lập ở bước bàn giao đó.
- Product Owner xác nhận sau deploy: nhập transcript/timestamps, job Completed, nghe audio và download thành công. **Product Owner đã đồng ý đóng 2B**. Đây là mock beta hoạt động, chưa phải real dubbing hoàn chỉnh.
- iPhone Safari đã mở được login qua HTTPS; authenticated end-to-end trên iPhone/iPad thật chưa được xác nhận đầy đủ.

## 6. Quyết định còn mở

- **Duration tolerance:** ±50 ms trên audio sau decode mới là đề xuất, chưa được chốt riêng hay chứng minh đạt được. Trước FFmpeg cần thống nhất cách đo, xử lý encoder delay/padding và tiêu chí pass/fail.
- **Tempo quá lớn/nhỏ:** cần xác định cách bảo vệ chất lượng, giới hạn kỹ thuật và lỗi hiển thị; không tự thay target hoặc cắt nội dung.
- **Metadata retention:** 7 ngày mới là đề xuất; chưa có quyết định triển khai cleanup. Result/session defaults 1 giờ/12 giờ không có nghĩa metadata cũng đã có TTL.
- **Chi phí:** budget GitHub Actions $0 kèm hard stop chưa được xác nhận. Không coi số phút/free-tier allowance trong tài liệu lịch sử là số dư hiện tại. Resource/credentials Azure và live translation quality chưa được xác nhận tại mốc 2B.
- **Glossary quality:** cần transcript đại diện và đánh giá term chưa biết/đa nghĩa. Không hứa glossary nhỏ sẽ bảo vệ mọi thuật ngữ hoặc đã có automatic domain-wide term detection.

## 7. Tài liệu và workflow cần dùng

| Nhu cầu | Đọc |
|---|---|
| Setup/local commands, checks, cảnh báo test database | [README](../README.md) |
| Module boundaries, lifecycle, concurrency, retention | [ARCHITECTURE.md](ARCHITECTURE.md) |
| API, timestamps, cleaning, errors và ownership | [API.md](API.md) |
| Branch/PR, CI, protections và cost control | [WORKFLOW.md](WORKFLOW.md) |
| Render/Neon, secrets, smoke, deploy, rollback/rehearsal | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Isolated browser tests | [E2E README](../e2e/README.md) |
| Bối cảnh/tầm nhìn ban đầu (historical) | [Original planning handoff](../mydubb-context.md) |

Nhắc lại workflow: branch mới từ main mới nhất cho task mới; không tái sử dụng branch đã merge; không đụng thay đổi chưa commit của session khác. GitHub Free private repo hiện dùng quy tắc bảo vệ main thủ công. Trước merge cần CI đúng PR HEAD; sau merge cần CI đúng merge SHA và deploy đúng SHA. Không dựa vào run cũ. Tests có thể drop/recreate schema: chỉ chạy trên DB test disposable, không production. Production smoke tránh thử Access Code sai để không tiêu hao failed-login allowance.
