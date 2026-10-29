# Glossary

The glossary is the list of English technical terms that MyDubb keeps in English in the
Vietnamese translation and reads with an English voice span. The same list is used, unchanged, for
Mandarin Chinese jobs (see the end of "How translation and speech use it"). This page explains how
it is used, how to write entries, which terms belong in it and how to change it.

## Purpose and location

- File: [`backend/app/translation/data/glossary.txt`](../backend/app/translation/data/glossary.txt),
  bundled with the backend image. It holds entries only: one term per line, no comments,
  headings or blank lines. The rules live on this page.
- It is a **static** list. It is maintained by hand through Git and pull requests, and it changes
  in production only when a new version of the app is deployed. No job, API, external
  term-review service or automatic process edits it.
- Code: `backend/app/translation/glossary.py` parses the file and finds the terms (one
  Aho-Corasick automaton built once per process; see
  [ARCHITECTURE.md](ARCHITECTURE.md#azure-translator-and-technical-terms-milestone-3a)).

## How translation and speech use it

1. **Translation.** Before the English transcript is sent to Azure Translator, every listed term
   found in it is wrapped in `notranslate` markup, so Azure keeps it as written. After
   translation the app checks that every protected term came back exactly; if one is missing or
   altered, the job fails with `translation_terms_not_preserved` instead of returning a wrong
   translation.
2. **Speech.** The same list is matched on the Vietnamese translation. Each occurrence is read
   inside an `en-US` language span, with the same voice as the Vietnamese text around it.
3. **Terms that are not listed.** Azure may translate them or leave them in English. A separate
   detection step reads English the translation kept with `en-US` only when it can tell
   confidently that the word is English (for example `kernel`, `VMs`). Words that could also be
   Vietnamese syllables (`run`, `map`, `Go`) stay `vi-VN`, so they may be read as Vietnamese.
   That detection never adds entries to this file.
4. **Mandarin jobs.** Translation protects the same terms. On the Chinese translation the terms
   are matched with Han characters as word boundaries (Chinese has no spaces), and read `en-US`
   inside `zh-CN` text. The Vietnamese-syllable rule does not apply: a word copied from the source
   (`run`, `Go`) is read `en-US`. The selection rules below were written for Vietnamese and are not
   changed for Mandarin.

The glossary therefore has two effects at once: it **stops translation** of a term and it makes
speech **read it in English**. An entry that is too broad damages ordinary sentences in both
places.

## Format

| Rule | Detail |
|---|---|
| One entry per line | A word or a multi-word term. No explanations, Vietnamese translations or phonetic spellings |
| Capitalization | Matching ignores case by default, and the text keeps its own spelling: `Neural Network` stays `Neural Network` |
| `=` prefix | `=TERM` matches that exact capitalization only (`=REST` matches `REST`, not `rest` or `Rest`). The `=` is part of the syntax, not of the term |
| Whole words | `API` does not match inside `capital`. Punctuation around a term is fine (`(API),`, `API-first`, `Docker's`) |
| Plural | An optional `s` belongs to the match (`APIs`, `neural networks`), so list the singular. Terms ending in `s` or in a symbol (`Kubernetes`, `C++`) get no extra `s`. Other endings (`-ed`, `-ing`) are not matched: list such a form only when it is common in its own right (`fine-tuning`, `fine-tuned`) |
| Whitespace | Words of a multi-word term match across any run of spaces, tabs or line breaks. In the file, use single spaces |
| Overlap | When matches overlap, the longest wins, then the earliest: `Azure Kubernetes Service` beats `Kubernetes`, `convolutional neural network` beats `neural network` |
| Aliases | List another spelling only when it really occurs in transcripts and is not covered by the rules above. Today: `frontend`/`front-end`, `backend`/`back-end`, `full-stack`/`fullstack`, `pretraining`/`pre-training`, `autoscaling`/`auto scaling`, `Bayes' theorem`/`Bayes theorem`. `Spring Boot` is listed; `SpringBoot` is deliberately not (no evidence it appears) |
| Limits | At most 100 characters; no `<`, `>`, `&` or control characters (the parser rejects the file otherwise). Unique by case policy: `API` and `api` are duplicates; `=REST` and `rest` would not be |
| Order | Sorted by the term ignoring `=` and case (then by the raw line), so a term is easy to find and diffs stay small |

## Selection policy

**Add**

- Product, service, project and language names that are not ordinary words: `PostgreSQL`,
  `Kubernetes`, `Amazon S3`, `Azure Functions`, `BigQuery`, `PyTorch`, `LangChain`.
- Acronyms: `JWT`, `CI/CD`, `LLM`, `RLHF`, `OWASP`.
- Multi-word technical phrases with one clear meaning: `loss function`, `server-side rendering`,
  `eventual consistency`, `retrieval-augmented generation`, `dead-letter queue`.
- Single words that are technical only: `microservice`, `idempotency`, `hyperparameter`,
  `tokenizer`, `webhook`, `namespace`.
- Technical terms that also have a standard Vietnamese translation. Having one is **not** a
  reason to leave a term out; the Product Owner prefers technical terms in English:
  `binary search`, `hash table`, `dynamic programming`, `normal distribution`,
  `standard deviation`, `eigenvalue`, `speech recognition`, `hash function`.

**Do not add**

- Everyday words, even when they are frequent in technical text: `class`, `model`, `function`,
  `application`, `server`, `key`, `value`, `object`, `thread`, `memory`, `table`, `cell`,
  `layer`, `node`, `token`, `prompt`, `agent`, `cache`, `deployment`, `branch`, `commit`.
  Use the phrase instead: `domain model`, `application server`, `access token`,
  `prompt engineering`, `AI agent`, `cache miss`, `blue-green deployment`, `feature branch`.
- Names that are ordinary words: `Go`, `Rust`, `Swift`, `Ruby`, `Java`, `R`, `C`, `Spring`,
  `Flask`, `pandas`, `Bun`, `Ray`, `Lambda`, `Spanner`, `Workflows`, `curl`. Use specific
  phrases or forms: `Golang`, `goroutine`, `rustc`, `SwiftUI`, `Ruby on Rails`,
  `Java Virtual Machine`, `JDK`, `Spring Boot`, `AWS Lambda`, `lambda expression`,
  `Cloud Spanner`, `Apache Airflow`.
- Technical phrases that are also everyday idioms: `divide and conquer` (also a common
  expression in politics and business).
- `AI` and `IT` alone (`ai` is a Vietnamese word; detection already reads `AI` copied from the
  source as an acronym). Use phrases: `generative AI`, `AI agent`.
- Long sentences, explanations, Vietnamese translations or phonetic spellings.

**Exact case (`=`)** is for a term that is also an ordinary word in another capitalization:
`=REST`, `=ACID`, `=SOLID`, `=CRUD`, `=RAG`, `=ARIA`, `=ROUGE`, `=BLEU`, `=BERT`, `=LoRA`,
`=React`, `=Angular`, `=Spark`, `=Azure`, `=Cloud Storage`. It is also used for acronyms and
names whose letters form a possible Vietnamese syllable or name, because speech matches the
glossary on the Vietnamese translation too: `=LAN` (the name Lan), `=GAN` (gan), `=NAT`,
`=UI`, `=GUI`, `=RAM`, `=DOM`, `=IAM`, `=Vue`. Exact case does not solve everything:

- A capitalized ordinary word at the start of a sentence still matches (`Spark plugs ...`,
  `React calmly ...`). This was accepted for names that are very frequent in course material.
- It does not help a name that is written in lower case like the ordinary word (`pandas`), so
  such names are left out.

**Before adding a single word**, check that it is not a common English word and not shaped like
a Vietnamese syllable (`app/pronunciation/vietnamese.py`, `may_be_vietnamese`). `tanh` was left
out for that reason (`tanh` is a Vietnamese word).

## What is covered

2,141 entries (64 exact case). There is no fixed limit: an entry is added when it meets the
policy above, never to reach a number. The groups below are approximate; the file itself is not
grouped.

| Group | Examples |
|---|---|
| Software engineering (architecture, patterns, testing, debugging, code quality, version control, process) | `domain-driven design`, `CQRS`, `observer pattern`, `test-driven development`, `stack trace`, `merge conflict`, `=Scrum` |
| Backend (HTTP and APIs, authentication and authorization, concurrency, messaging, distributed systems, caching) | `gRPC`, `OpenID Connect`, `RBAC`, `mutex`, `message broker`, `CAP theorem`, `cache invalidation` |
| Databases | `foreign key`, `isolation level`, `materialized view`, `MongoDB`, `pgvector`, `SQLAlchemy` |
| Frontend and web platform (rendering, browser APIs, frameworks, build tools, accessibility, mobile) | `server-side rendering`, `IndexedDB`, `Next.js`, `Vite`, `WCAG`, `Jetpack Compose` |
| DevOps, SRE, networking and security | `GitOps`, `StatefulSet`, `Helm chart`, `OpenTelemetry`, `error budget`, `TLS handshake`, `SQL injection` |
| Cloud: general concepts, AWS, Azure, Google Cloud | `availability zone`, `Amazon DynamoDB`, `AWS Step Functions`, `Azure Cosmos DB`, `Microsoft Entra ID`, `Cloud Run`, `Vertex AI` |
| Languages, runtimes, frameworks, libraries, developer tools, operating systems | `CPython`, `JVM`, `ASP.NET Core`, `goroutine`, `NumPy`, `Visual Studio Code`, `systemd` |
| Computer science and computer architecture | `binary search`, `hash table`, `Big O notation`, `red-black tree`, `Bloom filter`, `NP-complete`, `kernel space`, `RISC-V`, `CUDA` |
| Data engineering and analytics | `data lakehouse`, `change data capture`, `Apache Iceberg`, `dbt`, `star schema`, `Jupyter Notebook` |
| AI, machine learning, deep learning, NLP, computer vision, generative AI, agents, optimization | `cross-validation`, `batch normalization`, `self-attention`, `object detection`, `=LoRA`, `RLHF`, `Model Context Protocol`, `KV cache` |
| Mathematics and statistics used in AI material | `normal distribution`, `standard deviation`, `eigenvalue`, `Bayes' theorem`, `Markov chain Monte Carlo`, `KL divergence`, `p-value`, `Hessian matrix` |
| Earlier science entries (kept unchanged) | `DNA`, `CRISPR`, `Krebs cycle`, `Schrödinger equation` |

Cloud service names change: when a provider renames a service, keep the earlier name while
course material still uses it and add the new one (for example `Vertex AI` and
`Gemini Enterprise Agent Platform`, `Kinesis Data Firehose` and `Amazon Data Firehose`,
`Cloud Functions` and `Cloud Run functions`, `Azure AI Foundry` and `Microsoft Foundry`).

### Sources

Spellings and service names were checked against official sources (October 2026). No list was
copied wholesale; entries were selected under the policy above.

- AWS: [Service endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/aws-service-information.html)
  (service names), [AWS products](https://aws.amazon.com/products/), and the
  [Amazon Data Firehose rename](https://aws.amazon.com/about-aws/whats-new/2024/02/amazon-data-firehose-formerly-kinesis-data-firehose).
- Microsoft Azure: [Azure products directory](https://azure.microsoft.com/en-us/products/),
  [Azure AI services documentation](https://learn.microsoft.com/en-us/azure/ai-services/).
- Google Cloud: [Google Cloud Platform Services Summary](https://cloud.google.com/terms/services)
  (current names and their "formerly" names), [App Engine documentation](https://docs.cloud.google.com/appengine/docs).
- Other product, project and language names: their official websites and documentation.
  General terms (software engineering, web, DevOps, machine learning, statistics) were written
  from standard usage in technical documentation and course material.

## Changing the glossary

1. Branch from an up-to-date `main` ([WORKFLOW.md](WORKFLOW.md)).
2. Edit `glossary.txt`: insert each entry at its sorted position; keep existing entries unless
   there is a concrete problem, and say in the pull request why an entry is changed or removed.
3. Validate locally from `backend/`:

   ```bash
   uv run pytest tests/test_glossary.py tests/test_glossary_content.py
   ```

   `test_glossary_content.py` loads the file with the real parser (empty terms, length,
   forbidden characters, duplicates by case policy), checks that it has no comments or blank
   lines and that it is sorted, and runs representative ordinary and technical sentences.
   No test pins the total number of entries.
4. Review: for each new entry, ask whether keeping it in English is right in **every** sentence
   it could match, in English and in Vietnamese. Prefer the phrase over the single word.
5. Open a pull request; CI runs the full backend suite. The Product Owner reviews and merges.
6. The new list is used after the merge is deployed (continuous deployment from `main`); each
   process loads it once, on first use.

Optional: `uv run python -m scripts.glossary_timing` measures matching on synthetic data. With
the expanded glossary (2,141 entries) and a synthetic transcript of 1,000 words, a local
Windows laptop measured a build of 0.13-0.15 s once per process and about 1-2 ms per match of
the whole transcript. Numbers from a laptop say nothing about the Render instance.

## Limits

- The glossary protects listed terms only. It does not guarantee that every technical term is
  kept, translated well or pronounced well.
- Ambiguity remains: a listed phrase can still occur with an ordinary meaning, and exact-case
  names match a capitalized ordinary word at the start of a sentence.
- `en-US` says which language reads a term, not how well the voice pronounces it; only
  listening tells.
- Every protected occurrence adds the `notranslate` wrapper (33 characters,
  `WRAPPER_OVERHEAD` in `notranslate_markup.py`) to the characters Azure Translator counts
  against the quota (see [DEPLOYMENT.md](DEPLOYMENT.md)). More entries means more
  protected occurrences per transcript.
- Azure could still drop or alter a protected span; the job then fails visibly rather than
  returning a wrong translation.

## Legacy: glossary candidates

The code from PR #20 that collects English left in translations as *glossary candidates*
(table `glossary_candidates`, `scripts/glossary_candidates.py`) is still in the repository and
still runs. It is legacy and not part of maintaining the glossary: the current decision is the
static list above, changed through pull requests. Removing or replacing that code, table or
migration is a separate task.
