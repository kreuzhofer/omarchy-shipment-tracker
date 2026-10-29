// Loopback DevTools ports for the Chromes the tracker starts, in one place so
// no two of them ever share one: the DHL login window has a fixed port, each
// Amazon account gets its own from a range that starts above it.
export const DHL_LOGIN_PORT = 9340;
export const AMAZON_PORT_BASE = 9350;

// The lowest free Amazon port, never one in `taken` or the DHL login's.
export function nextAmazonPort(taken) {
  let port = AMAZON_PORT_BASE;
  while (taken.has(port) || port === DHL_LOGIN_PORT) port++;
  return port;
}
