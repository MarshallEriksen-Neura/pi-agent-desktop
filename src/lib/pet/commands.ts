import { getPort } from "@/lib/backend/composition/container";

export async function showPetWindow(): Promise<void> {
  await getPort("petWindow").show();
}

export async function hidePetWindow(): Promise<void> {
  await getPort("petWindow").hide();
}

export async function togglePetWindow(): Promise<boolean> {
  return await getPort("petWindow").toggle();
}

export async function setPetWindowPosition(
  x: number,
  y: number
): Promise<void> {
  await getPort("petWindow").setPosition(x, y);
}
