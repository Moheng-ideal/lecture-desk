export const APP_ORIGIN: string = 'https://lecture-desk.invalid';

function resourcePath(url: string): string {
  const pathname = url.slice(APP_ORIGIN.length + 1).split(/[?#]/)[0];
  if (!pathname) return 'desk/index.html';
  if (!/^[A-Za-z0-9._/-]+$/.test(pathname) ||
      pathname.split('/').some((part: string) => !part || part === '..' || part === '.')) return '';
  return 'desk/' + pathname;
}

const mimeTypes: Map<string, string> = new Map([
  ['html', 'text/html'], ['mjs', 'application/javascript'], ['js', 'application/javascript'], ['css', 'text/css'],
  ['json', 'application/json'], ['webmanifest', 'application/manifest+json'], ['png', 'image/png'], ['svg', 'image/svg+xml'],
  ['woff2', 'font/woff2'], ['woff', 'font/woff'], ['ttf', 'font/ttf'], ['pdf', 'application/pdf'],
  ['wasm', 'application/wasm'], ['gz', 'application/gzip'],
]);

export function deskAssetResponse(request: WebResourceRequest): WebResourceResponse | null {
  const url = request.getRequestUrl();
  if (!url.startsWith(APP_ORIGIN + '/')) return null;

  const path = resourcePath(url);
  const method = request.getRequestMethod();
  const allowed = path !== '' && (method === 'GET' || method === 'HEAD');
  const mime = mimeTypes.get(path.split('.').pop() || '') ?? 'application/octet-stream';
  const response = new WebResourceResponse();
  response.setResponseCode(allowed ? 200 : 404);
  response.setReasonMessage(allowed ? 'OK' : 'Not Found');
  response.setResponseMimeType(allowed ? mime : 'text/plain');
  response.setResponseEncoding('UTF-8');
  response.setResponseHeader([
    { headerKey: 'X-Content-Type-Options', headerValue: 'nosniff' },
    { headerKey: 'Cache-Control', headerValue: 'no-store' },
  ]);
  response.setResponseData(allowed && method === 'GET' ? $rawfile(path) : '');
  response.setResponseIsReady(true);
  return response;
}
