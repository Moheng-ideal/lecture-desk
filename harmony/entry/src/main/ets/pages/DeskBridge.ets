import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { util } from '@kit.ArkTS';
import { fileIo, picker } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { DeskSpeech } from './DeskSpeech';

class BridgeEvent {
  id: string;
  kind: string;
  value: string;

  constructor(id: string, kind: string, value: string) {
    this.id = id;
    this.kind = kind;
    this.value = value;
  }
}

class RequestState {
  client: http.HttpRequest;
  ended: boolean = false;
  status: number = 0;

  constructor(client: http.HttpRequest) {
    this.client = client;
  }
}

const requestId: RegExp = /^[0-9a-f-]{36}$/;
const feishuBlocks: RegExp = /^https:\/\/open\.feishu\.cn\/open-apis\/docx\/v1\/documents\/[A-Za-z0-9]{1,100}\/blocks\/[A-Za-z0-9]{1,100}\/children\?client_token=[0-9a-f-]{36}$/;
const endpoints: string[] = [
  'https://api.deepseek.com/chat/completions',
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
  'https://open.feishu.cn/open-apis/docx/v1/documents',
];
const pdfUploadUrl: string = 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all';
const multipartType: RegExp = /^multipart\/form-data; boundary=[A-Za-z0-9-]{1,80}$/;

export class DeskBridge {
  private controller: webview.WebviewController;
  private getAbility: () => common.UIAbilityContext;
  private requests: Map<string, RequestState> = new Map();
  private base64: util.Base64Helper = new util.Base64Helper();
  private saving: boolean = false;
  private speech: DeskSpeech;

  constructor(controller: webview.WebviewController, getAbility: () => common.UIAbilityContext) {
    this.controller = controller;
    this.getAbility = getAbility;
    this.speech = new DeskSpeech(getAbility, (id: string, kind: string, value: string) => this.send(id, kind, value));
  }

  private send(id: string, kind: string, value: string = ''): void {
    const message = JSON.stringify(new BridgeEvent(id, kind, value));
    try {
      this.controller.runJavaScript(
        "window.dispatchEvent(new CustomEvent('lecture-desk-native',{detail:" + message + ' }));'
      ).catch(() => {});
    } catch { /* The app page may already be closed. */ }
  }

  startHttp(id: string, url: string, body: string, authorization: string, contentType: string): boolean {
    const upload = url === pdfUploadUrl;
    const allowed = upload ? multipartType.test(contentType) : endpoints.includes(url) || feishuBlocks.test(url);
    if (!requestId.test(id) || this.requests.has(id) || this.requests.size >= 6 ||
      body.length > (upload ? 28000000 : 4000000) || !body.length || authorization.length > 5000 ||
      /[\r\n]/.test(authorization) || !allowed) {
      return false;
    }
    const client = http.createHttp();
    const operation = new RequestState(client);
    this.requests.set(id, operation);
    const headers: Record<string, string> = { 'Content-Type': upload ? contentType : 'application/json' };
    if (authorization) headers['Authorization'] = authorization;
    try {
      let payload: string | ArrayBuffer = body;
      if (upload) {
        const decoded = this.base64.decodeSync(body);
        payload = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
      }
      client.on('headersReceive', (value: Object) => {
        if (this.requests.has(id)) this.send(id, 'headers', JSON.stringify(value));
      });
      client.on('dataReceive', (chunk: ArrayBuffer) => {
        if (this.requests.has(id)) this.send(id, 'data', this.base64.encodeToStringSync(new Uint8Array(chunk)));
      });
      client.on('dataEnd', () => {
        if (!this.requests.has(id)) return;
        operation.ended = true;
        this.send(id, 'end');
        if (operation.status) this.cancelHttp(id);
      });
      client.requestInStream(url, {
        method: http.RequestMethod.POST,
        header: headers,
        extraData: payload,
        usingCache: false,
        connectTimeout: 12000,
        readTimeout: 110000,
      }).then((status: number) => {
        if (!this.requests.has(id)) return;
        operation.status = status;
        this.send(id, 'status', status.toString());
        if (operation.ended) this.cancelHttp(id);
      }).catch(() => {
        if (!this.requests.has(id)) return;
        this.send(id, 'error');
        this.cancelHttp(id);
      });
      return true;
    } catch {
      this.cancelHttp(id);
      return false;
    }
  }

  cancelHttp(id: string): void {
    const operation = this.requests.get(id);
    if (operation) {
      this.requests.delete(id);
      operation.client.destroy();
    }
  }

  stopAll(): void {
    for (const id of this.requests.keys()) this.cancelHttp(id);
    this.speech.cancel();
  }

  startVoice(id: string): boolean { return this.speech.start(id); }
  finishVoice(id: string): void { this.speech.finish(id); }
  cancelVoice(id: string): void { this.speech.cancel(id); }

  saveDocument(id: string, name: string, data: string): boolean {
    if (!requestId.test(id) || this.saving || data.length > 139810136 ||
      !/\.(docx|pdf)$/.test(name) || name.length > 240 || /[<>:"/\\|?*\x00-\x1f]/.test(name)) return false;
    this.saving = true;
    this.writeDocument(id, name, data).finally(() => { this.saving = false; });
    return true;
  }

  private async writeDocument(id: string, name: string, data: string): Promise<void> {
    try {
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [name];
      options.fileSuffixChoices = [name.endsWith('.pdf') ? 'PDF (*.pdf)|.pdf' : 'Word (*.docx)|.docx'];
      const uris = await new picker.DocumentViewPicker(this.getAbility()).save(options);
      if (!uris.length) {
        this.send(id, 'cancelled');
        return;
      }
      const bytes = this.base64.decodeSync(data);
      const file = await fileIo.open(uris[0], fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.TRUNC);
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          const buffer = bytes.buffer.slice(bytes.byteOffset + written, bytes.byteOffset + bytes.byteLength);
          const count = await fileIo.write(file.fd, buffer, { offset: written });
          if (count <= 0) throw new Error('无法完成写入');
          written += count;
        }
        await fileIo.fsync(file.fd);
      } finally {
        await fileIo.close(file);
      }
      this.send(id, 'saved');
    } catch {
      this.send(id, 'error');
    }
  }

  openLink(url: string): void {
    if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 2000) return;
    try {
      this.getAbility().startAbility({
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: url,
      }).catch(() => {});
    } catch { /* No browser is available to handle this link. */ }
  }
}
