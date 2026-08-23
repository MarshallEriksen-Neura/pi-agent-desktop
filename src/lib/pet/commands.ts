import { getPort } from "@/lib/backend/composition/container";
import { usePet } from "./store";
import { savePetPreferences } from "./persistence";

/**
 * Keep the store and the persisted prefs in step with the real window state.
 * Without this, `windowVisible` never moved off its default — so the reveal path
 * in bridge.ts could not tell "never shown yet" from "the user hid it", and
 * PetSettings' Show/Hide label was stuck.
 */
function recordVisibility(visible: boolean): void {
  usePet.getState().setWindowVisible(visible);
  savePetPreferences({ windowVisible: visible });
}

export async function prewarmPetWindow(): Promise<void> {
  await getPort("petWindow").prewarm();
}

export async function showPetWindow(): Promise<void> {
  await getPort("petWindow").show();
  recordVisibility(true);
}

export async function hidePetWindow(): Promise<void> {
  await getPort("petWindow").hide();
  recordVisibility(false);
}

export async function togglePetWindow(): Promise<boolean> {
  const visible = await getPort("petWindow").toggle();
  recordVisibility(visible);
  return visible;
}

export async function setPetWindowPosition(
  x: number,
  y: number
): Promise<void> {
  await getPort("petWindow").setPosition(x, y);
}
