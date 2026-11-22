export const formats = {
  pdf: 'PDF', docx: 'Word', doc: 'Word', pptx: 'PPT', ppt: 'PPT',
};

const mimeExtensions = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function bookFormat(file) {
  const ext = file.name.match(/\.([a-z\d]+)$/i)?.[1].toLowerCase();
  if (ext && Object.hasOwn(formats, ext)) return ext;
  return Object.hasOwn(mimeExtensions, file.type) ? mimeExtensions[file.type] : null;
}
