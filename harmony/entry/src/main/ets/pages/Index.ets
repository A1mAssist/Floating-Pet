import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Stack() {
      Web({
        src: $rawfile('index.html'),
        controller: this.controller
      })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .backgroundColor(Color.Transparent)
        .onPageEnd(() => {
          console.info('[FloatPet] ARKWEB_PAGE_READY');
        })
        .onConsole((event) => {
          console.info(`[FloatPetWeb] ${event.message.getMessage()}`);
          return false;
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
