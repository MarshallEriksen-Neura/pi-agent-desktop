/**
 * A port stub whose every method rejects.
 *
 * `BackendPorts` is checked structurally, so a test that builds a full fake has
 * to name every port — including ones it has nothing to do with. The tempting
 * shortcut is `as unknown as BackendPorts`, but that turns off the check that
 * makes these fakes worth writing: the container's job is to hand back the port
 * that was registered, and a cast lets a fake drift out of shape unnoticed.
 *
 * These stubs keep the check and stay honest about their emptiness. A stub that
 * answered plausibly — `list: async () => []` — would let a future test pass
 * against a fake that proves nothing about the real port.
 */
export function unreachablePort<T extends object>(portName: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const method = String(property);
      return async () => {
        throw new Error(
          `${portName}.${method}() was called on an unreachable-port stub. ` +
            `If a test needs this port, give it a real fake instead.`,
        );
      };
    },
  });
}
