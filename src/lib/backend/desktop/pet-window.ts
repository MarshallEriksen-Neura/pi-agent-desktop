import { emit, listen } from "@tauri-apps/api/event";
import { desktopInvoke } from "./invoke";
import type { PetWindowPort } from "../ports/pet-window";
import type { CustomPetEntry, PetConfigUpdate, PetStateUpdate } from "../../pet/types";

export const desktopPetWindowPort = {
  prewarm: () => desktopInvoke<void>("pet_window_prewarm"),
  show: () => desktopInvoke<void>("pet_window_show"),
  hide: () => desktopInvoke<void>("pet_window_hide"),
  toggle: () => desktopInvoke<boolean>("pet_window_toggle"),
  setPosition: (x, y) => desktopInvoke<void>("pet_window_set_position", { x, y }),
  listCustomPets: () => desktopInvoke<CustomPetEntry[]>("list_custom_pets"),
  onStateUpdate: async (handler) =>
    listen<PetStateUpdate>("pet-state-update", (event) => handler(event.payload)),
  onConfigUpdate: async (handler) =>
    listen<PetConfigUpdate>("pet-config-update", (event) => handler(event.payload)),
  onWindowReady: async (handler) => listen("pet-window-ready", () => handler()),
  onRestoreMain: async (handler) => listen("pet-restore-main", () => handler()),
  emitStateUpdate: (update) => emit("pet-state-update", update),
  emitConfigUpdate: (update) => emit("pet-config-update", update),
  emitWindowReady: () => emit("pet-window-ready", {}),
  emitRestoreMain: () => emit("pet-restore-main", {}),
} satisfies PetWindowPort;
