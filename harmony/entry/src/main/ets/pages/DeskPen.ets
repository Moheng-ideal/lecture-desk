import { stylusInteraction } from '@kit.Penkit';

export function subscribePenDoubleTap(openTools: () => void): () => void {
  const receiver = (_: stylusInteraction.DoubleTapEvent): void => {
    openTools();
  };
  stylusInteraction.on('doubleTap', receiver);
  return (): void => stylusInteraction.off('doubleTap', receiver);
}
