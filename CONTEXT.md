# Shipment Tracker

An Omarchy bar widget that keeps a list of the user's recent parcels, incoming and outgoing, and their delivery progress.

## Language

### Parcels

**Shipment**:
One physical parcel with one tracking identity, moving in one Direction. The unit shown as a single row in the list.
_Avoid_: Delivery, item, package, parcel (in code and UI copy)

**Direction**:
Whether a Shipment is coming to the user (**Incoming**) or sent by the user (**Outgoing**).
_Avoid_: Inbound/outbound, sent/received

**Order**:
An Amazon purchase that produces one or more Shipments. Groups Shipments; never shown as a row itself.
_Avoid_: Purchase

### Where a Shipment comes from

**Source**:
The service through which the user learned of a Shipment and whose detail page it links to (Amazon or DHL).
_Avoid_: Provider, origin

**Carrier**:
The company physically moving the Shipment. May differ from the Source, e.g. an Amazon Shipment carried by DHL.
_Avoid_: Provider, courier

### Progress

**Status**:
Where a Shipment currently is in its journey, e.g. in transit, out for delivery, Ready for pickup, Delivered, Returned.
_Avoid_: State, stage

**Ready for pickup**:
The Shipment waits at a Packstation or branch for the user to collect it. Not terminal: it stays prominent until collected.

**Terminal Status**:
A Status after which a Shipment no longer changes: **Delivered** (received by the recipient, for either Direction) or **Returned** (back with the sender).
_Avoid_: Fulfilled, completed, done
