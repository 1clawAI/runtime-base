"use strict";
/**
 * PROMPTSSRF-L1. `read_url` rejected exactly three literal hostnames —
 * `localhost`, `127.0.0.1`, `0.0.0.0`. That is a spelling check, not an SSRF
 * guard: `127.1`, `[::1]`, any RFC1918 address and, most of all,
 * `169.254.169.254` (cloud instance metadata) all went through, as did any
 * DNS name resolving to one. Redirects were followed with no re-check.
 *
 * Run: node --test templates/shared/tools/__tests__/*.test.js
 */
const test = require("node:test");
const assert = require("node:assert");

const { isBlockedIP, assertPublicDestination, execute } = require("../file-handler.js");

test("blocks every private, loopback and link-local range", () => {
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "169.254.169.254", // cloud metadata — the one that matters most
    "0.0.0.0",
    "224.0.0.1", // multicast
    "::1",
    "::",
    "::ffff:127.0.0.1", // v4-mapped loopback
    "fd00::1", // unique-local
    "fe80::1", // link-local
  ]) {
    assert.strictEqual(isBlockedIP(ip), true, `${ip} must be blocked`);
  }
});

test("still allows ordinary public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.strictEqual(isBlockedIP(ip), false, `${ip} must be allowed`);
  }
});

test("anything that is not an IP at all fails closed", () => {
  for (const notIP of ["", "hello", "999.1.1.1", "1.2.3", "0x7f000001"]) {
    assert.strictEqual(isBlockedIP(notIP), true, `${notIP} must fail closed`);
  }
});

test("refuses the URL shapes the old literal check let through", async () => {
  for (const url of [
    "http://127.1/",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://[::1]:8082/v1/secrets",
    "http://10.0.0.5/admin",
    "http://0.0.0.0/",
    // The three it did catch must still be caught.
    "http://localhost:3000/",
    "http://127.0.0.1/",
  ]) {
    await assert.rejects(
      () => assertPublicDestination(url),
      undefined,
      `${url} must be refused`,
    );
  }
});

test("refuses non-http schemes", async () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://x/"]) {
    await assert.rejects(() => assertPublicDestination(url));
  }
});

test("a redirect is re-checked and hops are capped", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "file-handler.js"),
    "utf8",
  );
  const redirect = src.slice(src.indexOf("resp.headers.location"));
  const body = redirect.slice(0, redirect.indexOf("const chunks"));

  assert.ok(
    body.includes("assertPublicDestination"),
    "the redirect branch must re-check the new destination — a public URL " +
      "that bounces to 169.254.169.254 was previously followed without question",
  );
  assert.ok(
    body.includes("redirectsLeft"),
    "redirect hops must be capped",
  );
});

/**
 * The predicate tests above all pass with `read_url` reverted to its old
 * three-hostname check — verified by doing exactly that. A pure function
 * being correct says nothing about whether the caller consults it, so this
 * drives the real tool.
 */
test("read_url itself refuses the metadata endpoint and loopback", async () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.1/",
    "http://[::1]:8082/v1/secrets",
    "http://10.0.0.5/admin",
  ]) {
    const out = await execute("read_url", { url }, {});
    assert.ok(
      out && typeof out.error === "string",
      `read_url must refuse ${url}, got ${JSON.stringify(out)}`,
    );
    assert.ok(
      /private|loopback|not allowed|resolve/i.test(out.error),
      `the refusal for ${url} should say why, got ${out.error}`,
    );
  }
});
