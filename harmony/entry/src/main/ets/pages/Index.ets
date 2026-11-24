import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { webview } from '@kit.ArkWeb';
import { picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { APP_ORIGIN, deskAssetResponse } from './DeskAssets';
import { DeskBridge } from './DeskBridge';

@Entry
@Component
struct Index {
  @State startupFailed: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private native: DeskBridge = new DeskBridge(this.controller, () => this.getAbility());

  private stopPen?: () => void;
  private penGeneration: number = 0;
  private webReady: boolean = false;

  private getAbility(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private async pickBooks(result: FileSelectorResult, multiple: boolean): Promise<void> {
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = multiple ? 500 : 1;
      options.fileSuffixFilters = ['课件 (*.pdf;*.docx;*.doc;*.pptx;*.ppt)|.pdf,.docx,.doc,.pptx,.ppt'];
      const files = await new picker.DocumentViewPicker(this.getAbility()).select(options);
      result.handleFileList(files);
    } catch {
      result.handleFileList([]);
    }
  }

  onPageShow(): void {
    if (this.stopPen || deviceInfo.sdkApiVersion < 19 || !canIUse('SystemCapability.Stylus.StylusService')) return;
    this.startPen(++this.penGeneration);
  }

  private async startPen(generation: number): Promise<void> {
    try {
      const pen = await import('./DeskPen');
      if (generation !== this.penGeneration) return;
      this.stopPen = pen.subscribePenSqueeze((): void => {
        if (generation === this.penGeneration && this.webReady) this.native.openPenShortcuts();
      });
    } catch {
      hilog.warn(0x2900, 'LectureDesk', 'Unable to subscribe to Pen Kit squeeze events');
    }
  }

  onPageHide(): void {
    this.penGeneration++;
    const stop = this.stopPen;
    this.stopPen = undefined;
    try {
      stop?.();
    } catch {
      hilog.warn(0x2900, 'LectureDesk', 'Unable to unsubscribe from Pen Kit squeeze events');
    }
  }

  aboutToDisappear(): void {
    this.webReady = false;
    this.onPageHide();
    this.native.stopAll();
  }

  build() {
    Stack() {
      Web({ src: APP_ORIGIN + '/', controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .zoomAccess(false)
        .onTouchIntercept((event) => {
          this.native.observeTouch(event);
          return HitTestMode.Default;
        })
        .javaScriptProxy({
          object: this.native,
          name: 'LectureDeskNative',
          methodList: ['startHttp', 'cancelHttp', 'saveDocument', 'openLink',
            'startVoice', 'finishVoice', 'cancelVoice', 'penAtContact'],
          controller: this.controller,
        })
        // ArkWeb accepts null to pass through requests outside the bundled origin.
        .onInterceptRequest((event) => deskAssetResponse(event.request)!)
        .onErrorReceive((event) => {
          if (event?.request.isMainFrame() && event.request.getRequestUrl().startsWith(APP_ORIGIN + '/')) {
            hilog.error(0x2900, 'LectureDesk', 'Offline page load failed (%{public}d)', event.error.getErrorCode());
            this.startupFailed = true;
          }
        })
        .onPageEnd((event) => {
          if (event?.url.startsWith(APP_ORIGIN + '/')) {
            this.webReady = true;
            this.controller.runJavaScript("window.dispatchEvent(new Event('lecture-desk-native-ready'));").catch(() => {});
          }
        })
        .onLoadIntercept((event) => {
          const url = event?.data.getRequestUrl() || '';
          return url !== 'about:blank' && !url.startsWith(APP_ORIGIN + '/');
        })
        .onShowFileSelector((event) => {
          if (!event) return false;
          this.pickBooks(event.result, event.fileSelector.getMode() === FileSelectorMode.FileOpenMultipleMode);
          return true;
        })
      if (this.startupFailed) {
        Text('无法加载讲课台。请退出应用后重试。')
          .fontSize(16)
          .fontColor('#39463b')
          .padding(24)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#f9f7f2')
  }
}
