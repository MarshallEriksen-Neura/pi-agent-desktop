import type {
  PiManagementPort,
  PiManagementPortFactory,
  PiManagementSnapshot,
} from "../ports";
import { piManagementTargetKey } from "../ports/pi-management";

const capabilities = [
  "pi-packages-read-v1",
  "pi-packages-mutate-v1",
  "pi-skills-read-v1",
  "pi-skills-mutate-v1",
] as const;

/** One shared in-memory document: factories must not reset preview mutations. */
export function createBrowserPiManagementFactory(): PiManagementPortFactory {
  let revision = 1;
  const source = `---\nname: frontend-design\ndescription: Distinctive visual design guidance.\n---\n\n# Frontend Design\n`;

  return (binding, projectRoot) => {
    const snapshot = (): PiManagementSnapshot => ({
      targetKey: piManagementTargetKey(binding, projectRoot),
      stateToken: `mock-${revision}`,
      globalSettings: {
        path: "~/.pi/agent/settings.json",
        exists: true,
        content: JSON.stringify({ packages: ["npm:@mariozechner/pi-ai"], skills: [] }, null, 2),
      },
      projectSettings: {
        path: "/mock/project/.pi/settings.json",
        exists: true,
        content: JSON.stringify({ packages: [], skills: [] }, null, 2),
      },
      packageLocks: { global: null, project: null },
      skills: [
        {
          name: "frontend-design",
          description: "Distinctive visual design guidance.",
          origin: "global",
          sourceRef: "mock:frontend-design",
        },
      ],
      unscannableSkills: [],
      skillLocks: {},
    });
    const port: PiManagementPort = {
      availability: async () => ({ capabilities: [...capabilities], launcherOutdated: false }),
      inspect: async () => snapshot(),
      readSkillSource: async (sourceRef) => {
        if (sourceRef !== "mock:frontend-design") throw new Error("Unknown mock skill");
        return source;
      },
      browseSkillSource: async () => [
        { name: "frontend-design", description: "Distinctive visual design guidance." },
      ],
      mutatePackage: async (request) => {
        if (request.expectedState !== snapshot().stateToken) throw new Error("PI management state changed");
        revision += 1;
        return { snapshot: snapshot(), code: 0, stdout: "mock package mutation", stderr: "" };
      },
      mutateSkill: async (request) => {
        if (request.expectedState !== snapshot().stateToken) throw new Error("PI management state changed");
        revision += 1;
        return { snapshot: snapshot(), code: 0, stdout: "mock skill mutation", stderr: "" };
      },
    };
    return port;
  };
}
