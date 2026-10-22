# MyDubb — Complete Project Context & Planning Handoff

**Project Name:** MyDubb  
**Domain:** https://mydubb.com  
**Domain Registrar:** GoDaddy  
**Current Version:** MVP v0.1 — Planning Phase  
**Document Version:** 1.0  
**Date:** October 21, 2026  
**Project Type:** AI-Powered Transcript Translation & Voice Dubbing Web Application  
**Initial Target Users:** Project owner and invited private beta users  
**Current Priority:** Build and deploy a working MVP with the lowest possible operating cost.

---

# PART 1 — PROJECT BACKGROUND & ORIGINAL VISION

## 1.1. Why MyDubb Exists

MyDubb originated from a real learning problem experienced by its founder, a Vietnamese software engineer who frequently studies technical courses in English.

Even though the founder understands English, listening to English technical lectures requires additional mental processing.

Listening to the same material in Vietnamese would make learning faster, more natural, and more efficient.

The founder wants to:

- Listen to educational content in Vietnamese.
- Understand lessons without constantly reading translated subtitles.
- Preserve original English technical terminology.
- Eventually support playback speeds such as 1.5x, 1.75x, and 2x.
- Learn technical subjects such as Java, Spring Boot, Python, AWS, System Design, and AI more efficiently.
- Eventually support iPhone, iPad, Windows, macOS, and potentially Android.

The original concept was an AI video dubbing application capable of replacing English narration with Vietnamese narration while the original video continues playing.

The founder researched existing Udemy video translation applications and browser extensions, but found concerns about compatibility, reliability, privacy, security, and translation quality.

This inspired the decision to develop MyDubb.

## 1.2. Long-Term Product Vision

The long-term vision is to create an AI-powered learning dubbing platform.

Potential future capabilities include:

1. Translating educational video transcripts into different languages.
2. Generating natural speech using Text-to-Speech.
3. Preserving English technical terminology.
4. Synchronizing translated speech with video playback.
5. Supporting multiple playback speeds.
6. Providing browser extensions where integration is technically and legally permitted.
7. Supporting iPhone, iPad, Windows, macOS, and Android.
8. Supporting multiple voice options and languages.
9. Supporting authorized content from different video sources.

**Important:** These are long-term ideas, not MVP requirements.

The founder explicitly decided to reduce the initial project scope substantially.

---

# PART 2 — FINAL MVP V0.1 PRODUCT DEFINITION

## 2.1. Core Product

MyDubb MVP v0.1 is a web application that converts an English transcript into Vietnamese spoken audio.

The user manually provides the transcript.

The system translates it into Vietnamese, preserves English technical terms, generates Vietnamese speech, and makes that speech available for listening or MP3 download.

No video upload, video playback, or video synchronization is required.

## 2.2. Primary User Flow

1. User visits https://mydubb.com.
2. User enters a Private Beta Access Code.
3. User accesses the main application.
4. User pastes an English transcript into a text input.
5. User enters the starting timestamp of the first sentence.
6. User enters the starting timestamp of the last sentence.
7. User selects the Vietnamese voice.
8. User clicks "Generate Dubbing".
9. Backend validates and cleans the transcript.
10. Backend translates the transcript from English to Vietnamese.
11. English technical terms are preserved.
12. Backend generates Vietnamese speech using TTS.
13. Audio processing adjusts the final output to the required duration.
14. User listens to the audio directly on the website.
15. User can optionally download the generated MP3.

This is the complete end-to-end MVP workflow.

## 2.3. Transcript Input

Users manually paste transcript text.

Accepted input:

- Plain English text.
- Text containing timestamps.
- Text without timestamps.
- Transcript copied from a source the user is authorized to use.

The system should tolerate common transcript formatting differences.

The MVP does not need to automatically retrieve transcripts from Udemy, YouTube, or any other platform.

Speech-to-Text is also unnecessary because users provide the transcript themselves.

## 2.4. Timestamp Input — Critical Requirement

This requirement was discussed and clarified multiple times.

There are exactly two required timestamp inputs.

**First Sentence Start Time**

The timestamp when the first sentence begins.

**Last Sentence Start Time**

The timestamp when the final sentence begins.

The second timestamp is NOT the moment the last sentence finishes.

Example:

- First Sentence Start: 00:00:10
- Last Sentence Start: 00:05:10

Target Duration:

00:05:10 − 00:00:10 = 00:05:00

**Target TTS Duration = 300 seconds.**

The user wants the generated Vietnamese audio to have this exact target duration.

This is a deliberate MVP product requirement.

Do not reinterpret the last timestamp as the end of the final sentence.

Do not replace the target duration with a rough estimate.

Do not silently append arbitrary additional seconds to the final output.

The product does not require synchronization of each internal sentence.

It only requires controlling the complete audio output duration.

The normal-speed target corresponds to 1.0x playback.

Future versions may introduce 1.5x, 1.75x, and 2.0x playback controls.

The planning team should investigate how to enforce the requested duration through TTS capabilities and audio processing such as FFmpeg, including appropriate engineering validation.

Any technical limitations should be documented clearly without unilaterally changing the accepted product requirement.

## 2.5. Translation Requirements

Input Language: English.

Target Language: Vietnamese.

Initial translation provider: **Azure AI Translator Free Tier (F0)**.

The system should:

- Translate naturally into Vietnamese.
- Preserve technical meaning.
- Avoid unnecessary explanations.
- Avoid adding unrelated information.
- Preserve technical terms when appropriate.
- Maintain the sequence and meaning of the source transcript.

Examples of technical terms:

- Java
- Spring Boot
- Dependency Injection
- REST API
- Kafka
- Docker
- Kubernetes
- Python
- FastAPI
- Microservices
- AWS
- Database
- Authentication
- Authorization
- OAuth 2.0
- JWT
- React
- TypeScript

Example original English:

"Spring Boot uses Dependency Injection to automatically manage objects."

Expected Vietnamese style:

"Spring Boot sử dụng Dependency Injection để tự động quản lý các object."

The goal is not to translate every English technical word into Vietnamese.

The goal is to create natural Vietnamese explanations while retaining recognizable technical vocabulary.

### Translation Provider Strategy

Start with Azure Translator Free.

If Azure Translator produces unnatural Vietnamese or fails to preserve technical terms adequately, evaluate an alternative LLM translation provider such as Claude API.

A paid LLM API is a fallback option, not part of the initial required architecture.

The application should have a modular translation provider abstraction so that changing providers later does not require rewriting the application.

## 2.6. Text-to-Speech Requirements

Initial provider: Azure AI Speech TTS Free Tier (F0).

Target spoken language: Vietnamese.

Support both available voices:

**Female Voice**

- Display Name: HoaiMy
- Azure Voice: vi-VN-HoaiMyNeural

**Male Voice**

- Display Name: NamMinh
- Azure Voice: vi-VN-NamMinhNeural

Users must be able to select either voice.

The application should generate understandable, natural Vietnamese speech while preserving the technical meaning.

English technical terms should remain in the translated text and be pronounced as appropriately as the selected TTS system permits.

The MVP does not require voice cloning.

The generated audio duration must follow the timestamp-derived target duration.

## 2.7. Audio Output Requirements

The generated audio should be playable directly from the MyDubb website.

MVP features:

- Play
- Pause
- Resume
- Seek through generated audio
- Audio progress display
- MP3 download

Users should be able to hear the generated audio without installing an additional application.

The initial playback speed is 1.0x.

Multiple playback speeds are future enhancements, not required for MVP v0.1.

## 2.8. MP3 Storage

The founder agreed that generated MP3 files do not need to be stored permanently.

Expected behavior:

1. Generate audio.
2. Return the result to the browser.
3. Allow playback.
4. Allow MP3 download.
5. Clean up temporary server files after they are no longer needed.

The database should store necessary metadata rather than large audio binary objects.

Long-term audio archives and cloud object storage are not required for MVP.

---

# PART 3 — MVP SCOPE AND EXCLUSIONS

## 3.1. Required Features

- Private Beta Access Code.
- Responsive web interface.
- Transcript text input.
- First sentence starting timestamp.
- Last sentence starting timestamp.
- Duration calculation.
- Vietnamese translation.
- English technical-term preservation.
- Two selectable Vietnamese TTS voices.
- Complete audio generation to target duration.
- Browser-based audio playback.
- Download MP3.
- Backend API.
- Database.
- Deployment to an Internet-accessible server.
- Custom domain mydubb.com.
- HTTPS.
- Basic operational security.

## 3.2. Explicitly Excluded from MVP

The following features were discussed but intentionally deferred:

- Direct YouTube integration.
- Direct Udemy integration.
- Udemy account access.
- YouTube account access.
- Automatic transcript extraction from third-party websites.
- Speech-to-Text.
- Video upload.
- Video player.
- Synchronization between audio and video.
- Sentence-by-sentence dubbing synchronization.
- Browser extensions.
- Native iOS or iPadOS applications.
- Native Windows or macOS applications.
- Android application.
- User registration and login.
- Paid subscriptions.
- Billing integration.
- Complex user accounts and roles.
- Voice cloning.
- Multi-agent AI runtime.
- Kafka.
- Kubernetes.
- Complex microservices infrastructure.
- Long-term MP3 storage.
- Unlimited commercial-scale infrastructure.

These exclusions are important.

Codex must not add them to the initial implementation plan unless specifically approved.

---

# PART 4 — PRIVATE BETA ACCESS

The founder selected **Private Beta**.

The application does not need Login/Register in the MVP.

Instead:

1. The user opens mydubb.com.
2. The user enters an Access Code.
3. The backend validates the code.
4. The user can use the application after successful validation.

The access code should not be hardcoded into public frontend source code.

The backend must enforce authorization on processing endpoints, not merely hide the interface.

## 4.1. Usage Policy — Important Decision

The founder explicitly rejected arbitrary application-level limits.

Do not impose:

- Three audio generations per day.
- Fixed daily generation counts.
- Arbitrary transcript-length caps intended only to restrict testing.

The founder plans to perform extensive testing, potentially with many transcripts and long content.

There is no predetermined number of audio generations.

There is no predetermined transcript duration.

Technical API request-size limitations should be handled through appropriate input processing and chunking when necessary.

However, the application must respect actual provider constraints, service quotas, and available resources.

The system must not automatically upgrade to paid services or incur uncontrolled expenses.

If a free provider quota is exhausted, the system should report the issue rather than automatically switching to a paid provider.

Cost tracking and visibility are encouraged, but not arbitrary restrictions on normal testing.

---

# PART 5 — TECHNOLOGY STACK

The following technologies were selected or proposed and accepted for MVP planning.

| Component | Technology |
|---|---|
| Frontend | React + TypeScript |
| Backend | Python + FastAPI |
| Database | PostgreSQL |
| Database Hosting | Neon Free |
| Translation | Azure AI Translator F0 |
| TTS | Azure AI Speech F0 |
| Audio Processing | FFmpeg |
| Backend Hosting | Render Free |
| Source Control | GitHub |
| Domain Registrar | GoDaddy |
| Public Domain | mydubb.com |
| Architecture | Modular Monolith |

## 5.1. Frontend

Use React with TypeScript.

The application should be responsive.

Users should be able to access it from:

- Windows 11 browsers.
- macOS browsers.
- iPad Safari.
- iPhone Safari.
- Other modern browsers where supported.

The MVP is a website, not a native mobile app.

Do not build separate frontend applications for each operating system.

## 5.2. Backend

Use Python FastAPI.

Responsibilities:

- Validate Access Code.
- Validate user input.
- Parse timestamp fields.
- Clean transcript text.
- Call translation provider.
- Handle long transcripts through chunking when necessary.
- Call TTS provider.
- Process audio duration.
- Produce MP3 response.
- Manage temporary files.
- Store relevant job metadata.
- Handle errors and logging.

Use a Modular Monolith architecture.

Avoid introducing microservices or distributed orchestration.

## 5.3. Database

Use Neon PostgreSQL Free.

Potential metadata:

- Job ID
- Creation timestamp
- Processing status
- Requested source language
- Target language
- Selected voice
- First sentence starting timestamp
- Last sentence starting timestamp
- Target audio duration
- Actual generated audio duration
- Translation provider
- TTS provider
- Processing errors
- Approximate usage metrics

Do not store full transcript content or translated content permanently without a clear product need.

Use minimal retention to protect privacy and reduce storage costs.

Do not store generated MP3 files in PostgreSQL.

Database schema should remain easy to extend later.

## 5.4. Audio Processing

FFmpeg is the proposed tool for audio processing.

Potential responsibilities:

- Combine audio chunks.
- Adjust generated audio duration.
- Produce MP3 output.
- Validate output duration.
- Handle temporary audio files.

The final technical design must verify which Azure TTS duration controls and FFmpeg techniques are appropriate.

The key acceptance requirement is producing the requested total duration.

---

# PART 6 — REFERENCE BACKEND WORKFLOW

Proposed processing sequence:

1. Request reaches FastAPI.
2. Validate Private Beta Access Code.
3. Validate transcript text and timestamp inputs.
4. Calculate target duration.
5. Remove unnecessary transcript timestamp markers and formatting while retaining spoken content.
6. Split into logical processing chunks if necessary.
7. Translate English text into Vietnamese using Azure Translator.
8. Preserve protected technical terms.
9. Assemble translated content in the original order.
10. Generate Vietnamese audio using the selected Azure voice.
11. Process generated audio to match target duration.
12. Verify output duration.
13. Save minimal processing metadata.
14. Return the audio response or a temporary retrieval mechanism.
15. Allow the user to play or download the MP3.
16. Clean up temporary server resources.

Example calculation:

First Sentence Start = 10 seconds.

Last Sentence Start = 310 seconds.

Target Duration = 310 − 10 = 300 seconds.

The final audio should have a target duration of exactly 300 seconds at normal speed.

Do not attempt to synchronize the internal sentences with their original timestamps in this MVP.

---

# PART 7 — COST OPTIMIZATION STRATEGY

## 7.1. Primary Goal

Minimize the recurring cost of developing and testing MyDubb.

Target:

**$0 in incremental monthly operating charges whenever usage remains within applicable free tiers.**

The domain has already been purchased.

Domain renewal fees are an existing expense.

Free-tier plans may impose quotas, inactivity behavior, resource limits, and account requirements.

All current pricing and quotas should be revalidated before implementation.

## 7.2. Initial Cost Strategy

| Service | Strategy |
|---|---|
| Azure Translator | Free F0 tier |
| Azure Speech | Free F0 tier |
| Render | Free web service |
| Neon PostgreSQL | Free tier |
| GitHub | Free private repository |
| FFmpeg | Open-source |
| React / TypeScript | Open-source |
| FastAPI | Open-source |
| DNS | Existing GoDaddy domain |
| SSL / HTTPS | Hosting platform-managed certificate where available |

## 7.3. Decisions Already Made

- Start with Azure Translator instead of a paid Claude API.
- Use Azure Speech free tier.
- Use Render Free for the backend.
- Use Neon Free for PostgreSQL.
- Accept Render cold-start delays during testing.
- Avoid unnecessary long-term MP3 storage.
- Avoid unnecessary paid infrastructure.
- Avoid complex cloud architecture.

## 7.4. Important Cost Constraints

Do not automatically activate paid resources when free quotas are exhausted.

Do not assume that a free tier means unlimited use.

Identify resource quotas, hard provider limits, and any billing risks before account configuration.

Separate infrastructure operating costs from the cost of using Claude Code as the development assistant.

Use appropriate development safeguards against accidental excessive usage without adding arbitrary product limits that the founder rejected.

---

# PART 8 — DOMAIN, HOSTING & DEPLOYMENT

## 8.1. Domain

Canonical domain:

https://mydubb.com

Purchased through GoDaddy.

The founder owns the domain registration.

Do not purchase additional domains for iPhone, iPad, Windows, or macOS applications.

Possible future subdomains include:

- app.mydubb.com
- api.mydubb.com

However, subdomains are optional.

For the smallest MVP, hosting the web application and API with a minimal deployment structure is preferred.

## 8.2. Hosting

Initial selected provider: Render Free.

Advantages:

- Supports Python FastAPI applications.
- GitHub-based deployment.
- Custom domains.
- HTTPS support.
- Free-tier option for testing.

Disadvantage accepted by founder:

- Free services may sleep when inactive, resulting in cold-start delays.

## 8.3. Database Hosting

Selected provider: Neon PostgreSQL Free.

The database stores minimal metadata.

Use environment variables to manage database connection credentials.

## 8.4. Deployment Requirements

The founder wants a real website accessible from personal devices, not just a localhost demo.

Minimum deployment requirements:

- Public HTTPS URL.
- Working access-code protection.
- Responsive frontend.
- Reachable backend.
- Functional Azure integrations.
- Working database connection.
- Functional audio generation.
- Functional MP3 download.
- Basic error handling.
- No API secrets exposed to browsers.
- GitHub source control.

The goal is to deploy as quickly as practical, ideally within the same development day after configuration and testing.

This is a personal-testing Private Beta, not a claim of commercial production readiness.

---

# PART 9 — SECURITY & PRIVACY

Security is a significant concern for the founder.

The original motivation included reluctance to grant third-party extensions access to personal Udemy credentials.

The MyDubb MVP should therefore:

- Never ask for Udemy login credentials.
- Never ask for YouTube login credentials.
- Never store external platform passwords.
- Only process transcripts supplied by authorized users.
- Protect Azure credentials on the backend.
- Keep secrets outside source control.
- Validate Access Codes server-side.
- Use HTTPS.
- Validate external inputs.
- Sanitize output where appropriate.
- Protect against unnecessarily exposed public API endpoints.
- Avoid permanent storage of users' transcript contents unless needed and approved.
- Avoid storing generated audio longer than necessary.

The application should use a privacy-conscious architecture from the beginning.

Because external Azure services process submitted text, that data flow should be disclosed accurately to users.

---

# PART 10 — INITIAL FRONTEND DESIGN

The founder prefers a simple application with minimal UI complexity.

The MVP should have one main user workflow.

Proposed interface:

**Header**

MyDubb — Transcript to Vietnamese Voice

**Private Beta Access**

Access Code input.

**Main Form**

- English Transcript textarea.
- First Sentence Start Time input.
- Last Sentence Start Time input.
- Target Language: Vietnamese.
- Voice selector: HoaiMy / NamMinh.
- Technical-term preservation enabled.
- Generate Dubbing button.

**Processing State**

Display progress or clear processing status:

- Validating transcript.
- Translating.
- Generating voice.
- Processing audio.
- Completed or failed.

**Result**

- Vietnamese translated text.
- Audio player.
- Duration display.
- Download MP3 button.

The interface must work comfortably on both desktop and mobile browsers.

Avoid unnecessary dashboards and advanced settings during MVP development.

---

# PART 11 — FEATURE DECISIONS STILL OPEN

Some ideas were proposed but not yet formally approved.

Codex should treat them as open decisions, not finalized requirements.

## 11.1. Technical Glossary Management

The founder strongly requires English technical terminology to be preserved.

Two approaches were discussed:

**Option A:** Automatically preserve technical terms.

**Option B:** Automatically preserve terms and allow users to add a custom list of protected technical terms.

The assistant recommended Option B, but the founder has not explicitly selected it.

Codex should recommend an MVP approach without assuming the additional custom-glossary UI is approved.

## 11.2. Translation Quality

Azure Translator was selected for cost optimization.

Real quality with technical educational content remains to be tested.

Possible future provider: Claude API.

The fallback provider should not be automatically enabled or charged without approval.

## 11.3. Technical Term Pronunciation

Keeping English terminology in the translated text does not automatically guarantee perfect English pronunciation within Vietnamese TTS.

The application should test mixed-language sentences.

Advanced pronunciation controls and custom phonetic dictionaries may be evaluated later.

## 11.4. Exact Audio Duration Engineering

The requirement is finalized.

The implementation strategy is not.

Codex must investigate:

- Azure Speech duration-control capabilities.
- TTS audio chunking.
- Merging generated speech chunks.
- FFmpeg time adjustments.
- Duration validation.
- Mixed-language pronunciation.
- Audio quality after duration adjustment.
- Appropriate codec-level precision and verification.

Codex should identify technical risks and propose the simplest feasible implementation.

It should not silently weaken the exact-duration requirement.

## 11.5. Data Retention

No long-term MP3 storage is required.

Exact metadata retention and privacy policy details have not been finalized.

The initial approach should minimize stored data.

## 11.6. Scope of Future Expansion

Potential future enhancements include:

- Video/audio synchronization.
- Native applications.
- Browser extensions.
- Multiple target languages.
- Multiple playback speeds.
- More voice selections.
- User accounts.
- Paid subscriptions.
- Analytics.
- Authorized platform integrations.

None are needed in the first MVP.

---

# PART 12 — DEVELOPMENT APPROACH

## 12.1. AI Development Workflow

The founder intends to use multiple AI tools with separate responsibilities.

### Founder — Product Owner

Responsible for:

- Product vision.
- Business requirements.
- Final architectural approvals.
- Feature prioritization.
- Testing and acceptance.
- Decisions about paid services.

### ChatGPT — Brainstorming Partner

Responsible for:

- Discussing product ideas.
- Clarifying requirements.
- Comparing alternatives.
- Challenging assumptions.
- Helping the founder make decisions.

### Codex / Astra — Planning & Technical Architecture Assistant

Responsible for:

- Reviewing project context.
- Creating a complete PRD.
- Designing system architecture.
- Identifying risks.
- Recommending implementation choices.
- Defining API contracts.
- Designing the database schema.
- Preparing an incremental development plan.
- Preparing clear implementation instructions for Claude Code.

### Claude Code — Main Implementation Agent

Responsible for:

- Creating the project codebase.
- Implementing frontend and backend.
- Integrating APIs.
- Writing tests.
- Debugging issues.
- Preparing deployment configuration.
- Supporting production smoke tests after deployment.

The founder explicitly prefers Claude Code for implementation.

## 12.2. Multi-Agent Development

A complex multi-agent development workflow is NOT required initially.

Use one main coding agent with clear tasks.

Additional specialized agents can be introduced later if necessary.

The application itself also does not require an Agentic AI runtime.

Its translation pipeline is a predefined sequence of processing steps.

## 12.3. Development Principles

- Keep the MVP small.
- Avoid overengineering.
- Use familiar technologies.
- Prefer maintainability.
- Keep services modular.
- Add tests for critical behavior.
- Avoid unnecessary cloud expenses.
- Deploy working increments.
- Validate quality on actual devices.
- Do not start coding until the founder approves the plan.

---

# PART 13 — RECOMMENDED PROJECT PHASES

## Phase 1 — Final Requirements & Architecture

Deliverables:

- Approved PRD.
- System Architecture.
- Data Flow.
- Technology Stack.
- API Contracts.
- Database Design.
- Provider integration strategy.
- Exact-duration processing proposal.
- Security and cost plan.
- MVP acceptance criteria.

## Phase 2 — Project Foundation

Deliverables:

- GitHub repository.
- Frontend project.
- FastAPI backend.
- Environment configuration.
- Database connection.
- Local development setup.
- Automated test foundation.

## Phase 3 — Transcript Processing

Deliverables:

- Transcript input and validation.
- Timestamp parsing.
- Transcript cleaning.
- Duration calculation.
- Long-transcript processing strategy.

## Phase 4 — Translation Integration

Deliverables:

- Azure Translator integration.
- English-to-Vietnamese translation.
- Technical-term preservation.
- Translation tests.
- Error handling.

## Phase 5 — TTS & Duration Processing

Deliverables:

- Azure Speech integration.
- HoaiMy and NamMinh voices.
- Vietnamese audio generation.
- FFmpeg processing.
- Exact target-duration verification.
- MP3 output.

## Phase 6 — Frontend Integration

Deliverables:

- Working form.
- Private Beta Access Code.
- Processing feedback.
- Translated text.
- Audio playback.
- MP3 download.
- Mobile responsiveness.

## Phase 7 — Cloud Deployment

Deliverables:

- Render service.
- Neon database.
- Environment secrets.
- GitHub deployment.
- GoDaddy DNS configuration.
- HTTPS.
- Online smoke testing.
- Testing on Windows, iPhone, and iPad.

## Phase 8 — MVP Evaluation

Evaluate:

- Translation accuracy.
- Technical-term preservation.
- Vietnamese speech naturalness.
- Male and female voice quality.
- Exact audio duration.
- MP3 playback/download.
- Performance on long transcripts.
- Reliability.
- Free-tier consumption.
- Actual operating cost.

Only then should the founder decide what features belong in MVP v0.2.

---

# PART 14 — INITIAL ACCEPTANCE CRITERIA

The MVP is considered functionally successful when:

1. The founder can open mydubb.com from a browser.
2. Private Beta Access Code validation works.
3. The founder can paste an English transcript with or without timestamps.
4. The founder can enter the starting time of the first sentence and the starting time of the final sentence.
5. The application calculates the correct duration difference.
6. Azure Translator returns an understandable Vietnamese translation.
7. The translated content preserves English technical terminology appropriately.
8. The founder can choose either HoaiMy or NamMinh.
9. Azure Speech produces Vietnamese spoken audio.
10. Audio processing delivers the exact requested output duration, subject only to an explicitly defined and tested technical precision tolerance.
11. The founder can listen through the browser.
12. The founder can download an MP3.
13. Processing errors are communicated clearly.
14. Backend API credentials are not exposed.
15. The database and hosted application function correctly.
16. The application remains within the intended free-tier infrastructure configuration unless the founder expressly authorizes a change.
17. The application works on desktop and mobile browsers.

No video player or external-platform integration is needed to satisfy these criteria.

---

# PART 15 — PREVIOUS IDEAS THAT WERE REVISED

This section prevents Codex from accidentally bringing outdated requirements back into the project.

### Original Idea

Translate and dub video from Udemy and YouTube directly.

**Current Decision:** Not part of MVP.

### Original Idea

Synchronize Vietnamese speech with every sentence of a playing video.

**Current Decision:** Not part of MVP.

### Original Idea

Use Speech-to-Text to extract English speech from videos.

**Current Decision:** Not necessary because users supply transcripts.

### Original Idea

Use transcript timestamps to synchronize every spoken sentence.

**Current Decision:** Only two manually entered timestamp values are used to determine total target duration.

### Original Idea

Treat the final timestamp as the end of the final sentence.

**Current Decision:** Incorrect. It is the START of the final sentence.

### Original Idea

Use duration only as an approximate reference.

**Current Decision:** Incorrect. The founder requires the generated audio to match the calculated target duration.

### Original Idea

Use paid Claude API for all translations.

**Current Decision:** Start with Azure Translator Free.

### Original Idea

Limit private-beta usage to three generations daily.

**Current Decision:** Explicitly rejected.

### Original Idea

Limit transcript length to reduce AI costs.

**Current Decision:** Arbitrary application-level limits were explicitly rejected.

### Original Idea

Save generated audio permanently.

**Current Decision:** Not necessary. Return audio to users and clean up temporary files.

### Original Idea

Require Login/Register.

**Current Decision:** Use a Private Beta Access Code.

### Original Idea

Build native iOS, iPadOS, macOS and Windows apps immediately.

**Current Decision:** Start with one responsive website.

### Original Idea

Use a complex multi-agent workflow to develop the application.

**Current Decision:** Use Codex for planning and Claude Code for implementation; no complex orchestration required.

### Previous Experimental Starter Project

An earlier assistant generated a starter ZIP during brainstorming without an explicit request to start implementation.

It was not reviewed or approved by the founder.

Codex must not treat that archive as the authoritative project specification or assume its code is the approved implementation.

The decisions in this document are the source of truth.

---

# PART 16 — INSTRUCTIONS TO CODEX

You are now acting as the **Principal Software Architect, Technical Planning Assistant, and Product Engineering Advisor** for MyDubb.

The founder has completed extensive brainstorming with ChatGPT.

This document contains the accumulated decisions and current project direction.

Your responsibility is to turn these decisions into a realistic implementation plan.

## Your Immediate Tasks

**Task 1 — Review Requirements**

Read the entire document carefully.

Identify finalized requirements, optional recommendations, and open decisions.

Do not modify approved requirements without discussing the change with the founder.

**Task 2 — Produce a Formal PRD**

Prepare a Product Requirements Document containing:

- Product overview.
- User problem.
- Product goals.
- MVP scope.
- Functional requirements.
- Nonfunctional requirements.
- User journey.
- Acceptance criteria.
- Explicit exclusions.

**Task 3 — Design the System Architecture**

Use the agreed technology stack.

Prefer a simple Modular Monolith.

Explain frontend, backend, database, translation, TTS, and audio processing.

Document the end-to-end request lifecycle.

**Task 4 — Investigate Exact Audio Duration**

This is one of the most important technical requirements.

Investigate Azure Speech duration features and FFmpeg processing.

Propose the simplest practical approach to match generated audio to the target duration.

Explain validation strategies, technical constraints, and trade-offs without silently changing the requirement.

**Task 5 — Validate the Free-Tier Infrastructure Plan**

Verify current Azure, Render, Neon, and related service policies, limits, and costs.

Identify any required billing accounts, quotas, provider restrictions, or unexpected expenses.

Favor free services wherever possible.

Do not add arbitrary generation-count or transcript-length limits.

**Task 6 — Define an Implementation Backlog**

Break the MVP into small tasks suitable for Claude Code.

Each task should have:

- Objective.
- Inputs.
- Expected behavior.
- Dependencies.
- Acceptance criteria.
- Tests.

Keep tasks small enough to implement and verify incrementally.

**Task 7 — Plan Deployment**

Prepare a step-by-step deployment strategy for:

- GitHub
- Render
- Neon
- Azure services
- GoDaddy DNS
- mydubb.com
- HTTPS
- Private Beta security

**Task 8 — Prepare Claude Code Handoff**

Once architecture and planning are approved, prepare a clear implementation brief that Claude Code can follow.

Do not generate the application code until the founder explicitly authorizes implementation.

---

# PART 17 — COMMUNICATION STYLE & WORKING AGREEMENT

The founder is an experienced software engineer with a background in Java, Spring Boot, React, Python, AWS, SQL, and backend development.

The founder wants a collaborative planning process.

Follow these rules:

1. Communicate primarily in Vietnamese.
2. Keep technical terms in English when appropriate.
3. Explain difficult concepts with simple examples.
4. Avoid unnecessarily long responses during normal brainstorming.
5. Discuss decisions one at a time.
6. Offer clear recommendations.
7. Wait for the founder to approve important architectural choices.
8. Do not generate code unless requested.
9. Do not create project files unless requested.
10. Do not start deployment without approval.
11. Do not introduce unnecessary technologies.
12. Remember the founder wants a functioning MVP as quickly and cheaply as practical.
13. Preserve all decisions already made.
14. Treat unclear requirements as discussion items rather than making unapproved assumptions.
15. Challenge technical assumptions constructively, without repeatedly reopening settled product decisions.

The goal is to work together as a small engineering team, not to generate a large speculative architecture.

---

# PART 18 — WHERE TO START THE NEXT CONVERSATION

Start by acknowledging that you understand the MyDubb project and its finalized MVP requirements.

Then:

1. Provide a concise assessment of the current MVP.
2. Identify the most important remaining architectural risks.
3. Recommend the first planning decision that should be resolved.
4. Discuss that decision with the founder.

Do not jump directly into writing code.

Do not unnecessarily repeat this entire context back to the founder.

**Project Status: Ready for Architecture Planning.**

**Next Step: Codex and the founder collaboratively finalize the MyDubb MVP architecture before handing implementation to Claude Code.**
