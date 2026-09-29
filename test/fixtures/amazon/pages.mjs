// Synthetic amazon.de pages in the shape the hidden Chrome returned in the
// Amazon discovery spike (#8): the same class names, `data-a-state` script
// and link formats, trimmed to what matters. All Order IDs, tracking numbers,
// item names and ids are made up; no recorded HTML is committed.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const head = (title) => `<!DOCTYPE html><html lang="de-de" class="a-no-js"><head><meta charset="utf-8">
<title dir="ltr">${title}</title>
<script>var ue_t0=ue_t0||+new Date();</script></head>`;

// The site header on every signed-in page links to the sign-in page and has a
// search form, as on the live pages.
const NAV = `<header id="navbar-main"><form id="nav-search-bar-form" accept-charset="utf-8" action="/s/ref=nb_sb_noss" name="site-search" role="search" method="GET"></form>
<a href="/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.de%2F&amp;ref_=nav_signin" class="nav-a">Konto und Listen</a>
<form name="signIn" method="post" action="/ap/signin" class="nav-hidden-signin"></form></header>`;

// One order card. `shipments`: [{ packageIndex, shipmentId, title, primary,
// image, items }]: `image` is the first item's `<img src>` (null: no image),
// `items` more items in the same box ([{ title, image }]).
// Live, digital orders (D01-…) had no tracker link; the fixture gives them one
// anyway so the tests show they are ignored by their Order ID.
function orderCard({ orderId, shipments }) {
  const boxes = shipments.map((s) => `
<div class="a-box delivery-box"><div class="a-box-inner">
  <div class="a-row"><div class="yohtmlc-shipment-status-primaryText"><h3><span class="a-size-medium delivery-box__primary-text a-text-bold">${esc(s.primary ?? "Unterwegs")}</span></h3></div></div>
  <ul class="a-unordered-list a-nostyle a-vertical" role="list">${[{ title: s.title, image: s.image }, ...(s.items ?? [])].map(itemBox).join("")}</ul>
  <ul class="yohtmlc-shipment-level-connections a-nostyle" role="list">${`
    <li><span class="a-button a-button-normal a-spacing-mini a-button-base"><span class="a-button-inner"><a href="/progress-tracker/package?ref=ppx_yo2ov_dt_b_fed_track_package&amp;orderId=${orderId}&amp;_encoding=UTF8&amp;shipmentId=${s.shipmentId}&amp;packageIndex=${s.packageIndex}&amp;vt=NOTIFICATIONS" class="a-button-text" role="button"> Lieferung verfolgen </a></span></span></li>`}
  </ul>
</div></div>`).join("");
  return `
<div class="order-card js-order-card"><div id="amzn1.yourorders.order-card.${orderId}" class="a-box-group a-spacing-base">
  <div class="a-box order-header"><div class="yohtmlc-order-id"><span class="a-color-secondary a-text-caps">Bestellnr.</span> <span class="a-color-secondary" dir="ltr">${orderId}</span></div>
  <a class="a-link-normal" href="/your-orders/order-details?orderID=${orderId}&amp;ref=ppx_yo2ov_dt_b_fed_order_details"> Bestelldetails anzeigen </a></div>
  ${boxes}
</div></div>`;
}

const DEFAULT_IMAGE = "https://m.media-amazon.com/images/I/example._SS142_.jpg";

function itemBox({ title, image = DEFAULT_IMAGE }) {
  const img = image === null ? "" : `<img alt="${esc(title)}" src="${esc(image)}" data-a-hires="${esc(String(image).replace(/\._[^/]*_\.jpg$/, "._SS284_.jpg"))}">`;
  return `<li><span class="a-list-item">
    <div class="a-fixed-left-grid item-box a-spacing-none"><div class="product-image"><a class="a-link-normal" tabindex="-1" href="/dp/B000000000?ref=ppx_yo2ov_dt_b_fed_asin_title">${img}</a></div>
    <div class="a-row">
        <div class="yohtmlc-product-title">
            <a aria-hidden="false" class="a-link-normal" href="/dp/B000000000?ref=ppx_yo2ov_dt_b_fed_asin_title">
                ${esc(title)}
            </a>
        </div>
    </div></div>
  </span></li>`;
}

// Below the orders, as on the live page: a recommendations carousel with
// product images of its own (the last delivery box's chunk runs into it).
export const RECOMMENDATIONS = `<div class="a-carousel-container"><ol class="a-carousel">
<li class="a-carousel-card"><div class="product-image"><img class="asin-image" src="https://m.media-amazon.com/images/I/recommended1._AC_UL75_SR75,75_.jpg"></div></li>
<li class="a-carousel-card"><div class="p13n-product-image"><img src="https://m.media-amazon.com/images/I/recommended2._AC_AA152_.jpg"></div></li>
</ol></div>`;

// `footer`: HTML after the orders (e.g. RECOMMENDATIONS).
export function historyPage(orders, { footer = "" } = {}) {
  return `${head("Meine Bestellungen")}<body>${NAV}
<div class="your-orders-content-container aok-relative js-yo-container"><div class="your-orders-content-container__content js-yo-main-content">
<h1>Meine Bestellungen</h1>
${orders.map(orderCard).join("\n")}
</div></div>${footer}</body></html>`;
}

// A progress-tracker page. `state` is merged over a delivered-by-DHL default;
// `carrierLine` is the delivery card's heading ("Versendet mit DHL").
export function trackerPage(state, { carrierLine } = {}) {
  const pageState = {
    isLexicalExceptionMessagePresent: false,
    orderId: "000-0000000-0000000",
    timezone: "Europe/Berlin",
    shortStatus: "IN_TRANSIT",
    itemIds: [],
    promise: { secondaryPromiseIdentifier: "NONE", promiseMessage: "Lieferung Donnerstag, 1. Oktober" },
    packageIndex: "0",
    locale: "de_DE",
    progressTracker: { lastTransitionPercentComplete: 50, lastReachedMilestone: "SHIPPED", numberOfReachedMilestones: 2 },
    isMfn: false,
    trackingId: null,
    deviceType: "desktop",
    isApp: false,
    shipmentId: "Tzzzzzzzz",
    healthyStateIdentifier: "NOT_APPLICABLE",
    exceptionStateIdentifier: "NOT_APPLICABLE",
    visitTrigger: "NOTIFICATIONS",
    ...state,
  };
  const card = pageState.trackingId || carrierLine
    ? `<section class="pt-card delivery-card"><div class="pt-delivery-card-wrapper"><div><h3 class="a-spacing-small">${esc(carrierLine ?? "")}</h3><div class="pt-delivery-card-trackingId">Trackingnummer ${esc(pageState.trackingId ?? "")}</div></div></div></section>`
    : "";
  return `${head("Lieferung nachverfolgen")}<body>${NAV}
<a class="a-link-normal" href="/gp/your-account/order-history/?ref=ppx_pt2_dt_b_sao_in">Alle Bestellungen anzeigen</a>
<h1 class="pt-promise-main-slot">${esc(pageState.promise?.promiseMessage ?? "")}</h1>
<div id="carrierRelatedInfo-container" class="a-row a-spacing-small cardContainer-wrapper"><div class="a-row cardContainer">${card}</div></div>
<script type="a-state" data-a-state="{&quot;key&quot;:&quot;page-state&quot;}">${JSON.stringify(pageState)}</script>
<script type="a-state" data-a-state="{&quot;key&quot;:&quot;feedback-state&quot;}">{"enabled":true}</script>
</body></html>`;
}

// A tracker page after a redesign: no `page-state` script.
export function trackerPageWithoutState() {
  return `${head("Lieferung nachverfolgen")}<body>${NAV}<h1 class="pt-promise-main-slot">Lieferung morgen</h1>
<script type="a-state" data-a-state="{&quot;key&quot;:&quot;feedback-state&quot;}">{"enabled":true}</script></body></html>`;
}

export const signInPage = () => `${head("Amazon Anmelden")}<body><div class="a-section auth-pagelet-container">
<h1 class="a-spacing-small">Anmelden</h1>
<form id="ap_login_form" name="signIn" method="post" novalidate="" action="/ax/claim?arb=00000000-0000-0000-0000-000000000000&amp;openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fyour-orders%2Forders">
<input type="email" name="email" id="ap_email"></form></div></body></html>`;

export const otpPage = () => `${head("Zwei-Schritt-Verifizierung")}<body>
<form id="auth-mfa-form" name="signIn" method="post" action="/ap/signin"><input name="otpCode" id="auth-mfa-otpcode"></form></body></html>`;

export const cvfPage = () => `${head("Bestätigung erforderlich")}<body>
<form class="cvf-widget-form cvf-widget-form-captcha fwcim-form" method="post" action="verify"><input name="cvf_captcha_input"></form></body></html>`;

export const captchaPage = () => `${head("Amazon.de")}<body><div class="a-container">
<h4>Geben Sie die angezeigten Zeichen ein</h4>
<form method="get" action="/errors/validateCaptcha" name=""><input id="captchacharacters" name="field-keywords"></form></div></body></html>`;

export const wafPage = () => `${head("Amazon.de")}<body>
<script src="https://00000000.edge.sdk.awswaf.com/00000000/challenge.js"></script>
<div id="challenge-container"></div></body></html>`;
