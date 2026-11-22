import { newId } from './storage.js';

function browserVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) throw new Error('这个浏览器不支持应用内听写，可用输入法的麦克风。');
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  return {
    start(_id, emit) {
      recognition.onstart = () => emit('voice-start', '');
      recognition.onresult = ({ results, resultIndex }) => {
        for (let i = resultIndex; i < results.length; i++) {
          const result = results[i];
          emit(result.isFinal ? 'voice-final' : 'voice-partial', result[0].transcript);
        }
      };
      recognition.onend = () => emit('voice-done', '');
      recognition.onerror = ({ error }) => emit('voice-error', error === 'not-allowed'
        ? '请允许浏览器使用麦克风。' : '浏览器听写未完成，可用输入法的麦克风。');
      recognition.start();
    },
    finish: () => recognition.stop(),
    cancel: () => recognition.abort(),
  };
}

async function voiceDriver() {
  if (import.meta.env.MODE === 'harmony') {
    const { harmonyVoice } = await import('./harmony.js');
    return harmonyVoice();
  }
  return browserVoice();
}

export function installVoice() {
  const button = document.getElementById('voice-input');
  const question = document.getElementById('question');
  const status = document.getElementById('voice-status');
  let current;
  if (import.meta.env.MODE !== 'harmony') button.title = '使用浏览器语音识别，取决于浏览器及其语音服务';

  function show(message = '') {
    status.textContent = message;
    status.hidden = !message;
    button.setAttribute('aria-pressed', String(!!current));
    button.textContent = current ? '结束语音' : '语音';
  }
  function reset() {
    const session = current;
    current = null;
    clearTimeout(session?.timeout);
    return session;
  }
  function cancel() {
    const session = reset();
    try { session?.driver?.cancel(session.id); } catch { /* The device may have stopped already. */ }
    show();
  }
  function complete(error) {
    const session = reset();
    if (!session) return;
    const transcript = (session.parts.join('') + session.partial).trim();
    if (transcript) {
      const gap = question.value && !/\s$/.test(question.value) ? '\n' : '';
      question.value = (question.value + gap + transcript).slice(0, question.maxLength);
      question.dispatchEvent(new Event('input', { bubbles: true }));
    }
    show(error || (transcript ? '语音已加入提问草稿。' : '没有听清，请再试一次。'));
  }
  button.onclick = async () => {
    if (current) {
      if (!current.driver) {
        cancel();
        return;
      }
      try {
        current.driver.finish(current.id);
        if (current) show('正在整理听写…');
      } catch {
        cancel();
        show('无法继续语音听写，请重试。');
      }
      return;
    }
    const session = { id: newId(), parts: [], partial: '', listening: false };
    current = session;
    show('正在开启麦克风…');
    try {
      session.driver = await voiceDriver();
      if (current !== session) return;
      session.timeout = setTimeout(() => {
        if (current !== session) return;
        complete('本次语音输入已结束。');
        try { session.driver.cancel(session.id); } catch { /* Already released. */ }
      }, 42000);
      session.driver.start(session.id, (kind, value) => {
        if (current !== session) return;
        if (kind === 'voice-start') {
          session.listening = true;
          show('正在听写，请说话。');
        } else if (kind === 'voice-partial') {
          session.partial = value;
          show(value || '正在听写…');
        } else if (kind === 'voice-final') {
          session.parts.push(value);
          session.partial = '';
          show(value || '正在听写…');
        } else if (kind === 'voice-done' || kind === 'voice-error') {
          complete(kind === 'voice-error' ? value : '');
        }
      });
    } catch (error) {
      if (current === session) complete(error.message);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && current?.listening) cancel();
  });
  window.addEventListener('pagehide', cancel);
  return { cancel };
}
