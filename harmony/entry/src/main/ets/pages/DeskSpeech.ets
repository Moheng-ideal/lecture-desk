import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { speechRecognizer } from '@kit.CoreSpeechKit';

export class DeskSpeech {
  private session: string = '';
  private engine?: speechRecognizer.SpeechRecognitionEngine;
  private getAbility: () => common.UIAbilityContext;
  private emit: (id: string, kind: string, value: string) => void;

  constructor(getAbility: () => common.UIAbilityContext, emit: (id: string, kind: string, value: string) => void) {
    this.getAbility = getAbility;
    this.emit = emit;
  }

  start(id: string): boolean {
    if (this.session || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) return false;
    this.session = id;
    this.listen(id);
    return true;
  }

  private async listen(id: string): Promise<void> {
    if (!canIUse('SystemCapability.AI.SpeechRecognizer')) {
      this.end(id, 'voice-error', '这台设备暂不支持应用内语音听写，可使用系统键盘的语音输入。');
      return;
    }
    try {
      const manager = abilityAccessCtrl.createAtManager();
      const permission = await manager.requestPermissionsFromUser(this.getAbility(), ['ohos.permission.MICROPHONE']);
      if (id !== this.session) return;
      if (permission.authResults[0] !== 0) {
        this.end(id, 'voice-error', '请在系统设置中允许讲课台使用麦克风。');
        return;
      }
      const engine = await speechRecognizer.createEngine({ language: 'zh-CN', online: 1 });
      if (id !== this.session) {
        engine.shutdown();
        return;
      }
      this.engine = engine;
      const listener: speechRecognizer.RecognitionListener = {
        onStart: (sessionId: string, _message: string) => {
          if (sessionId === this.session) this.emit(sessionId, 'voice-start', '');
        },
        onEvent: (_sessionId: string, _code: number, _message: string) => {},
        onResult: (sessionId: string, result: speechRecognizer.SpeechRecognitionResult) => {
          if (sessionId === this.session) {
            this.emit(sessionId, result.isFinal ? 'voice-final' : 'voice-partial', result.result);
          }
        },
        onComplete: (sessionId: string, _message: string) => this.end(sessionId, 'voice-done', ''),
        onError: (sessionId: string, code: number, _message: string) => this.reportError(sessionId, code),
      };
      engine.setListener(listener);
      engine.startListening({
        sessionId: id,
        audioInfo: { audioType: 'pcm', sampleRate: 16000, soundChannel: 1, sampleBit: 16 },
        extraParams: { recognitionMode: 0, vadBegin: 6500, vadEnd: 2200, maxAudioDuration: 30000 },
      });
    } catch (error) {
      this.reportError(id, (error as BusinessError).code);
    }
  }

  finish(id: string): void {
    if (id !== this.session) return;
    if (!this.engine) {
      this.end(id, 'voice-done', '');
      return;
    }
    try { this.engine.finish(id); }
    catch (error) { this.reportError(id, (error as BusinessError).code); }
  }

  cancel(id: string = this.session): void {
    if (!id || id !== this.session) return;
    const engine = this.engine;
    this.session = '';
    this.engine = undefined;
    try { engine?.cancel(id); } catch { /* Already ended. */ }
    try { engine?.shutdown(); } catch { /* Already released. */ }
  }

  private reportError(id: string, code: number): void {
    if (code === 1002200003) {
      this.end(id, 'voice-done', '');
      return;
    }
    const message = code === 1002200012
      ? '请在系统设置中允许讲课台使用麦克风。'
      : '鸿蒙语音识别暂时不可用，可用系统键盘的语音输入。';
    this.end(id, 'voice-error', message);
  }

  private end(id: string, kind: string, value: string): void {
    if (id !== this.session) return;
    const engine = this.engine;
    this.session = '';
    this.engine = undefined;
    try { engine?.shutdown(); } catch { /* Already released. */ }
    this.emit(id, kind, value);
  }
}
