// Strict mode's network lock, enforced by Chrome itself rather than over CDP.
//
// A strict browser gets a proxy that goes nowhere (port 0 can't be connected
// to), with the allowed origins on the bypass list. Anything else fails in
// Chrome's network stack: fetch, XHR, beacons, workers, WebSockets, QUIC. It
// holds with no CDP client attached, so a detached browser stays locked, and
// hostnames outside the list are never even resolved (the proxy would do that).
//
// Findings that shaped the flags (Chrome 154, see test/integration):
// - <-loopback> must come first, or it overrides the rules before it.
// - Rules are host:port without a scheme: "http://host:port" doesn't match
//   ws:// to the same origin. So at this layer http and https on one port are
//   the same; the CDP guard still tells them apart for navigations.
// - --webrtc-ip-handling-policy stops non-proxied UDP; the "force-" variant
//   of the flag does nothing.

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

function bypassRule(pattern) {
  const wildcard = /^(https?:)\/\/\*\.(.+)$/.exec(pattern);
  if (wildcard) {
    const url = new URL(`${wildcard[1]}//${wildcard[2]}`);
    return `*.${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol]}`;
  }
  const url = new URL(pattern);
  return `${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol]}`;
}

/** Chrome flags that confine all network traffic to the allowlist. */
export function lockdownArgs(allowlist) {
  const rules = [...new Set(allowlist.map(bypassRule))];
  return [
    '--proxy-server=http://127.0.0.1:0',
    `--proxy-bypass-list=<-loopback>;${rules.join(';')}`,
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
  ];
}
