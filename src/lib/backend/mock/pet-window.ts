import type { PetWindowPort } from "../ports/pet-window";

const noop = async () => undefined;

export const mockPetWindowPort = {
  prewarm: noop,
  show: noop,
  hide: noop,
  toggle: async () => false,
  setPosition: noop,
  listCustomPets: async () => [],
  onStateUpdate: async () => () => undefined,
  onConfigUpdate: async () => () => undefined,
  onWindowReady: async () => () => undefined,
  onRestoreMain: async () => () => undefined,
  emitStateUpdate: noop,
  emitConfigUpdate: noop,
  emitWindowReady: noop,
  emitRestoreMain: noop,
} satisfies PetWindowPort;
