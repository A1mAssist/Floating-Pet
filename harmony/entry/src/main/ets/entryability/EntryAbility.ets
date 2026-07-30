import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  private floatWindow?: window.Window;

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.openProductWindow(windowStage);
  }

  onWindowStageDestroy(): void {
    this.floatWindow?.destroyWindow().catch(() => undefined);
    this.floatWindow = undefined;
  }

  private async openProductWindow(windowStage: window.WindowStage): Promise<void> {
    try {
      const floatWindow = await window.createWindow({
        name: 'FloatPet',
        windowType: window.WindowType.TYPE_FLOAT,
        ctx: this.context
      });
      await floatWindow.resize(460, 640);
      await floatWindow.moveWindowTo(120, 120);
      floatWindow.setWindowBackgroundColor('#00000000');
      await floatWindow.loadContent('pages/Index');
      await floatWindow.showWindow();
      this.floatWindow = floatWindow;
      await windowStage.getMainWindowSync().minimize();
      console.info('[FloatPet] TYPE_FLOAT_READY');
    } catch (error) {
      console.error(`[FloatPet] TYPE_FLOAT_FAILED ${JSON.stringify(error)}`);
      const mainWindow = windowStage.getMainWindowSync();
      mainWindow.setWindowBackgroundColor('#00000000');
      await mainWindow.resize(460, 640).catch(() => undefined);
      await windowStage.loadContent('pages/Index');
      console.info('[FloatPet] MAIN_WINDOW_READY');
    }
  }
}
