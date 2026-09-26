/**
 * The back gesture's destination.
 *
 * Autora is installed from a host with a port on it (the tailscale bridge, or
 * Umbrel's tile), and the dashboard it was opened from is the same host
 * without that port. Get this wrong and back either stays put or leaves the
 * person somewhere that is not Umbrel at all, which is worse than the tab
 * they came from.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { umbrelHome } from "../src/lib/back";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

test("the tailscale bridge's :8443 leads to the dashboard", () => {
  assert.equal(umbrelHome("https://umbrel-1.tail16900.ts.net:8443/"), "https://umbrel-1.tail16900.ts.net/");
});

test("the tile's :8817 leads to the dashboard, keeping the scheme", () => {
  assert.equal(umbrelHome("http://umbrel.local:8817/"), "http://umbrel.local/");
});

test("a page inside the app leads to the dashboard, not to that page", () => {
  assert.equal(
    umbrelHome("https://umbrel-1.tail16900.ts.net:8443/?page=config&tab=keys#top"),
    "https://umbrel-1.tail16900.ts.net/",
  );
});

test("a page with no port above it has nowhere to go", () => {
  assert.equal(umbrelHome("https://autora.example.com/"), null);
  assert.equal(umbrelHome("http://localhost:3000/"), "http://localhost/");
});

test("nonsense is not a destination", () => {
  assert.equal(umbrelHome("not a url"), null);
});

console.log(`\n${passed} passed`);
