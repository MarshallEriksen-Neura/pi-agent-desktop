import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePackageSource,
  packageInstallArgs,
  packageInstallRequest,
} from "@/lib/pi/package-install";
import {
  packageSourceInfo,
  packageUpdateAllRequest,
  packageUpdateRequest,
} from "@/lib/pi/package-update";
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

test("package update requests use official argv and cwd semantics", () => {
  assert.deepEqual(packageUpdateRequest("npm:pkg", "C:\\workspace"), {
    args: ["update", "npm:pkg"],
    cwd: "C:\\workspace",
  });
  assert.deepEqual(packageUpdateRequest("npm:pkg", null), {
    args: ["update", "npm:pkg"],
    cwd: null,
  });
  assert.deepEqual(packageUpdateAllRequest("/workspace"), {
    args: ["update", "--extensions"],
    cwd: "/workspace",
  });
  assert.equal(packageUpdateRequest("--all", null), null);
  assert.equal(packageUpdateRequest("npm:pkg\n--all", null), null);
});

test("packageSourceInfo distinguishes updateable, pinned, and local sources", () => {
  assert.deepEqual(packageSourceInfo("npm:@scope/pkg@1.2.3"), {
    kind: "npm",
    name: "@scope/pkg",
    identity: "npm:@scope/pkg",
    version: "1.2.3",
    updateMode: "npm-pinned",
  });
  assert.equal(packageSourceInfo("npm:pkg@next").updateMode, "update");
  assert.equal(packageSourceInfo("npm:pkg@^2.0.0").updateMode, "update");
  assert.deepEqual(packageSourceInfo("git:github.com/user/repo@v1"), {
    kind: "git",
    name: "github.com/user/repo",
    identity: "git:github.com/user/repo",
    ref: "v1",
    updateMode: "git-pinned",
  });
  assert.equal(packageSourceInfo("./package").updateMode, "local");
});

test("packageSourceInfo normalizes git identity without treating SSH users as refs", () => {
  const https = packageSourceInfo("https://github.com/user/repo.git");
  const ssh = packageSourceInfo("ssh://git@github.com/user/repo.git");
  const scp = packageSourceInfo("git:git@github.com:user/repo.git@feature/test");
  assert.equal(https.identity, "git:github.com/user/repo");
  assert.equal(ssh.identity, https.identity);
  assert.equal(ssh.ref, undefined);
  assert.equal(scp.identity, https.identity);
  assert.equal(scp.ref, "feature/test");
});

test("package identity exposes duplicate npm and git installations across scopes", () => {
  assert.equal(
    packageSourceInfo("npm:pkg").identity,
    packageSourceInfo("npm:pkg@1.2.3").identity
  );
  assert.equal(
    packageSourceInfo("git:github.com/user/repo@main").identity,
    packageSourceInfo("https://github.com/user/repo@v2").identity
  );
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
