import { common } from '@kit.AbilityKit';
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

  private getAbility(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private async pickPdf(result: FileSelectorResult): Promise<void> {
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters = ['PDF (*.pdf)|.pdf'];
      const files = await new picker.DocumentViewPicker(this.getAbility()).select(options);
      result.handleFileList(files);
    } catch {
      result.handleFileList([]);
    }
  }

  aboutToDisappear(): void {
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
        .javaScriptProxy({
          object: this.native,
          name: 'LectureDeskNative',
          methodList: ['startHttp', 'cancelHttp', 'saveDocument', 'openLink'],
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
            this.controller.runJavaScript("window.dispatchEvent(new Event('lecture-desk-native-ready'));").catch(() => {});
          }
        })
        .onLoadIntercept((event) => {
          const url = event?.data.getRequestUrl() || '';
          return url !== 'about:blank' && !url.startsWith(APP_ORIGIN + '/');
        })
        .onShowFileSelector((event) => {
          if (!event) return false;
          this.pickPdf(event.result);
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
