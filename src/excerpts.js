export const MAX_REFERENCES = 8;
export const IMAGE_LIMIT = 310000;
export const CHAT_BUDGET = 3500000;

export const isExcerptImage = (value) => typeof value === 'string' &&
  value.length <= IMAGE_LIMIT && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value);

export function currentReferences(references, bookId, titles) {
  return references.map((ref) => {
    const title = titles.get(ref.bookId ?? bookId);
    return title && ref.book !== title ? { ...ref, book: title } : ref;
  });
}
