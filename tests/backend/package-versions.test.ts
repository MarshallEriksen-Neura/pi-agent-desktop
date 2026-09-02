/**
 * The version data behind the plugin row's "Update" / "Up to date" state.
 *
 * These are the pieces that decide whether a package is claimed to be current,
 * so the interesting cases are the ones where the answer must be "don't know":
 * a corrupt lock, an unpublished package, a version string nobody can parse.
 * Every one of those has to keep the update button, never hide it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  fetchLatestVersions,
  isOutdated,
  npmLockPath,
  parseLockVersions,
} from "@/lib/pi/package-versions";

test("npmLockPath sits the lock beside the scope's settings.json", () => {
  assert.equal(
    npmLockPath("C:\\Users\\me\\.pi\\agent\\settings.json"),
    "C:/Users/me/.pi/agent/npm/package-lock.json"
  );
  assert.equal(
    npmLockPath("/home/me/.pi/agent/settings.json"),
    "/home/me/.pi/agent/npm/package-lock.json"
  );
  assert.equal(npmLockPath("/repo/.pi/settings.json"), "/repo/.pi/npm/package-lock.json");
});

test("npmLockPath refuses a path with no directory to hang the tree off", () => {
  // the store's pre-load placeholder, and anything else pathless
  assert.equal(npmLockPath(""), null);
  assert.equal(npmLockPath("settings.json"), null);
  assert.equal(npmLockPath("/settings.json"), null);
});

test("parseLockVersions reads resolved versions out of a v3 lock", () => {
  const raw = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "pi-extensions" },
      "node_modules/pi-slopchop": { version: "2.1.0" },
      "node_modules/@narumitw/pi-goal": { version: "0.54.4" },
    },
  });
  assert.deepEqual(
    [...parseLockVersions(raw)],
    [
      ["pi-slopchop", "2.1.0"],
      ["@narumitw/pi-goal", "0.54.4"],
    ]
  );
});

test("parseLockVersions ignores nested trees and versionless entries", () => {
  const raw = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/pi-goal": { version: "1.0.0" },
      // a hoisting conflict puts a second copy under the dependent — not the
      // install any settings entry refers to
      "node_modules/pi-goal/node_modules/pi-tui": { version: "0.1.0" },
      "node_modules/pi-linked": { resolved: "file:../local", link: true },
    },
  });
  assert.deepEqual([...parseLockVersions(raw)], [["pi-goal", "1.0.0"]]);
});

test("parseLockVersions falls back to a v1 lock's dependencies", () => {
  const raw = JSON.stringify({
    lockfileVersion: 1,
    dependencies: { "pi-skills": { version: "1.3.0" } },
  });
  assert.deepEqual([...parseLockVersions(raw)], [["pi-skills", "1.3.0"]]);
});

test("parseLockVersions treats an unreadable lock as no information", () => {
  // a half-written lock must degrade to "version unknown", not throw and take
  // the plugins page with it
  for (const raw of ["", "{", "null", "[]", '{"packages":null}', '"a string"']) {
    assert.deepEqual([...parseLockVersions(raw)], [], `for ${JSON.stringify(raw)}`);
  }
});

test("compareVersions orders release numbers, not their text", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1); // 10 > 9, "10" < "9"
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
});

test("compareVersions ranks a prerelease below its own release", () => {
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1.1"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
});

test("compareVersions gives up rather than guess", () => {
  assert.equal(compareVersions("latest", "1.0.0"), null);
  assert.equal(compareVersions("1.0.0", ""), null);
});

test("isOutdated only fires when the registry is provably ahead", () => {
  assert.equal(isOutdated("0.10.6", "0.11.0"), true);
  assert.equal(isOutdated("0.11.0", "0.11.0"), false);
  // a locally built prerelease ahead of the published release is not outdated
  assert.equal(isOutdated("1.1.0", "1.0.0"), false);
  // unparseable input must not read as "current" *or* "outdated" — the caller
  // keeps offering the update
  assert.equal(isOutdated("next", "1.0.0"), false);
});

test("fetchLatestVersions reports only the lookups that answered", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/missing-pkg")) {
      return new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify({ "dist-tags": { latest: "3.1.4" } }), { status: 200 });
  }) as typeof fetch;

  try {
    const latest = await fetchLatestVersions(["@scope/pkg", "missing-pkg"]);
    assert.deepEqual([...latest], [["@scope/pkg", "3.1.4"]]);
    // the slash in a scoped name has to survive as one path segment
    assert.ok(
      calls.some((href) => href.endsWith("/@scope%2Fpkg")),
      `scoped name was not encoded: ${calls.join(", ")}`
    );
  } finally {
    globalThis.fetch = original;
  }
});
