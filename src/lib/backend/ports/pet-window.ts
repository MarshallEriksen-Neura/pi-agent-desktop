import type { CustomPetEntry, PetConfigUpdate, PetStateUpdate } from "../../pet/types";

export interface PetWindowPort {
  show(): Promise<void>;
  hide(): Promise<void>;
  toggle(): Promise<boolean>;
  setPosition(x: number, y: number): Promise<void>;
  listCustomPets(): Promise<CustomPetEntry[]>;
  onStateUpdate(handler: (update: PetStateUpdate) => void): Promise<() => void>;
  onConfigUpdate(handler: (update: PetConfigUpdate) => void): Promise<() => void>;
  onWindowReady(handler: () => void): Promise<() => void>;
  onRestoreMain(handler: () => void): Promise<() => void>;
  emitStateUpdate(update: PetStateUpdate): Promise<void>;
  emitConfigUpdate(update: PetConfigUpdate): Promise<void>;
  emitWindowReady(): Promise<void>;
  emitRestoreMain(): Promise<void>;
}
