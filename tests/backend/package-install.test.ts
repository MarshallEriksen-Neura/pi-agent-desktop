import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePackageSource,
  packageInstallArgs,
  packageInstallRequest,
} from "@/lib/pi/package-install";
import { cliError } from "@/lib/pi/cli-error";

test("normalizePackageSource adds npm: to bare package specs", () => {
  assert.equal(normalizePackageSource(" pi-mcp-adapter "), "npm:pi-mcp-adapter");
  assert.equal(normalizePackageSource("@scope/pkg"), "npm:@scope/pkg");
  assert.equal(normalizePackageSource("@scope/pkg@1.2.3"), "npm:@scope/pkg@1.2.3");
});

test("normalizePackageSource preserves explicit and local package sources", () => {
  for (const source of [
    "npm:pi-mcp-adapter@2",
    "git:github.com/user/repo@v1",
    "https://github.com/user/repo",
    "ssh://git@github.com/user/repo",
    "git://github.com/user/repo",
    "./relative/package",
    "../shared/package",
    "~/dev/package",
    "/opt/pi/package",
    "C:\\dev\\pi-package",
    "\\\\server\\share\\pi-package",
  ]) {
    assert.equal(normalizePackageSource(source), source);
  }
  assert.equal(
    normalizePackageSource("git@github.com:user/repo.git"),
    "git:git@github.com:user/repo.git"
  );
  assert.equal(normalizePackageSource("NPM:@scope/pkg@next"), "npm:@scope/pkg@next");
  assert.equal(
    normalizePackageSource("GIT:github.com/user/repo@feature/test"),
    "git:github.com/user/repo@feature/test"
  );
});

test("normalizePackageSource rejects unsupported or option-like input", () => {
  for (const source of [
    "",
    "   ",
    "--help",
    "owner/repo",
    "package name",
    "foo\nbar",
    "./bad\tpath",
    "npm:",
    "git:",
    "npm:--help",
    "https://",
    "https://host/path with spaces",
  ]) {
    assert.equal(normalizePackageSource(source), null, source);
  }
});

test("packageInstallArgs selects the settings scope without changing the source", () => {
  assert.deepEqual(packageInstallArgs("npm:pkg", "global"), ["install", "npm:pkg"]);
  assert.deepEqual(packageInstallArgs("./pkg", "project"), ["install", "./pkg", "-l"]);
});

test("packageInstallRequest locks project argv and cwd", () => {
  assert.deepEqual(packageInstallRequest("npm:pkg", "project", "C:\\workspace"), {
    args: ["install", "npm:pkg", "-l"],
    cwd: "C:\\workspace",
  });
  assert.deepEqual(packageInstallRequest("npm:pkg", "global", "/workspace"), {
    args: ["install", "npm:pkg"],
    cwd: "/workspace",
  });
  assert.equal(packageInstallRequest("npm:pkg", "project", null), null);
  assert.equal(packageInstallRequest("./relative", "global", null), null);
  assert.deepEqual(packageInstallRequest("C:\\package dir", "global", null), {
    args: ["install", "C:\\package dir"],
    cwd: null,
  });
});

test("cliError prefers useful diagnostics and has a silent fallback", () => {
  assert.equal(
    cliError(
      {
        code: 1,
        stdout: "│  Could not find package\n└  Installation failed\n",
        stderr: "npm warn ignored configuration\n",
      },
      "exit 1"
    ),
    "Could not find package"
  );
  assert.equal(cliError({ code: 9, stdout: "", stderr: "" }, "exit 9"), "exit 9");
});
