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
Where a Shipment currently is in its journey. Exactly one of: **Announced**, **In transit**, **Out for delivery**, **Ready for pickup**, **Problem**, **Returning**, **Delivered**, **Returned**, or **Unknown**.
_Avoid_: State, stage

**Announced**:
The Shipment exists (label created or Order placed) but the Carrier has not moved it yet.
_Avoid_: Pending, ordered

**In transit**:
The Carrier is moving the Shipment towards the recipient.

**Out for delivery**:
The Shipment is on the delivery vehicle today.

**Ready for pickup**:
The Shipment waits at a Packstation, Locker or branch for the user to collect it. Not terminal: it stays prominent until collected.

**Problem**:
The Carrier reports something that needs attention, such as a failed delivery attempt, an address issue or damage. Not terminal.
_Avoid_: Exception, error

**Returning**:
The Shipment is on its way back to the sender. Not terminal.

**Unknown**:
The Source has no tracking information for the Shipment yet, e.g. a manually added number the Carrier does not know.

**Terminal Status**:
A Status after which a Shipment no longer changes: **Delivered** (received by the recipient, for either Direction) or **Returned** (back with the sender).
_Avoid_: Fulfilled, completed, done

**Estimate**:
The Carrier's or Amazon's current promise of when the Shipment will be delivered, as a day or a time window.
_Avoid_: ETA, delivery date

**Delayed**:
A Shipment whose Estimate moved later than the one previously seen. A flag on the Shipment, not a Status.
