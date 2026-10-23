# MyDubb — Context và handoff hiện tại

Cập nhật: **2026-10-22**. Mốc hoàn tất gần nhất: **Milestone 3B** (Azure Translator và Azure Speech thật, audio processing còn pass-through, chưa chỉnh duration), sau 3A và 2B. Đây là điểm bắt đầu cho session mới, tóm tắt quyết định sản phẩm và kết quả đã nghiệm thu. Task đang thực hiện được mô tả trong implementation prompt riêng, không chép vào file này.

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
- Voice API (từ 3B, Product Owner đã nghe audio thật rồi chọn): `AndrewMultilingual` (mặc định, "Andrew Multilingual") → `en-US-AndrewMultilingualNeural` và `EmmaMultilingual` ("Emma Multilingual") → `en-US-EmmaMultilingualNeural`. `HoaiMy` / `NamMinh` (voice Vietnamese Standard) đã bị thay thế hoàn toàn, request mới dùng hai tên cũ bị từ chối; job cũ vẫn đọc được.
- Cách đọc English xen Vietnamese (đã được Product Owner nghe và chấp nhận): một voice, một speaker cho cả audio; SSML dùng `<lang xml:lang="vi-VN">` cho phần Vietnamese và `<lang xml:lang="en-US">` cho term English do glossary chung nhận diện; tốc độ mặc định. Term ngoài glossary không có span English riêng nên có thể đọc sai.
- Không quota sản phẩm tùy ý như ba job/ngày hoặc cấm transcript dài để hạn chế testing. Có giới hạn tài nguyên thật, admission control, request-body guard và provider limits; chia request khi cần.
- Ưu tiên free tiers; không tự mua/nâng tier, chuyển paid provider hay fallback âm thầm. Provider quota hết phải báo rõ.
- Transcript xử lý tạm; metadata tối thiểu trong DB; translation/audio trong temporary result store. Không lưu audio binary vào DB.

## 4. Hệ thống hiện có (baseline 2B + 3A)

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
| Production providers | Translation: **Azure Translator thật** (`TRANSLATION_PROVIDER=azure`, resource Free F0 `mydubb-translator`, Global endpoint, region `westus2`) + glossary backend. Speech: **Azure Speech thật** (`SPEECH_PROVIDER=azure`, resource Free F0, region `westus2`, REST API, key riêng của Speech chỉ nằm trong Render environment, FFmpeg trong image). Audio processing: pass-through mock, chưa chỉnh duration. Ở mốc 2B cả ba đều là mock |

Giới hạn đã chấp nhận: Render có cold start; disk ephemeral làm mất results sau restart/deploy; session trong PostgreSQL vẫn tồn tại. Không scale ngang với execution/result storage hiện tại. Khoảng overlap khi deploy được hỗ trợ ở mức job ownership/recovery, không biến local results thành shared storage.

Các invariants vận hành:

- Access Code kiểm tra ở server; session cookie HttpOnly/SameSite=Strict, Secure ở production; DB chỉ lưu hash của session token. Có CSRF, Origin check, brute-force protection theo IP và global, job ownership theo session.
- Production mock cần opt-in rõ ràng `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`; không nới bảo mật. Cấm `MOCK_FAIL_STAGE` ở production; Access Code tối thiểu 16 ký tự; có HSTS và CSP.
- States: `queued → translating → synthesizing → processing → completed/failed`; compare-and-set chống stale worker ghi đè. UI hiển thị stages thật, không có phần trăm giả.
- Mỗi process có instance ID; heartbeat chỉ cho job queued/running còn được quản lý trong RAM. Mặc định heartbeat 15 giây, stale 90 giây; shutdown drain 20 giây. Job mất worker sẽ `failed/interrupted`; không tự chạy lại provider khi kết quả gọi trước chưa rõ.
- Result store publish bằng rename, cleanup bỏ qua active staging. Result mất/hết hạn trả `410 result_expired`. Logout chỉ coi thành công khi server trả `204` hoặc session đã hết hạn `401`.
- Defaults đã chạy: result TTL 1 giờ; session TTL 12 giờ; job metadata chưa tự cleanup. Không nhầm với retention đề xuất ở mục 6.
- Migrations chạy ở container startup và phải backward compatible. Expand-only **không đủ** để bảo đảm rollback: target image phải biết Alembic revision hiện tại. Mốc 2B là `0002`. Chi tiết và rehearsal nằm trong DEPLOYMENT.md.
- Azure translation (3A): `PROVIDER_MODE=mock` vẫn mô tả speech/audio nên production vẫn cần `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`; `PROVIDER_MODE=azure` (mọi thứ thật) bị từ chối cho tới khi có Speech và FFmpeg. Chọn Azure mà thiếu `AZURE_TRANSLATOR_KEY` thì app không khởi động. Không tự retry, không fallback về mock; một chunk lỗi thì job lỗi, không có bản dịch một phần. Log chỉ có kích thước và mã lỗi, không có transcript, bản dịch hay key.
- Azure Speech (3B): `SPEECH_PROVIDER=mock|azure` (mặc định mock). Chọn Azure thì cần `AZURE_SPEECH_KEY` (key riêng, không dùng key Translator), `AZURE_SPEECH_REGION` và `ffmpeg`/`ffprobe` trong PATH, thiếu thì app không khởi động. `PROVIDER_MODE=mock` vẫn mô tả audio processing nên production vẫn cần `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`; `PROVIDER_MODE=azure` vẫn bị từ chối cho tới 3C. Không retry, không fallback mock, một chunk lỗi thì job lỗi và không có audio một phần. Rate limiter dùng chung cho mọi job trong process (mặc định 20 request/60 giây, giới hạn F0, cộng 1 giây đệm). Log chỉ có status, request id, số lượng và độ dài audio, không có key, SSML hay text.
- Roll forward là mặc định khi rollback target không tương thích. Bỏ migration step để chạy code cũ chỉ là đường khẩn cấp có điều kiện, cần Product Owner duyệt; không downgrade production DB tự động.

## 5. Milestones và bằng chứng bàn giao

| Mốc | Kết quả | Trạng thái |
|---|---|---|
| M1 | FastAPI/React, PostgreSQL sessions/jobs, modular providers, mock end-to-end, Docker, local checks và docs | Hoàn tất |
| M1 review | Sửa staging-cleanup race, transcript cleaning mất `10:30`, logout UI báo thành công sai; regression tests và E2E vào repo | Hoàn tất |
| M2A | Private GitHub repo, CI thực cho push/PR, SHA-pinned actions, least-privilege token, aggregate `CI success`; PR #1 handoff | Hoàn tất |
| M2B | Render + Neon + domain/HTTPS, production mock opt-in, heartbeat/recovery, security hardening, smoke tests; PR #2–#7 | Hoàn tất |
| M2B review | PR #8 sửa heartbeat nuôi job mồ côi, cleanup khi mkdtemp/scheduling lỗi; giới hạn rollback và rehearsal | Đã merge/deploy, kiểm chứng production |
| M3A | Azure Translator thật + glossary backend (PR #9); speech/audio còn mock | Hoàn tất: đã merge, deploy, Product Owner xác nhận trên production (2026-10-22) |
| M3B | Azure Speech thật (REST), voice Andrew/Emma Multilingual, chunking, ghép audio và MP3 bằng FFmpeg; chưa chỉnh duration (PR #11) | Hoàn tất: đã merge, deploy, Product Owner nghe và chấp nhận trên production (2026-10-22) |
| M3C | FFmpeg duration processing (tempo toàn bộ audio về target) | Chưa bắt đầu |

Bằng chứng cuối của 2B (không phải kiểm tra live tự động mỗi khi đọc file):

- Repository private: https://github.com/chutieu312/mydubb.
- [PR #8](https://github.com/chutieu312/mydubb/pull/8), reviewed HEAD `c6582d7dddc169f72b403bc2e7db39c1e9ce9643`; merge SHA `d48bb9bf13510f7a097211800deb98514bd83038`.
- [CI trên merge commit main](https://github.com/chutieu312/mydubb/actions/runs/39825528032) pass. Trước merge, [CI PR](https://github.com/chutieu312/mydubb/actions/runs/39821079570) xác nhận 126 backend tests, gồm sáu liveness regression tests; frontend, Docker và E2E checks pass.
- Claude báo GitHub Deployment `7259659232`, Render deploy `dep-dbd4u6nlk1mc73fti8d0`, đúng merge SHA, success; dashboard chưa được đối chiếu độc lập ở bước bàn giao đó.
- Product Owner xác nhận sau deploy: nhập transcript/timestamps, job Completed, nghe audio và download thành công. **Product Owner đã đồng ý đóng 2B**. Đây là mock beta hoạt động, chưa phải real dubbing hoàn chỉnh.
- iPhone Safari đã mở được login qua HTTPS; authenticated end-to-end trên iPhone/iPad thật chưa được xác nhận đầy đủ.

Kết quả và bằng chứng của 3A:

- Đã có: `AzureTranslationProvider` (Text Translation API v3.0, `from=en&to=vi`, `textType=html`) qua `TranslationProvider`; `TRANSLATION_PROVIDER=mock|azure` (mặc định mock, cấu hình mock cũ vẫn dùng được; credentials chỉ được validate khi chọn Azure). Glossary backend `backend/app/translation/data/glossary.txt` (56 term khởi đầu về software, AI, khoa học): giữ spelling/casing từng occurrence, whole-word, plural `s`, longest match, `=TERM` cho case-sensitive, không đưa từ đa nghĩa thường (class, model, cell, key…). Cơ chế `notranslate`: escape transcript trước, chỉ thêm span của hệ thống, parse kết quả về plain text, kiểm tra term còn nguyên, nếu không thì job lỗi `translation_terms_not_preserved`. Chunking tuần tự theo giới hạn service (mặc định 10.000 ký tự/request gồm markup, service tối đa 50.000), không cắt giữa term. Timeout hữu hạn, giới hạn kích thước response, không theo redirect, 9 mã lỗi `translation_*` an toàn. UI: banner theo từng thành phần, disclosure trước khi submit rằng transcript được gửi tới Azure, badge/notices ở kết quả.
- [PR #9](https://github.com/chutieu312/mydubb/pull/9): reviewed HEAD `44f8f2e59c39cb0553cb4e96aa48dacc68ba7039` ([CI PR](https://github.com/chutieu312/mydubb/actions/runs/39853447652) pass, gồm 288 backend test và 17 frontend test với fake HTTP); merge SHA `5ade22201dd7c9d8b589a3d4d296cb94417be334`.
- [CI trên merge commit main](https://github.com/chutieu312/mydubb/actions/runs/39854321185) pass. GitHub Deployment `7263700601` success đúng merge SHA; dashboard Render chưa được đối chiếu độc lập.
- Live Azure (F0) bằng synthetic transcript, chạy bằng `uv run python -m scripts.azure_translator_smoke` từ `backend/` và thêm vài phép thử: term được giữ nguyên, hoa/thường và plural được giữ, chunking thật 8 request/8 dòng đúng thứ tự; app local chạy end-to-end qua API với Azure.
- Kiểm tra từ bên ngoài sau deploy: `/api/meta` báo `translation=azure, speech=mock, audio=mock`; health/ready 200; HSTS, CSP, X-Frame-Options còn; API docs 404; tạo job khi chưa đăng nhập 401.
- Product Owner gửi job trên https://mydubb.com (transcript giả bốn dòng) và xác nhận qua ảnh chụp: disclosure trước nút submit, các stage hoàn thành, badge "Azure Translator", bản dịch tự nhiên giữ nguyên `machine learning`, `neural network`, `gradient descent`, `loss function`, `Spring Boot`, `Dependency Injection`, `REST API`, `JSON` và `10:30`, audio gắn nhãn "Mock fixture". Product Owner đánh giá chất lượng này là đạt. Claude không tự chạy job trên production vì không có Access Code.
- Giới hạn còn lại: glossary chỉ bảo vệ term đã khai báo; Microsoft tính phí cả markup (mỗi lần một term xuất hiện thêm 31 ký tự vào quota); Azure có thể sửa ký hiệu code (quan sát `a && b` thành `a & b`); nếu Azure bỏ/sửa span thì job lỗi thay vì trả bản dịch sai (chưa gặp ở live test); dùng API v3.0, bản GA `2026-06-06` khác request/response và là migration riêng; speech vẫn là fixture, audio processing vẫn pass-through, chưa có duration guarantee.

Kết quả và bằng chứng của 3B:

- Đã có: `AzureSpeechProvider` (`backend/app/speech/azure.py`) qua `SpeechProvider`, dùng **REST API** (`POST {region}.tts.speech.microsoft.com/cognitiveservices/v1`) thay vì Speech SDK: SDK là thư viện native nặng, không cần tính năng streaming, REST dùng lại `httpx`. Giới hạn đã xác minh cho đường REST: F0 20 request/60 giây cho cả resource; tối đa 10 phút audio mỗi request và audio dài hơn bị **cắt âm thầm** với HTTP 200 (giới hạn 64 KB SSML là của WebSocket, không áp dụng). Chunk tối đa 2.000 ký tự (mặc định), gom theo dòng/câu, câu dài chỉ cắt ở khoảng trắng và không cắt giữa glossary term; test xác nhận không mất, lặp, đảo nội dung. Mỗi chunk yêu cầu WAV 24 kHz mono, kiểm tra header nghiêm ngặt, từ chối audio gần 10 phút hoặc ngắn bất thường; ghép ở mức sample (không nối byte file đã encode), FFmpeg encode một lần ra MP3 mono 96 kbit/s có header seek, `ffprobe` xác nhận. WAV đã ghép được giữ trong work dir (`SpeechAudio.lossless_path`) để 3C chỉnh tempo trước khi encode. 11 mã lỗi `speech_*` an toàn. Glossary chung thêm `REST API` (phân biệt hoa/thường) và `pipeline`. UI: banner theo thành phần "real translation and speech, duration not adjusted", disclosure nêu Azure Translator và Azure Speech, badge "Azure Speech" và "Duration not adjusted", `is_fixture=false`, voice selector hiển thị tên "Andrew Multilingual"/"Emma Multilingual", không có phần trăm giả.
- Voice: ban đầu implement HoaiMy/NamMinh; sau khi Product Owner nghe mẫu thật chọn Andrew/Emma Multilingual với `<lang>` spans (cập nhật trong cùng PR #11). Job cũ lưu tên voice cũ vẫn đọc/hiển thị được (cột `jobs.voice` là text, không migration).
- Runtime image: thêm Debian `ffmpeg` (kèm `ffprobe`), image tăng từ khoảng 405 MB lên khoảng 1,04 GB; bản FFmpeg static nhỏ hơn nhưng là binary bên thứ ba không ký nên không chọn.
- [PR #11](https://github.com/chutieu312/mydubb/pull/11): reviewed HEAD `f5cb638e2c5e66964d38b1e411c3ec4a6c162806` ([CI PR](https://github.com/chutieu312/mydubb/actions/runs/39886354304) pass, gồm 428 backend test với Azure giả và FFmpeg thật, 29 frontend test, 12 E2E, Docker runtime check); merge SHA `11382325077174fe0e7017a320d570555d531f6a`.
- [CI trên merge commit main](https://github.com/chutieu312/mydubb/actions/runs/39887481083) pass. GitHub Deployments `7268385824`, `7268402419`, `7268494724` đều success đúng merge SHA (các lần sau là redeploy khi đổi biến môi trường trên Render); dashboard Render chưa được đối chiếu độc lập.
- Live Azure Speech (F0) bằng `uv run python -m scripts.azure_speech_smoke --multi-chunk` từ `backend/` với transcript tổng hợp bốn dòng đã nghe thử: 10 request, mọi request HTTP 200, WAV qua kiểm tra, MP3 sau khi ghép qua `ffprobe` cho cả hai voice. Script không tự kết luận chất lượng phát âm.
- Kiểm tra từ bên ngoài sau deploy: `/api/meta` báo `translation=azure, speech=azure, audio=mock` và hai voice Andrew/Emma; `/api/ready` 200.
- Sự cố khi bật: lần thử đầu trên production Azure Speech trả 401 (`speech_auth_failed`) vì `AZURE_SPEECH_KEY` trong Render không đúng (key khác với key local đã chạy live test); app xử lý đúng thiết kế (lỗi rõ, không retry, không fallback). Product Owner nhập lại key đúng rồi job chạy được. Bài học: key Speech là key của resource Speech, khác key Translator; dán không kèm dấu nháy.
- Product Owner chạy job trên https://mydubb.com, nghe file kết quả và đánh giá chất lượng rất tốt; **Product Owner đã đồng ý đóng 3B**.
- Giới hạn còn lại: audio chưa được chỉnh về target duration (3C), result nói rõ điều này; term English ngoài glossary không có span `en-US` riêng nên có thể đọc sai; F0 chỉ 20 request/phút cho cả resource nên transcript dài ở bước `synthesizing` nhiều phút, quota/rate limit làm job lỗi rõ ràng; xuống dòng trong chunk được giữ như mẫu đã nghe nhưng khoảng ngắt giữa các chunk chưa được đo riêng; mới đánh giá bằng transcript ngắn, chưa với transcript dài thật nhiều chunk.

## 6. Quyết định còn mở

- **Duration tolerance:** ±50 ms trên audio sau decode mới là đề xuất, chưa được chốt riêng hay chứng minh đạt được. Trước FFmpeg cần thống nhất cách đo, xử lý encoder delay/padding và tiêu chí pass/fail.
- **Tempo quá lớn/nhỏ:** cần xác định cách bảo vệ chất lượng, giới hạn kỹ thuật và lỗi hiển thị; không tự thay target hoặc cắt nội dung.
- **Metadata retention:** 7 ngày mới là đề xuất; chưa có quyết định triển khai cleanup. Result/session defaults 1 giờ/12 giờ không có nghĩa metadata cũng đã có TTL.
- **Chi phí Azure Speech:** resource Free F0; Product Owner cần tự xác nhận pricing tier và theo dõi mức dùng so với allowance hằng tháng trên trang giá. Không nâng tier khi chưa được duyệt.
- **Chi phí:** budget GitHub Actions $0 kèm hard stop chưa được xác nhận. Không coi số phút/free-tier allowance trong tài liệu lịch sử là số dư hiện tại. Azure Translator dùng resource Free F0; Product Owner cần tự xác nhận pricing tier là Free F0 trong portal (Claude không xem được) và theo dõi mức dùng so với 2 triệu ký tự/tháng, nhớ rằng markup của glossary được tính phí. Không nâng tier hay thêm provider trả phí khi chưa được duyệt.
- **Glossary quality:** mới được thử bằng transcript giả ngắn. Cần transcript đại diện từ khóa học thật để đánh giá term chưa biết/đa nghĩa, chất lượng dịch dài và mức hao quota; glossary UI và automatic domain-wide term detection chưa thuộc scope. Không hứa glossary nhỏ sẽ bảo vệ mọi thuật ngữ.
- **Translation provider/API:** v3.0 đang dùng; chuyển sang API `2026-06-06` hoặc provider khác chỉ khi có lý do (chất lượng, ngừng hỗ trợ) và cần quyết định riêng cùng live test. Paid LLM translation chưa được duyệt.
- **Mixed pronunciation:** đã đạt với voice Andrew/Emma Multilingual và `<lang>` spans trên transcript ngắn. Còn mở: chất lượng với term ngoài glossary và với transcript thật dài; mở rộng glossary là việc riêng, chưa có glossary UI hay tự nhận diện term.
- **Kích thước image:** khoảng 1,04 GB với Debian `ffmpeg`; chỉ xem lại nếu deploy/disk thành vấn đề, cần quyết định riêng về FFmpeg static.

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
