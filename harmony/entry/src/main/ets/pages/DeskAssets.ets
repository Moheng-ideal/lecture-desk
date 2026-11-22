import { webview, WebNetErrorList } from '@kit.ArkWeb';
import { resourceManager } from '@kit.LocalizationKit';

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

function respond(handler: webview.WebResourceHandler, url: string, status: number,
  mime: string, data: ArrayBuffer, head: boolean): void {
  const response = new webview.WebSchemeHandlerResponse();
  response.setUrl(url);
  response.setNetErrorCode(WebNetErrorList.NET_OK);
  response.setStatus(status);
  response.setStatusText(status === 200 ? 'OK' : 'Not Found');
  response.setMimeType(mime);
  if (mime.startsWith('text/') || mime === 'application/javascript' || mime.endsWith('json')) {
    response.setEncoding('UTF-8');
  }
  response.setHeaderByName('Content-Length', data.byteLength.toString(), false);
  response.setHeaderByName('Cache-Control', 'no-store', false);
  response.setHeaderByName('X-Content-Type-Options', 'nosniff', false);
  handler.didReceiveResponse(response);
  if (!head && data.byteLength) handler.didReceiveResponseBody(data);
  handler.didFinish();
}

export function interceptDeskAssets(handler: webview.WebSchemeHandler, manager: resourceManager.ResourceManager): void {
  handler.onRequestStart((request: webview.WebSchemeHandlerRequest, output: webview.WebResourceHandler): boolean => {
    const url = request.getRequestUrl();
    const method = request.getMethod();
    const path = url.startsWith(APP_ORIGIN + '/') ? resourcePath(url) : '';
    let bytes: Uint8Array | undefined;
    if (path && (method === 'GET' || method === 'HEAD')) {
      try { bytes = manager.getRawFileContentSync(path); } catch { /* Serve a local 404. */ }
    }
    try {
      if (bytes) {
        const extension = path.split('.').pop() || '';
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        respond(output, url, 200, mimeTypes.get(extension) || 'application/octet-stream', buffer, method === 'HEAD');
      } else {
        respond(output, url, 404, 'text/plain', new ArrayBuffer(0), true);
      }
    } catch { /* ArkWeb already cancelled this request. */ }
    return true;
  });
}
