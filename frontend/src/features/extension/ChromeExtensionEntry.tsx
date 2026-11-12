// "MyDubb for Chrome" under the sign-in form: the published Chrome Web Store item. The words
// describe what the published version can do; "try it as a guest" only once the server offers
// guests in the extension (GET /api/meta guest_access.extension), which the Product Owner turns on
// after a Store version that has it is published (docs/EXTENSION_AUTH.md, "Guests").

export const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/nndofiifflpbhefoehcbfpnaoiohicop";

interface Props {
  // The server offers "Try as guest" in the extension.
  guest: boolean;
}

export function ChromeExtensionEntry({ guest }: Props) {
  return (
    <section className="extension-entry stack" aria-labelledby="extension-entry-title">
      <h3 id="extension-entry-title" className="extension-entry-title">
        MyDubb for Chrome
      </h3>
      <p className="muted small">
        {guest
          ? "Select the English transcript on a Udemy lecture or another web page, send it to MyDubb and listen in your language in Chrome's side panel. Connect your MyDubb account in the extension, or try it as a guest."
          : "Select the English transcript on a Udemy lecture, send it to MyDubb and listen in your language beside the video, in Chrome's side panel. Connect your MyDubb account in the extension."}
      </p>
      <a
        className="button ghost wide"
        href={CHROME_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Install Chrome extension
      </a>
    </section>
  );
}
