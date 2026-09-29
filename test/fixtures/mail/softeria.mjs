// Recorded Softeria ms-365-mcp-server 0.156.2 answers, rebuilt synthetically:
// the answer shapes and error texts are the server's own (seen live with
// `--read-only --enabled-tools '^(list-mail-messages|get-mail-message)$'`), the
// mail shapes follow Microsoft Graph's message resource and the amazon.de
// templates seen on #8. Every Order ID, item, name, address and code here is
// made up; no real mail was copied.
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { toolAnswer } from "../../harness.mjs";

export const DEVICE_CODE = "FAKE12345";
export const DEVICE_URL = "https://microsoft.com/devicelogin";

// The `login` tool's answer when no account is cached: MSAL's device-code
// message, as Softeria wraps it.
export const deviceCodeRequired = () => toolAnswer({
  error: "device_code_required",
  message: `To sign in, use a web browser to open the page ${DEVICE_URL} and enter the code ${DEVICE_CODE} to authenticate.\nAfter login run the "verify login" command`,
});
export const notSignedIn = () => toolAnswer({ success: false, message: "Login failed: No valid token found" });
export const signedIn = () => toolAnswer({
  success: true, message: "Login successful", userData: { displayName: "Test User", userPrincipalName: "user@example.test" },
});
export const noAccount = () => toolAnswer({ error: "No accounts found. Please login first." }, { isError: true });
export const silentRefreshFailed = () => toolAnswer({ error: "Error in tool list-mail-messages: Silent token acquisition failed" }, { isError: true });
export const graphError = (status, text) => toolAnswer({ error: `Error in tool list-mail-messages: Microsoft Graph API error: ${status} ${text} - {}` }, { isError: true });
export const messageList = (value) => toolAnswer({ "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('me')/messages", value });

let nextId = 0;
const PADDING = "͏ ‌ ­".repeat(6);

// One Graph message. `sender`: the address; `body`: the text body (Softeria
// asks Graph for text bodies).
export function mail({ sender, receivedDateTime, subject, body }) {
  return {
    id: `AAMkSYNTHETIC${String(++nextId).padStart(4, "0")}=`,
    receivedDateTime,
    subject,
    from: { emailAddress: { name: "Amazon.de", address: sender } },
    body: { contentType: "text", content: body },
  };
}

// amazon.de templates, trimmed to what matters: the header, the progress
// line, an estimate phrase (or none), the recipient line, the Order ID
// (with the right-to-left mark Amazon puts before it) and the item.
const amazonBody = (headline, { orderId, item, estimate }) => [
  `${PADDING} [Amazon.de] Meine Bestellungen ${headline}`,
  "[Abgeschlossen] Bestellt [Ausstehend] Versendet [Ausstehend] In Zustellung [Ausstehend] Zugestellt",
  estimate ?? "",
  "Erika – Musterstadt",
  `Bestellnr. ‫${orderId} Lieferung verfolgen [${item}] Menge: 1 Summe 12,34 €`,
  "Amazon.de ist ein Handelsname für Amazon EU Sarl. Widerrufsrecht: Du hast das Recht, diesen Vertrag innerhalb von 14 Tagen zu widerrufen.",
].join(" ");

const short = (item) => (item.length > 20 ? `${item.slice(0, 20)}...` : item);

export const orderConfirmation = ({ orderId, item, at, estimate = "Lieferung 6. – 8. Oktober" }) => mail({
  sender: "bestellbestaetigung@amazon.de", receivedDateTime: at, subject: `Bestellt: „${short(item)}“`,
  body: amazonBody("Danke für deine Bestellung.", { orderId, item, estimate }),
});
export const shippingConfirmation = ({ orderId, item, at, estimate = "Ankunft morgen" }) => mail({
  sender: "versandbestaetigung@amazon.de", receivedDateTime: at, subject: `Versendet: „${short(item)}“`,
  body: amazonBody("Dein Paket wurde versendet!", { orderId, item, estimate }),
});
export const outForDelivery = ({ orderId, item, at, estimate = "Ankunft heute" }) => mail({
  sender: "shipment-tracking@amazon.de", receivedDateTime: at, subject: `In Zustellung: „${short(item)}“`,
  body: amazonBody("Dein Paket wird heute zugestellt.", { orderId, item, estimate }),
});
export const delivered = ({ orderId, item, at }) => mail({
  sender: "order-update@amazon.de", receivedDateTime: at, subject: `Zugestellt: „${short(item)}“`,
  body: amazonBody("Dein Paket wurde zugestellt.", { orderId, item, estimate: null }),
});
// Ignored: a refund, a digital order, a DHL notice.
export const refund = ({ orderId, at }) => mail({
  sender: "payments-messages@amazon.de", receivedDateTime: at, subject: `Gutschriftbestätigung für Bestellung ${orderId}`,
  body: `Guten Tag, wir bestätigen die Erstattung von 12,34 € für Ihre Bestellung ${orderId}.`,
});
export const digitalOrder = ({ orderId, at }) => mail({
  sender: "digitale-bestellbestaetigung@amazon.de", receivedDateTime: at, subject: "Deine Bestellung eines digitalen Artikels",
  body: `Bestellnr. ${orderId} Ein Hörbuch`,
});
export const dhlNotice = ({ at }) => mail({
  sender: "noreply@dhl.de", receivedDateTime: at, subject: "Ihr Paket von Beispiel-Shop kommt heute",
  body: "Ihr Paket kommt heute zwischen 10:00 und 13:00. Sendungsnummer 00340434000000000999",
});

// A Softeria server with one mailbox. `account.mails` is what the search
// finds (the search itself is Graph's: the fake returns them all). A Login
// signs in after `polls` verify-login calls and, like Softeria, writes its
// token cache and selected-account files where it was told to (0644 here,
// to show the tracker tightens them). `account.list` overrides the search's
// answer (e.g. an error).
export function softeriaAccount({ mails = [], polls = 1 } = {}) {
  const account = {
    mails,
    polls,
    list: null,
    verifies: 0,
    searches: [],
    tools: {
      login: () => deviceCodeRequired(),
      "verify-login": async (args, { env }) => {
        account.verifies++;
        if (account.verifies < account.polls) return notSignedIn();
        for (const file of [env.MS365_MCP_TOKEN_CACHE_PATH, env.MS365_MCP_SELECTED_ACCOUNT_PATH]) {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, '{"encrypted":"synthetic"}', { mode: 0o644 });
          await chmod(file, 0o644);
        }
        return signedIn();
      },
      "list-mail-messages": (args, server) => {
        account.searches.push(args);
        const answer = typeof account.list === "function" ? account.list(args, server) : account.list;
        return answer ?? messageList(account.mails);
      },
      logout: async (args, { env }) => {
        for (const file of [env.MS365_MCP_TOKEN_CACHE_PATH, env.MS365_MCP_SELECTED_ACCOUNT_PATH]) await rm(file, { force: true });
        return toolAnswer({ message: "Logged out successfully" });
      },
    },
  };
  return account;
}
