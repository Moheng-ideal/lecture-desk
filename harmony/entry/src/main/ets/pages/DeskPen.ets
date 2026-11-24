import { stylusInteraction } from '@kit.Penkit';

export function subscribePenSqueeze(openTools: () => void): () => void {
  const receiver = (_: stylusInteraction.SqueezeEvent): void => {
    openTools();
  };
  stylusInteraction.on('squeeze', receiver);
  return (): void => stylusInteraction.off('squeeze', receiver);
}
