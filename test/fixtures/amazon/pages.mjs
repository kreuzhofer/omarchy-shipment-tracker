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

// The Amazon Business order history (#64), in the shape of a scrubbed live
// page: the orders sit in #yourOrderHistorySection, one #orderCard box group
// per Order (a header with the order-details link, then one
// #orderCardDeliveryBox per Shipment), items as `<img class="itemImageSource">`
// with the title as the `/dp/…` link's text, and the tracker link in the box's
// button stack after the items, next to the packing slip. There is neither
// `your-orders-content-container` nor `a-box delivery-box`. `orders` as for
// historyPage; `pending`: cards not rendered yet (skeletons, no links).
// The live page's image markup is not known for sure (#68), so a Shipment or
// item may give `imageAttrs` ({ src, "data-src", srcset, … }) for its `<img>`
// instead of `image`, and a Shipment `itemsAfterLink: true` puts its items
// after the button stack with the tracker link.
function businessOrderCard({ orderId, shipments }) {
  const boxes = shipments.map((s) => {
    const items = `
    <div id="deliveryItemList" class="a-column a-span8"><div class="a-row"></div>${[{ title: s.title, image: s.image, imageAttrs: s.imageAttrs }, ...(s.items ?? [])].map(businessItem).join("")}</div>`;
    return `
<div id="orderCardDeliveryBox" class="a-box"><div class="a-box-inner">
  <div class="a-row"><div class="a-column a-span9"><div class="a-row a-size-medium"><span class="a-color-base a-text-bold">${esc(s.primary ?? "Unterwegs")}</span></div></div></div>
  <div class="a-row a-spacing-top-medium">${s.itemsAfterLink ? "" : items}
    <div class="a-column a-span4 a-span-last"><div class="a-button-stack">
      <span class="a-button a-spacing-mini a-button-primary"><span class="a-button-inner"><a href="/ps/product-support/order?orderId=${orderId}&amp;ref=ab_ppx_yo_dt_b_ps" class="a-button-text">Produktsupport</a></span></span>
      <span class="a-button a-spacing-mini a-button-base"><span class="a-button-inner"><a href="/vps/pslip?fnid=Amazon&amp;orderId=${orderId}&amp;_encoding=UTF8&amp;shipmentId=${s.shipmentId}&amp;ref=ab_ppx_yo_dt_b_vps" class="a-button-text">Lieferschein</a></span></span>
      <span class="a-button a-spacing-mini a-button-base"><span class="a-button-inner"><a href="/progress-tracker/package?orderId=${orderId}&amp;_encoding=UTF8&amp;shipmentId=${s.shipmentId}&amp;packageIndex=${s.packageIndex}&amp;vt=NOTIFICATIONS&amp;ref=ab_ppx_yo_dt_b_track_package" class="a-button-text">Lieferung verfolgen</a></span></span>
    </div></div>${s.itemsAfterLink ? items : ""}
  </div>
</div></div>`;
  }).join("");
  return `
<div id="orderCard" class="a-box-group a-spacing-top-base">
  <input type="hidden" name="aggregatedFields" value="{&quot;orderId&quot;:&quot;${orderId}&quot;,&quot;shipToFullName&quot;:&quot;Erika Musterfrau&quot;,&quot;placedByGroup&quot;:&quot;Beispiel GmbH&quot;}">
  <div id="orderCardHeader" class="a-box _cDEzb_your-orders-box-styling_0aaaa"><div class="a-box-inner"><div class="a-row">
    <div class="a-column a-span2"><div class="a-row a-color-secondary">Bestellung aufgegeben</div><div class="a-row a-size-base">25. September 2026</div></div>
    <div class="a-column a-span4 a-text-right a-span-last"><ul class="a-unordered-list a-nostyle a-vertical">
      <li id="orderIdField"><span class="a-list-item"><div class="a-row"><span id="orderIdLabel" class="a-color-secondary">Bestellnr.</span> <span dir="auto">${orderId}</span></div></span></li>
      <li><span class="a-list-item"><a class="a-link-normal" href="/your-orders/order-details?orderID=${orderId}&amp;ref=ab_ppx_yo_dt_b_fed_order_details">Bestelldetails anzeigen</a></span></li>
    </ul></div>
  </div></div></div>
  ${boxes}
</div>`;
}

function businessItem({ title, image = DEFAULT_IMAGE, imageAttrs }) {
  const attrs = imageAttrs ? Object.entries(imageAttrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("") : ` src="${esc(image)}"`;
  const img = image === null && !imageAttrs ? "" : `<img alt=""${attrs} class="itemImageSource">`;
  return `
      <div id="itemDetail" class="a-row itemDetails">
        <div class="a-column a-span2 imageContainer"><a class="a-link-normal itemImage" href="/dp/B000000000?ref=fed_asin_title">${img}</a></div>
        <div class="a-column a-span10 a-span-last">
          <div class="a-row"><a class="a-link-normal" href="/dp/B000000000?ref=fed_asin_title">${esc(title)}</a></div>
          <!-- New DeviceEnrollmentStatus section -->
          <div class="a-row"><span class="a-size-base a-color-price">12,34 €</span></div>
          <div class="a-row"><span class="a-button a-button-primary a-button-small"><span class="a-button-inner"><a href="/gp/buyagain?ats=example&amp;ref=bia_item_f" class="a-button-text">Erneut kaufen</a></span></span></div>
        </div>
      </div>`;
}

const PENDING_CARD = `
<div class="a-box-group a-spacing-top-base"><div class="a-box orderCardHeaderSkeleton"><div class="a-box-inner"></div></div>
<div class="a-box"><div class="a-box-inner"><div class="orderCardItemImageSkeleton"></div></div></div></div>`;

export function businessHistoryPage(orders, { footer = "", pending = 0 } = {}) {
  return `${head("Meine Bestellungen")}<body>${NAV}
<div id="yourOrderPageTitle" class="a-column a-span5"><h1>Meine Bestellungen</h1></div>
<div id="yourOrderTabFilter" class="a-row"><div class="a-search a-span7"><input type="search" id="abYoSearchBar" placeholder="Artikel-, Bestell- oder Auftragsnummer"></div></div>
<div id="yourOrderHistorySection" class="a-row a-spacing-medium a-spacing-top-small"><div id="yourOrderInfoSection" class="a-section">
${orders.map(businessOrderCard).join("\n")}${PENDING_CARD.repeat(pending)}
</div></div>${footer}</body></html>`;
}

// An order search that found nothing (#75), not in the history's markup:
// the personal layout keeps its search header (`#searchOrdersInput`) above a
// "no results" line, the Business layout its `#abYoSearchBar`. The live
// pages were not recorded; these follow the history pages' own headers.
export function searchNoResultsPage(query) {
  return `${head("Meine Bestellungen")}<body>${NAV}
<div class="a-section your-orders-search">
<form method="get" action="/your-orders/search/ref=ppx_yo2ov_dt_b_search" class="a-spacing-none">
<div class="a-search a-span12" aria-label="Alle Bestellungen durchsuchen"><input type="search" id="searchOrdersInput" value="${esc(query)}" name="search" class="a-input-text a-span12"></div></form>
<div class="a-row a-spacing-top-medium"><h2>Suchergebnisse</h2><p>Es wurden keine Bestellungen gefunden, die „${esc(query)}“ entsprechen.</p></div>
</div>${RECOMMENDATIONS}</body></html>`;
}

export function businessSearchNoResultsPage(query) {
  return `${head("Meine Bestellungen")}<body>${NAV}
<div id="yourOrderPageTitle" class="a-column a-span5"><h1>Meine Bestellungen</h1></div>
<div id="yourOrderTabFilter" class="a-row"><div class="a-search a-span7"><input type="search" id="abYoSearchBar" value="${esc(query)}" placeholder="Artikel-, Bestell- oder Auftragsnummer"></div></div>
<div id="yourOrderSearchResults" class="a-section"><div class="a-box a-alert-info"><div class="a-box-inner">Keine Ergebnisse für „${esc(query)}“</div></div></div>
</body></html>`;
}

// An order search answered in the newer "hzsearch" layout (#84), in the
// shape of a scrubbed live page: not the history's markup at all. The page
// has `.hzsearch-content-container` with breadcrumbs, a "Suchergebnisse"
// heading and its own search form (`action="/your-orders/search"`), a
// `.hzsearch-results-summary` line, then one `.a-fixed-left-grid` per
// result: the item image (in no `.product-image`), the order-details link,
// the item's `/dp/…` link and buttons. A delivered Order had no tracker
// link; a result's `tracker` ({ packageIndex, shipmentId }) adds a
// "Lieferung verfolgen" button, a guess at the live markup.
// `results`: [{ orderId, title, image, tracker }].
function hzsearchResult({ orderId, title, image = DEFAULT_IMAGE, tracker }, i) {
  const n = i + 1;
  const trackerButton = tracker ? `<span class="a-button a-button-base"><span class="a-button-inner"><a href="/progress-tracker/package?orderId=${orderId}&amp;_encoding=UTF8&amp;shipmentId=${tracker.shipmentId}&amp;packageIndex=${tracker.packageIndex}&amp;ref_=ppx_hzsearch_conn_dt_b_track_package_${n}" class="a-button-text">Lieferung verfolgen</a></span></span>` : "";
  return `<div class="a-section a-spacing-large a-spacing-top-large"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner" style="padding-left:100px">
<div class="a-text-center a-fixed-left-grid-col a-col-left" style="width:100px;margin-left:-100px;float:left;"><div style="position: relative"><a class="a-link-normal" href="/dp/B000000000?ref_=ppx_hzsearch_conn_dt_b_fed_asin_title_${n}"><img alt="${esc(title)}" src="${esc(image)}" height="90" width="90" title="${esc(title)}" data-a-hires="${esc(String(image).replace(/\._[^/]*_\.jpg$/, "._SS160_.jpg"))}"></a></div></div>
<div class="a-fixed-left-grid-col a-col-right" style="padding-left:1.5%;float:left;">
<div class="a-row a-spacing-small"><a class="a-link-normal" title="Bestelldetails anzeigen" href="/your-orders/order-details?orderID=${orderId}&amp;ref_=ppx_hzsearch_conn_dt_b_fed_order_details_${n}"><span>Bestelldetails anzeigen</span></a><i class="a-icon a-icon-text-separator" role="presentation"></i><span>Bestellt am 30. August 2026</span></div>
<div class="a-row a-spacing-small"><div class="a-section a-spacing-none"><a class="a-link-normal" title="${esc(title)}" href="/dp/B000000000?ref_=ppx_hzsearch_conn_dt_b_fed_asin_title_${n}"><p>${esc(title)}</p></a></div></div>
<div class="a-row"><div class="a-section a-spacing-none"><span class="a-button a-button-primary"><span class="a-button-inner"><a href="/gp/buyagain?ats=example&amp;ref_=ppx_hzsearch_conn_dt_b_bia_item_f_${n}" class="a-button-text">Nochmals kaufen</a></span></span><span class="a-button a-button-base"><span class="a-button-inner"><a href="/your-orders/pop?orderId=${orderId}&amp;lineItemId=example&amp;shipmentId=${tracker?.shipmentId ?? "Tzzzzzzzz"}&amp;packageId=1&amp;asin=B000000000&amp;ref_=ppx_hzsearch_conn_dt_b_fed_pop_${n}" class="a-button-text">Deinen Artikel anzeigen</a></span></span>${trackerButton}</div></div>
</div></div></div></div>`;
}

export function hzsearchResultsPage(query, results = []) {
  const summary = results.length === 1 ? "1 Bestellung, die" : `${results.length} Bestellungen, die`;
  return `${head("Meine Bestellungen")}<body>${NAV}
<div class="a-section a-spacing-large hzsearch-content-container" role="main">
<div class="a-section a-spacing-medium a-spacing-top-small"><ul class="a-unordered-list a-horizontal hzsearch-breadcrumbs"><li class="hzsearch-breadcrumbs__crumb"><span class="a-list-item"><a class="a-link-normal" title="Mein Konto" href="/gp/css/homepage.html?ref_=ppx_hzsearch_bc_dt_b_ya">Mein Konto</a></span></li><li class="hzsearch-breadcrumbs__crumb"><span class="a-list-item"><a class="a-link-normal" title="Meine Bestellungen" href="/gp/your-account/order-history?ref_=ppx_hzsearch_bc_dt_b_yo">Meine Bestellungen</a></span></li><li class="hzsearch-breadcrumbs__crumb hzsearch-breadcrumbs__crumb--current"><span class="a-list-item"><span class="a-color-state">Suchergebnisse</span></span></li></ul></div>
<div class="a-row a-spacing-mini"><div class="a-column a-span6"><div class="a-section a-spacing-none"><h1>Suchergebnisse</h1></div></div>
<div class="a-column a-span6 a-span-last"><div class="search-bar"><form method="get" action="/your-orders/search"><div class="a-search a-span12 a-spacing-none"><input type="search" value="${esc(query)}" placeholder="Alle Bestellungen durchsuchen" name="search" class="a-input-text a-span12 hzsearch-text-input" aria-label="Alle Bestellungen durchsuchen"></div><input type="hidden" name="ref_" value="ppx_hzsearch_sb_dt_b"></form></div></div></div>
<div class="a-section a-spacing-small"><p data-searchterm="${esc(query)}" aria-level="2" class="hzsearch-results-summary" role="heading">${summary} mit „<strong>${esc(query)}</strong>“ übereinstimm${results.length === 1 ? "t" : "en"}</p></div>
<div class="a-section a-spacing-none a-padding-small">${results.map(hzsearchResult).join("")}</div>
</div>${RECOMMENDATIONS}</body></html>`;
}

// A page at the order search's URL that is neither the history's markup nor
// a recognisable empty search: a layout nobody knows yet.
export const unknownSearchPage = () => `${head("Amazon.de")}<body>${NAV}<div id="a-page"><div class="new-orders-app" data-app="orders"></div></div></body></html>`;

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
