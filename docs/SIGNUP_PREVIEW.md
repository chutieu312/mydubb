# Sign-up prototype preview (Story B, frontend prototype phase)

A clickable prototype of **Create account → Verify email → Studio (demo)** for the Product Owner to
review. Everything is simulated in the browser. **Nothing is connected**: no Cognito, no Google
reCAPTCHA, no email service, no MyDubb API, no session, no draft. It exists only in development;
a production build does not contain it.

Status: prototype, waiting for Story A (Free usage quotas and guardrails). Public sign-up is **not**
enabled and the production Sign in page is unchanged.

## Open it

```bash
cd frontend
npm ci            # first time only
npm run dev       # http://localhost:5173
```

Open **http://localhost:5173/preview/signup**. No backend, key or account is needed (the page makes
no request). Use the header toggle to switch light and dark. **Start over** (top banner) resets the
demo. The same page lists the demo data under **Try these cases**.

## What to try

| Screen | Case | Do this | You see |
|---|---|---|---|
| Sign in | Where Create account sits | Open the page | Today's Sign in card with **Create account** under it and the Free plan line. Sign in itself is switched off in the preview |
| Create account | Empty form | Press Create account with nothing filled in | A message beside Email, Password and the checkbox; focus moves to Email |
| | Wrong email | `ada@` | Message beside Email |
| | Short password | fewer than 8 characters | Message beside Password (a rule of this preview only) |
| | Checkbox not ticked | valid email and password, box unticked | Message beside the checkbox |
| | Temporary service error | `busy@example.com`, any 8+ character password, box ticked | First try fails with a retry message and keeps the input; the second try works |
| | Success | any other valid email, 8+ character password, box ticked | Verify email |
| Verify email | Success | `123456` | Email verified, then **Open Studio (demo)** |
| | Wrong code | any other 6 digits, e.g. `654321` | Message beside the code box |
| | Expired code | `000000` | Expired message beside the code box |
| | Temporary service error | `999999` | Retry message under the code box; another code still works |
| | Not a code | empty, or letters | Message beside the code box |
| | Resend code | press Resend code | Confirmation, the box is cleared, the button waits 10 s |
| | Go back | Use a different email / Back to sign in | Create account with the email filled in / the Sign in screen |
| Studio (demo) | Generate | type text, press Generate audio | "Generate is turned off in this demo. Nothing was sent." |

Keyboard: Tab order follows the screen; Enter submits; Space ticks the checkbox; each new screen
moves focus to its title; a refused code returns focus to the code box.

## Screenshots

[Sign in with Create account](assets/signup-preview-desktop-sign-in.png) ·
[Create account errors](assets/signup-preview-desktop-create-errors.png) ·
[Verify email, dark](assets/signup-preview-desktop-dark-verify.png) ·
[Studio demo](assets/signup-preview-desktop-studio-demo.png) ·
[Create account errors, mobile dark](assets/signup-preview-mobile-dark-create-errors.png) ·
[Verify email after resend, 320 px](assets/signup-preview-320-verify-resent.png)

## How it is kept apart

- Entry: `frontend/src/main.tsx` loads `src/preview/signup/` only when `import.meta.env.DEV` is
  true. In a production build Vite replaces it with `false`, so the code, the styles and the route
  are not in the bundle, and `/preview/signup` opens the normal app.
- State: the mock (`mockSignup.ts`) and every screen's state live in component memory. The only
  thing written to browser storage is the light/dark choice the site already saves. The real
  Studio's drafts live in `App`, which the preview never mounts.
- Reused as they are: `AuthCard`, `TextField`, `PasswordField`, `FormError`, `useSubmit`, the code
  rules in `newPasswordValidation.ts`, `AppHeader`, `AppFooter`, and the real `DubbingForm` in the
  demo Studio (with fixed sample languages and voices). No existing file was changed except
  `main.tsx`.
- The demo Studio stops the form's submit in the capture phase, before the form's own handler, so
  no request is made (a test fails if `fetch` is called).
- The Sign in card is a copy of `SignInForm`'s layout, not the component: `SignInForm` shows
  "Access is currently by invitation only.", which would contradict Create account. The real
  integration will edit `SignInForm` itself.

## Preview values that are not decisions

- The password rule (8+ characters), the 6-digit code wording, the 10 s resend wait and the
  `busy@example.com` / `123456` / `000000` / `999999` values are only there to make each state
  reproducible. The real rules belong to the identity service.
- Endpoints, payloads, error codes and the session contract for sign-up are not defined here.
- The Free plan sentence (20 Generates and 5 YouTube imports per day, reset at 00:00 UTC) is
  preview copy. There is no counter, so nothing looks like a live quota.
- The header in the demo Studio shows the email as a signed-in user would see it; the page says
  that no account or session exists.

## After Story A is merged

Update from `origin/main`, then replace the mock with the real flow: Cognito sign-up and email
verification, Google reCAPTCHA Checkbox verified by the backend, Free plan assigned by the backend
under Story A's merged contract. Delete `src/preview/signup/`, put Create account into
`SignInForm`/`PasswordAuthFlow`, and adjust the screens to what the backend really returns. Whether
sign-up should say that an email already has an account (an enumeration trade-off) is a Product
Owner decision, not shown here.

## Checks

```bash
cd frontend && npm run lint && npm run typecheck && npm test && npm run build
```

`src/preview/signup/*.test.ts(x)` cover each case above, focus handling, and that the preview makes
no request and writes no storage. Production check: after `npm run build`, `dist/` contains no
preview string and `/preview/signup` shows today's Sign in.
