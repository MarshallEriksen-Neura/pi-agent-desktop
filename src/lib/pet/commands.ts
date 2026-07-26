/**
 * Tauri commands for pet window management
 */

import { invoke } from "@tauri-apps/api/core";

export async function showPetWindow(): Promise<void> {
  await invoke("pet_window_show");
}

export async function hidePetWindow(): Promise<void> {
  await invoke("pet_window_hide");
}

export async function togglePetWindow(): Promise<boolean> {
  return await invoke<boolean>("pet_window_toggle");
}

export async function setPetWindowPosition(
  x: number,
  y: number
): Promise<void> {
  await invoke("pet_window_set_position", { x, y });
}
