// my.dpd.de's anonymous tracking page (`myparcels/myParcel-tracking.aspx`),
// rebuilt synthetically: only the element ids documented on #83 (the
// server-rendered ASP.NET labels the parser reads) around filler markup. No
// real number, sender, name or address; the step wording is DPD's own.
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const P = "ContentPlaceHolder1_";

// The five steps of the parcel ladder, in page order, with DPD's wording.
export const STEPS = [
  ["Start", "Paketinfo an DPD übergeben"],
  ["OnTheRoad", "Paket unterwegs"],
  ["DeliveryDepot", "Paket im Paketzustellzentrum"],
  ["CarLoad", "Paket in Zustellung"],
  ["Delivered", "Paket zugestellt"],
];

// `status`: the delivery status line ("In Zustellung - 29.09.2026"), or null
// for none; `image`: the status picture's number (1–5), or null; `dates`:
// { <step>: "DD.MM." } for the steps reached; `labels`: other step wording.
export function trackingPage({ status = null, image = null, dates = {}, labels = {} } = {}) {
  const steps = STEPS.map(([id, text]) => `
      <div class="parcelStatusStep">
        <span id="${P}labStatus${id}">${esc(labels[id] ?? text)}</span>
        <span id="${P}labStatus${id}Date" class="statusDate">${esc(dates[id] ?? "")}</span>
      </div>`).join("");
  return `<!DOCTYPE html>
<html><head><title>myDPD - Paketverfolgung</title></head>
<body><form method="post" action="./myParcel-tracking.aspx" id="form1">
  <div class="aspNetHidden"><input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="c3ludGhldGlj" /></div>
  <div id="${P}repParcelList_parcelItem_0" class="parcelItem">
    <span id="${P}repParcelList_labDeliveryStatus_0" class="deliveryStatus">${esc(status ?? "")}</span>
  </div>
  <div class="parcelStatus">
    ${image ? `<img id="${P}imgParcelStatus" src="images/status_${image}.svg" alt="" />` : ""}
    ${steps}
  </div>
  <p>Für Details zur Zustellung geben Sie bitte Ihre Postleitzahl ein.</p>
</form></body></html>`;
}

// The page DPD shows without a session (or for a broken one).
export const errorPage = () => "<!DOCTYPE html><html><head><title>myDPD - Fehler</title></head><body><p>Leider ist ein Fehler aufgetreten.</p></body></html>";

// A 200 page that isn't the tracking page any more (a changed layout).
export const changedPage = () => "<!DOCTYPE html><html><head><title>myDPD</title></head><body><div id=\"app\"></div></body></html>";
