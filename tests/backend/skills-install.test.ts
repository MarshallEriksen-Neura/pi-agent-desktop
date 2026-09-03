/**
 * Locks the two brittle contracts in the skills-install path: the argv we hand
 * `npx skills`, and the parse of its `--list` output.
 *
 * Both matter because the CLI has no machine-readable mode. `-a`/`-s` swallow
 * every following argument that does not start with `-`, so argument ORDER is
 * load-bearing; and `--list` prints clack-decorated, ANSI-laden text.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addArgs,
  cliError,
  listArgs,
  looksLikeSource,
  normalizeSource,
  parseLock,
  parseSkillList,
  rankHits,
  removeArgs,
  updateArgs,
} from "@/lib/pi/skills-install";

const CSI = `${String.fromCharCode(27)}[`;

/** Shaped after a real `skills add anthropics/skills --list` run. */
const LIST_OUTPUT = [
  `${CSI}?25l│`,
  `${CSI}1G${CSI}J◇  Cloning repository…`,
  `${CSI}1G${CSI}J◇  Found 3 skills`,
  `${CSI}?25h`,
  "│",
  "◇  Available Skills",
  "Document Skills",
  "│",
  "│    pdf",
  "│",
  "│      Read, merge, split and fill PDF files.",
  "│",
  "│    docx",
  "│",
  "│      Create and edit Word documents.",
  "",
  "General",
  "│",
  "│    frontend-design",
  "│",
  "│      Distinctive, intentional visual design guidance.",
  "",
  "└  Use --skill <name> to install specific skills",
].join("\n");

test("addArgs puts the source first and repeats --skill per skill", () => {
  assert.deepEqual(addArgs("anthropics/skills", ["pdf"], "global"), [
    "add",
    "anthropics/skills",
    "--skill",
    "pdf",
    "--agent",
    "pi",
    "-g",
    "--copy",
    "-y",
  ]);

  // Project scope is the CLI's default, so it carries no scope flag — the cwd
  // the command runs in is what selects `<root>/.pi/skills`.
  assert.deepEqual(addArgs("owner/repo", ["a", "b"], "project"), [
    "add",
    "owner/repo",
    "--skill",
    "a",
    "--skill",
    "b",
    "--agent",
    "pi",
    "--copy",
    "-y",
  ]);
});

test("no value-taking flag is followed by a bare word it could swallow", () => {
  for (const args of [
    addArgs("owner/repo", ["a", "b"], "global"),
    addArgs("owner/repo", ["a"], "project"),
    removeArgs("pdf", "global"),
    removeArgs("pdf", "project"),
  ]) {
    for (const flag of ["--agent", "--skill"]) {
      let i = args.indexOf(flag);
      while (i >= 0) {
        // exactly one value, then either the end or the next flag
        const after = args[i + 2];
        assert.ok(
          after === undefined || after.startsWith("-"),
          `${flag} at ${i} in [${args.join(" ")}] leaks "${after}" into its value list`
        );
        i = args.indexOf(flag, i + 1);
      }
    }
  }
});

test("remove/update/list argv", () => {
  assert.deepEqual(removeArgs("pdf", "global"), [
    "remove",
    "--skill",
    "pdf",
    "--agent",
    "pi",
    "-g",
    "-y",
  ]);
  assert.deepEqual(updateArgs("global"), ["update", "-g", "-y"]);
  assert.deepEqual(updateArgs("project"), ["update", "-p", "-y"]);
  assert.deepEqual(listArgs("./local-skills"), ["add", "./local-skills", "--list"]);
});

test("parseSkillList reads names and descriptions past the ANSI noise", () => {
  assert.deepEqual(parseSkillList(LIST_OUTPUT), [
    { name: "pdf", description: "Read, merge, split and fill PDF files." },
    { name: "docx", description: "Create and edit Word documents." },
    {
      name: "frontend-design",
      description: "Distinctive, intentional visual design guidance.",
    },
  ]);
});
test("parseSkillList retains markdown-style bullet compatibility", () => {
  assert.deepEqual(parseSkillList([
    "Available Skills",
    "- alpha: First skill.",
    "* beta",
  ].join("\n")), [
    { name: "alpha", description: "First skill." },
    { name: "beta", description: "" },
  ]);
});


test("parseSkillList ignores everything before the section header", () => {
  // "Cloning repository" and "Found 3 skills" are logged the same way as skills
  assert.deepEqual(parseSkillList(LIST_OUTPUT.split("◇  Available Skills")[0]), []);
  assert.deepEqual(parseSkillList(""), []);
});

test("parseLock reports the normalized source identity", () => {
  const lock = JSON.stringify({
    version: 3,
    skills: {
      // `source` is the identity the catalogue also reports, so it wins over
      // the raw remote — the two have to be comparable with a search hit.
      "find-skills": {
        source: "vercel-labs/skills",
        sourceUrl: "https://github.com/vercel-labs/skills.git",
      },
      // older entries carry only the remote, which gets reduced to owner/repo
      legacy: { sourceUrl: "git@github.com:owner/repo.git" },
      // the project lock omits sourceUrl when `source` is already installable
      local: { source: "./my-skills", sourceType: "local" },
      orphan: { sourceType: "local" },
    },
  });
  assert.deepEqual(parseLock(lock), {
    "find-skills": "vercel-labs/skills",
    legacy: "owner/repo",
    local: "./my-skills",
  });
});

test("normalizeSource reduces a remote to the identity the catalogue uses", () => {
  // every spelling of the same repo collapses to one value
  for (const spelling of [
    "nextlevelbuilder/ui-ux-pro-max-skill",
    "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
    "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git",
    "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/skills/x",
    "git@github.com:nextlevelbuilder/ui-ux-pro-max-skill.git",
  ]) {
    assert.equal(
      normalizeSource(spelling),
      "nextlevelbuilder/ui-ux-pro-max-skill",
      spelling
    );
  }
  assert.equal(
    normalizeSource("ssh://git@git.example.com/acme/private-skills.git"),
    "acme/private-skills"
  );
  // not remotes: a well-known domain and local paths survive untouched, or
  // `move` would try to re-install from a mangled path
  assert.equal(normalizeSource("smithery.ai"), "smithery.ai");
  assert.equal(normalizeSource("skills.volces.com"), "skills.volces.com");
  assert.equal(normalizeSource("./my-skills"), "./my-skills");
  assert.equal(normalizeSource("../shared/skills"), "../shared/skills");
  assert.equal(normalizeSource("D:/dev/skills/foo"), "D:/dev/skills/foo");
  // idempotent, so a hit's source can be normalized before comparing
  assert.equal(normalizeSource(normalizeSource("owner/repo")), "owner/repo");
});

test("parseLock treats a missing or corrupt lock as empty", () => {
  assert.deepEqual(parseLock(""), {});
  assert.deepEqual(parseLock("{ not json"), {});
  assert.deepEqual(parseLock("{}"), {});
});

/**
 * Verbatim from `skills add ui-ux-pro-max --list` — a skill name typed into the
 * source field. The reason is on stdout; stderr holds only npm's complaint about
 * a config key in the repo's .npmrc.
 */
const FAILED_CLONE = {
  code: 1,
  stdout: [
    "",
    "│",
    `●   claude-code_2-1-251_agent  Agent detected ${String.fromCharCode(0x2014)} installing non-interactively`,
    "│",
    "◇  Source: ui-ux-pro-max",
    "│",
    "◒  Cloning repository…◐  Cloning repository…│",
    "■  Failed to clone repository",
    "│",
    "│  Failed to clone ui-ux-pro-max: fatal: repository 'ui-ux-pro-max' does not exist",
    "│",
    "│",
    "│  Tip: use the --yes (-y) and --global (-g) flags to install without prompts.",
    "│",
    "└  Installation failed",
    "■  Canceled",
  ].join("\n"),
  stderr:
    'npm warn Unknown project config "verify-deps-before-run". This will stop working in the next major version of npm.\n',
};

test("cliError reports the CLI's reason, not npm's warning", () => {
  const message = cliError(FAILED_CLONE, "fallback");
  assert.match(message, /repository 'ui-ux-pro-max' does not exist/);
  assert.doesNotMatch(message, /npm warn/);
  // clack decoration, progress spinners and the generic outro all drop out
  assert.doesNotMatch(message, /[│■◇└]/);
  assert.doesNotMatch(message, /Cloning repository/);
  assert.doesNotMatch(message, /Installation failed|Canceled|Tip:/);
});

test("cliError falls back when both streams are silent", () => {
  assert.equal(cliError({ code: 7, stdout: "", stderr: "" }, "exit 7"), "exit 7");
  assert.equal(
    cliError({ code: 7, stdout: "", stderr: "npm warn nothing to see\n" }, "exit 7"),
    "exit 7"
  );
});

test("looksLikeSource tells a place to fetch from apart from a skill name", () => {
  // one field serves both, so this predicate decides search vs. clone
  assert.equal(looksLikeSource("ui-ux-pro-max"), false);
  assert.equal(looksLikeSource("pdf"), false);
  assert.equal(looksLikeSource("anthropics/skills"), true);
  assert.equal(looksLikeSource("https://github.com/owner/repo"), true);
  assert.equal(looksLikeSource("git@github.com:owner/repo.git"), true);
  assert.equal(looksLikeSource("./local-skills"), true);
  assert.equal(looksLikeSource("~/dev/skills"), true);
  assert.equal(looksLikeSource("D:\\skills"), true);
  // a well-known source is a bare domain, which the dot catches
  assert.equal(looksLikeSource("open.feishu.cn"), true);
});

/**
 * Real shape of a name query: nine repos publish a skill called
 * `ui-ux-pro-max`, and one of them also publishes higher-installed siblings.
 */
test("rankHits puts the name that was typed above better-installed siblings", () => {
  const hit = (name: string, source: string, installs: number) => ({
    id: `${source}/${name}`,
    skillId: name,
    name,
    source,
    installs,
  });
  const ranked = rankHits(
    [
      hit("ckm:design-system", "nextlevelbuilder/ui-ux-pro-max-skill", 32842),
      hit("ui-ux-pro-max", "kimny1143/claude-code-template", 4721),
      hit("ckm:design", "nextlevelbuilder/ui-ux-pro-max-skill", 32543),
      hit("ui-ux-pro-max", "nextlevelbuilder/ui-ux-pro-max-skill", 335428),
      hit("ui-ux-pro-max", "sickn33/agentic-awesome-skills", 3213),
    ],
    "ui-ux-pro-max"
  );
  assert.deepEqual(
    ranked.map((h) => `${h.name}@${h.installs}`),
    [
      "ui-ux-pro-max@335428",
      "ui-ux-pro-max@4721",
      "ui-ux-pro-max@3213",
      "ckm:design-system@32842",
      "ckm:design@32543",
    ]
  );
});
