// The Carriers the tracker looks up by number (DHL, and DPD since #83), as
// data: what a number's format says about its Carrier, the key and page of
// a Shipment it is the Source of, and the anonymous lookup that reads its
// Status. Everything that treats DHL and DPD alike goes through here.
import { lookupAnonymous, trackingPageUrl as dhlPage } from "./dhl/search.mjs";
import { readDhlElement } from "./dhl/status.mjs";
import { DPD_NUMBER, lookupDpd, trackingPageUrl as dpdPage } from "./dpd/search.mjs";
import { readDpdPage } from "./dpd/status.mjs";

const CARRIERS = {
  DHL: {
    key: "dhl",
    page: dhlPage,
    async lookUp(transport, trackingNumber) {
      const result = await lookupAnonymous(transport, trackingNumber);
      if (!result.ok) return result;
      const reading = readDhlElement(result.element);
      return reading ? { ok: true, reading } : { ok: false, reason: "shape" };
    },
  },
  DPD: {
    key: "dpd",
    page: dpdPage,
    async lookUp(transport, trackingNumber, now) {
      const result = await lookupDpd(transport, trackingNumber);
      if (!result.ok) return result;
      const reading = readDpdPage(result.html, now);
      return reading ? { ok: true, reading } : { ok: false, reason: "shape" };
    },
  },
};

// The Carriers that are also Sources of the Shipments they're looked up for.
export const NUMBER_CARRIERS = Object.keys(CARRIERS);
export const isNumberCarrier = (name) => Object.hasOwn(CARRIERS, name ?? "");

// What a number's format says: 14 digits are DPD's, anything else is DHL's
// (spec #21: "anything else → DHL").
export const carrierOfNumber = (trackingNumber) => (DPD_NUMBER.test(trackingNumber) ? "DPD" : "DHL");

// The key of the Shipment a Carrier is the Source of: "dhl:<n>", "dpd:<n>".
export const carrierKey = (carrier, trackingNumber) => `${CARRIERS[carrier].key}:${trackingNumber}`;
// Every key a tracking number could have as a Carrier's own Shipment.
export const carrierKeys = (trackingNumber) => NUMBER_CARRIERS.map((c) => carrierKey(c, trackingNumber));

export const trackingPageUrl = (carrier, trackingNumber) => CARRIERS[carrier].page(trackingNumber);

// One anonymous lookup: { ok: true, reading } (see dhl/status.mjs,
// dpd/status.mjs) or { ok: false, reason } ("network", "http", "shape", "rate-limited").
export const lookUpNumber = (transport, carrier, trackingNumber, now) => CARRIERS[carrier].lookUp(transport, trackingNumber, now);
