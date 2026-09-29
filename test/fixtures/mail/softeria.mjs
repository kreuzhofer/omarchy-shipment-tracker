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
// Each message's HTML body, for `get-mail-message` on a server started with
// MS365_MCP_BODY_FORMAT=html (Graph's own text/HTML switch).
const HTML = new Map();

// One Graph message. `sender`: the address; `body`: the text body (Softeria
// asks Graph for text bodies by default); `html`: the HTML body (else the
// text wrapped in <html>).
export function mail({ sender, name = "Amazon.de", receivedDateTime, subject, body, html = null }) {
  const id = `AAMkSYNTHETIC${String(++nextId).padStart(4, "0")}=`;
  HTML.set(id, html ?? `<html><body><p>${body}</p></body></html>`);
  return {
    id,
    receivedDateTime,
    subject,
    from: { emailAddress: { name, address: sender } },
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

// ---- Mail from other senders that names a DHL number (#59). Layouts are
// synthetic: eBay's real markup is still to be verified on a real mail.

// A marketplace's "your item has shipped" mail (eBay-like): the item links
// its listing, the number comes with the carrier's name.
export const marketplaceShipped = ({ trackingNumber, item, at, sender = "ebay@ebay.de" }) => mail({
  sender, name: "eBay", receivedDateTime: at, subject: `Versendet: ${item}`,
  body: `Gute Nachrichten! Dein Artikel ist unterwegs. ${item} Versand mit DHL Sendungsnummer: ${trackingNumber} Voraussichtliche Lieferung: Do, 1. Okt`,
  html: `<html><body><table><tr><td><img src="https://i.ebayimg.com/images/g/AAAAAAAAAAAAAAAA/s-l140.jpg" alt=""></td>`
    + `<td><a href="https://www.ebay.de/itm/100000000001?mkevt=1">${item.replaceAll("&", "&amp;")}</a><br>Verkauft von: beispiel_verkauf</td></tr>`
    + `<tr><td colspan="2">Versand mit DHL · Sendungsnummer: <a href="https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${trackingNumber}">${trackingNumber}</a></td></tr></table></body></html>`,
});

// A shop's shipping confirmation with schema.org ParcelDelivery markup, and
// a subject that names no item.
export const shopShipped = ({ trackingNumber, item, at, schemaNumber = trackingNumber }) => mail({
  sender: "versand@shop.example", name: "Beispiel-Shop", receivedDateTime: at, subject: "Ihre Bestellung EX-1001 wurde versandt",
  body: `Hallo, deine Bestellung EX-1001 ist mit DHL unterwegs. Sendungsnummer ${trackingNumber}.`,
  html: `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "http://schema.org", "@type": "ParcelDelivery", trackingNumber: schemaNumber,
    carrier: { "@type": "Organization", name: "DHL" },
    itemShipped: { "@type": "Product", name: item, image: "https://shop.example/img/1.jpg" },
    partOfOrder: { "@type": "Order", orderNumber: "EX-1001", merchant: { "@type": "Organization", name: "Beispiel-Shop" } },
  })}</script></head><body><p>Deine Bestellung EX-1001 ist mit DHL unterwegs. Sendungsnummer ${trackingNumber}.</p></body></html>`,
});

// A newsletter that mentions DHL and a long number that isn't a tracking number.
export const newsletter = ({ at }) => mail({
  sender: "news@shop.example", name: "Beispiel-Shop", receivedDateTime: at, subject: "Versandkostenfrei mit DHL",
  body: "Nur heute: versandkostenfrei mit DHL. Gutscheincode 2026092912345 gilt bis Sonntag. Kundennummer 123456789012.",
});

// A Hermes mail: a tracking number, but not DHL's.
export const otherCarrier = ({ at }) => mail({
  sender: "noreply@carrier.example", name: "Paketdienst", receivedDateTime: at, subject: "Ihre Sendung ist unterwegs",
  body: "Sendungsnummer: 12345678901234 Zustellung morgen.",
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
    get: null,
    verifies: 0,
    searches: [],
    gets: [],
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
      // Graph honours the server's body format: HTML when started with
      // MS365_MCP_BODY_FORMAT=html. `account.get(args)` may override the answer.
      "get-mail-message": (args, { env }) => {
        account.gets.push(args);
        const override = account.get?.(args);
        if (override) return override;
        const m = account.mails.find((x) => x.id === args["message-id"]);
        if (!m) return toolAnswer({ error: "Error in tool get-mail-message: Microsoft Graph API error: 404 Not Found - {}" }, { isError: true });
        const body = env.MS365_MCP_BODY_FORMAT === "html" ? { contentType: "html", content: HTML.get(m.id) } : m.body;
        return toolAnswer({ id: m.id, body });
      },
      logout: async (args, { env }) => {
        for (const file of [env.MS365_MCP_TOKEN_CACHE_PATH, env.MS365_MCP_SELECTED_ACCOUNT_PATH]) await rm(file, { force: true });
        return toolAnswer({ message: "Logged out successfully" });
      },
    },
  };
  return account;
}
