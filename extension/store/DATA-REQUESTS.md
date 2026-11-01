# Handling data requests sent to support@mydubb.com (PROPOSAL)

**Status: a proposal for the Product Owner. It is not a process that exists, and nothing in it
is promised in the privacy policy.** The policy says only how to write to the operator
([PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md), "Ending it and removing data"). No time
limit and no promise to delete go into the policy until the steps below exist, have been done
once by hand on a test account, and the Product Owner has decided the open points at the end.

Operator: Can Nguyen. Contact: support@mydubb.com (confirmed by the Product Owner, 2026-11-01).

## What a user can already do without any request

- **Disconnect** in the extension removes the token from the browser and ends it on the server.
- Closing the tab, quitting the browser or uninstalling removes everything the extension stored
  ([PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) §1).
- Translations and MP3s leave the server by themselves after `RESULT_TTL_SECONDS` (code default
  1 hour; production value not checked here).

So a request is only about what the **server** keeps: the account, job records, and what
providers hold.

## Proposed steps

1. **Receive.** The request arrives at support@mydubb.com. The support page tells the user to
   write from the e-mail address of the MyDubb account and not to send transcripts, passwords,
   tokens or screenshots of the account ([LISTING.md](LISTING.md)).
2. **Check who is asking.** The sender address must equal the e-mail on the account. If it does
   not, reply to the **account's** address asking for confirmation. Do not ask for identity
   documents.
3. **Record it.** Keep a private note (outside the repository) with the date received, the kind
   of request (question, access, deletion), the account's user id, what was done and the date it
   was closed. No transcript or token goes in the note.
4. **Find the data.** Where it is, from the code and migrations (not from production):

   | Data | Where | Removed with the account row? |
   |---|---|---|
   | E-mail, display name, Cognito `sub`, disabled flag, role | `users` | – (this is the row) |
   | Website and extension sessions (token hashes; `client` is `web` or `extension`), extension sign-in codes | `user_sessions`, `extension_auth_codes` | **Yes**, `ON DELETE CASCADE` (migrations 0005, 0011) |
   | Job metadata (status, language, voice, times, speed, text length, providers, error, owner) | `jobs` | **No**: `jobs.user_id` is `ON DELETE SET NULL`, so the rows stay but lose the owner. They must be deleted on purpose if the user asks for it |
   | Usage records per job and per provider request (no text, no user id; keyed by job id) | `job_usage`, `job_usage_attempts` | **No**: no foreign key (migration 0020), so they stay when the job or user row goes. They are deleted by the server after `USAGE_RETENTION_DAYS` (code default 180). Linkable to the user only while the `jobs` row exists |
   | Role changes (user id, old/new role, time, operator login) | `user_role_events` | **No**: the table has no foreign key (migration 0012), so the rows stay and keep the user id (no e-mail) |
   | Technical terms found in translations | glossary candidates | Not linked to a user, job or text, so they cannot be found or removed per user |
   | Password and sign-in | Amazon Cognito user pool | Separate: removed in Cognito, not by deleting the MyDubb row |
   | Text and translation sent to Microsoft | Azure Translator and Speech | Not under the operator's control; Microsoft's terms apply |
   | Request details (network address) | Hosting provider's access logs | Not under the operator's control; retention not verified |
   | Backups and point-in-time history of the database | Neon | **Not verified**: whether deleted rows persist in history, and for how long |

5. **Answer an access or question request** by telling the user what is held (account fields,
   number and dates of jobs) in plain words, from the table above, without sending anything that
   contains other people's data.
6. **Carry out a deletion request** only by steps that were written down and tried on a test
   account: disable the user in Cognito, delete the account's `jobs` rows and then the `users`
   row (sessions follow by cascade), delete the Cognito user. Tell the user what could not be
   removed (Microsoft, hosting logs, database history, glossary terms) in the same words as the
   policy.
7. **Close.** Reply to the account's address, then complete the private note.

## What has to exist before the policy may promise anything

- A written, tested procedure for step 6 (today there is **no** tool and **no** documented way
  to delete job rows or an account; the only operator tool is for roles). Building a tool is a
  separate story.
- A decision on the open points below.

## Open points (Product Owner)

- The reply time the operator can really keep (none is stated anywhere yet).
- Delete the job rows, or keep them without an owner (the database already does the second when
  only the `users` row goes).
- Whether to build the proposed 7-day cleanup of job metadata first
  ([PRIVACY-AUDIT.md](PRIVACY-AUDIT.md) §2); it would reduce what a request has to cover.
- Who else may read support@mydubb.com, and where the private note lives.
- Whether Neon's history and Render's logs can be limited or deleted, once checked in their
  dashboards.
