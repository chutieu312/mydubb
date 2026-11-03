// Prints the Chrome extension ID that a public key gives, so the key copied from the Chrome Web
// Store dashboard ("Package" tab → "View public key") can be checked against the Item ID shown
// there before it is used anywhere. Only a PUBLIC key is read; never pass a private key.
//
//   node store/tools/key-to-id.mjs <file>     file holds the PEM block or the one-line manifest "key" value
//   node store/tools/key-to-id.mjs --self-test  checks the derivation with a throwaway key (no input needed)
//
// How Chrome derives the ID: SHA-256 of the DER-encoded public key (SubjectPublicKeyInfo), first
// 16 bytes, each hex digit 0-f written as a-p.
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function idFromPublicKey(text) {
  const body = text
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  if (/PRIVATE/i.test(text)) throw new Error("This looks like a private key. Do not use it here; stop and delete it from this machine.");
  const der = Buffer.from(body, "base64");
  // Parsing proves it is a well-formed SPKI public key and not any other base64 text.
  createPublicKey({ key: der, format: "der", type: "spki" });
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

function selfTest() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const oneLine = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const a = idFromPublicKey(pem);
  const b = idFromPublicKey(oneLine);
  if (!/^[a-p]{32}$/.test(a) || a !== b) throw new Error(`self-test failed: ${a} ${b}`);
  console.log("self-test passed (throwaway key, nothing stored)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (arg === "--self-test") selfTest();
  else if (!arg) {
    console.error("usage: node store/tools/key-to-id.mjs <public-key-file> | --self-test");
    process.exit(2);
  } else console.log(idFromPublicKey(readFileSync(arg, "utf8")));
}
