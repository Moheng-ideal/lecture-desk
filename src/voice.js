import { newId } from './storage.js';
import { nativeApp } from './platform.js';

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
  if (nativeApp) {
    const { harmonyVoice } = await import('./harmony.js');
    return harmonyVoice();
  }
  return browserVoice();
}

export function installVoice({ canSend, send } = {}) {
  const button = document.getElementById('voice-input');
  const question = document.getElementById('question');
  const status = document.getElementById('voice-status');
  const composer = button.closest('form');
  const cancelDistance = 64;
  const hold = import.meta.env?.MODE === 'android';
  let current;
  if (hold) {
    button.dataset.holdVoice = '';
    button.title = '按住录音，松手发送，上滑取消';
  } else if (!nativeApp) button.title = '使用浏览器语音识别，取决于浏览器及其语音服务';

  function show(message = '') {
    if (hold) {
      composer.toggleAttribute('data-voice-active', Boolean(current));
      composer.toggleAttribute('data-voice-cancel', Boolean(current?.cancelReady));
      if (current?.cancelReady) message = '松手取消，向下滑可继续录音。';
      else if (current && !message) {
        message = {
          starting: '正在开启麦克风…',
          recording: '正在录音。松手发送，上滑取消。',
          limit: '已录满 30 秒。松手发送，上滑取消。',
          processing: 'DeepSeek 正在转写…',
        }[current.phase];
      }
    }
    status.textContent = message;
    status.hidden = !message;
    button.setAttribute('aria-pressed', String(!!current));
    if (hold) {
      button.toggleAttribute('data-recording', current?.phase === 'recording');
      button.textContent = {
        starting: '正在开启…', recording: '松手发送', limit: '松手发送', processing: '正在转写…',
      }[current?.phase] || '按住说话';
      if (current?.cancelReady) button.textContent = '松手取消';
    } else button.textContent = current ? '结束语音' : '语音';
  }

  function reset() {
    const session = current;
    current = null;
    clearTimeout(session?.timeout);
    if (session?.pointer != null && button.hasPointerCapture(session.pointer)) {
      button.releasePointerCapture(session.pointer);
    }
    return session;
  }

  function cancel(message) {
    const session = reset();
    try { session?.driver?.cancel(session.id); } catch { /* The device may have stopped already. */ }
    show(message);
  }

  function complete(error) {
    const session = reset();
    if (!session) return;
    const transcript = (session.parts.join('') + session.partial).trim().slice(0, question.maxLength);
    if (hold && transcript && !error) {
      if (!canSend()) {
        show('讲解师正在回复，本次语音未发送。');
        return;
      }
      show('语音已转写，正在发送…');
      Promise.resolve(send(transcript)).then(() => {
        if (!current && status.textContent === '语音已转写，正在发送…') show();
      }).catch(() => {
        if (!current) show('语音提问发送失败，请重试。');
      });
      return;
    }
    if (!hold && transcript) {
      const gap = question.value && !/\\s$/.test(question.value) ? '\\n' : '';
      question.value = (question.value + gap + transcript).slice(0, question.maxLength);
      question.dispatchEvent(new Event('input', { bubbles: true }));
    }
    show(error || (transcript && !hold ? '语音已加入提问草稿。' : '没有听清，请再试一次。'));
  }

  function finish() {
    const session = current;
    if (!session || session.phase === 'processing') return;
    if (!session.driver || (hold && session.phase === 'starting')) {
      cancel(hold ? '请按住按钮，看到正在录音后再说话。' : '');
      return;
    }
    try {
      if (hold) session.phase = 'processing';
      session.driver.finish(session.id);
      if (current === session) show(hold ? 'DeepSeek 正在转写…' : '正在整理听写…');
    } catch { cancel('无法完成语音输入，请重试。'); }
  }

  async function start(pointer, startY) {
    if (current) return;
    if (hold && !canSend()) {
      show('请等讲解结束后再使用语音。');
      return;
    }
    const session = { id: newId(), pointer, startY, parts: [], partial: '', phase: 'starting' };
    current = session;
    if (hold) question.blur();
    if (pointer != null) button.setPointerCapture(pointer);
    show('正在开启麦克风…');
    try {
      session.driver = await voiceDriver();
      if (current !== session) return;
      session.timeout = setTimeout(() => {
        if (current !== session) return;
        if (hold) cancel('语音输入已超时，请重试。');
        else {
          complete('本次语音输入已结束。');
          try { session.driver.cancel(session.id); } catch { /* Already released. */ }
        }
      }, hold ? 120000 : 42000);
      session.driver.start(session.id, (kind, value) => {
        if (current !== session) return;
        if (kind === 'voice-start') {
          session.phase = 'recording';
          show(hold ? '' : '正在听写，请说话。');
        } else if (kind === 'voice-limit') {
          if (session.phase !== 'processing') {
            session.phase = 'limit';
            show();
          }
        } else if (kind === 'voice-processing') {
          session.phase = 'processing';
          show('DeepSeek 正在转写…');
        } else if (kind === 'voice-partial') {
          session.partial = value;
          show(value || '正在听写…');
        } else if (kind === 'voice-final') {
          session.parts.push(value);
          session.partial = '';
          if (!hold) show(value || '正在听写…');
        } else if (kind === 'voice-done' || kind === 'voice-error') {
          complete(kind === 'voice-error' ? value : '');
        }
      });
    } catch (error) {
      if (current === session) complete(error.message);
    }
  }

  if (hold) {
    button.oncontextmenu = (event) => event.preventDefault();
    button.onpointerdown = (event) => {
      if (event.button !== 0 || current) return;
      event.preventDefault();
      start(event.pointerId, event.clientY);
    };
    button.onpointermove = (event) => {
      if (current?.pointer !== event.pointerId) return;
      const cancelReady = current.startY - event.clientY >= cancelDistance;
      if (cancelReady !== Boolean(current.cancelReady)) {
        current.cancelReady = cancelReady;
        show();
      }
    };
    button.onpointerup = (event) => {
      if (current?.pointer !== event.pointerId) return;
      const cancelReady = current.startY - event.clientY >= cancelDistance;
      current.pointer = undefined;
      if (cancelReady) cancel('录音已取消。');
      else {
        current.cancelReady = false;
        finish();
      }
    };
    button.onpointercancel = button.onlostpointercapture = (event) => {
      if (current?.pointer === event.pointerId) cancel('录音已取消。');
    };
    button.onkeydown = (event) => {
      if (event.key === 'Escape' && current) cancel('录音已取消。');
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (!event.repeat) start();
    };
    button.onkeyup = (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && current?.pointer == null) {
        event.preventDefault();
        finish();
      }
    };
    button.onblur = () => {
      if (current && current.pointer == null && current.phase !== 'processing') cancel();
    };
    button.onclick = (event) => {
      if (!event.detail && !event.pointerType) {
        if (current) finish();
        else start();
      }
    };
  } else button.onclick = () => current ? finish() : start();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (hold || current?.phase === 'recording')) cancel();
  });
  window.addEventListener('pagehide', () => cancel());
  show();
  return { cancel };
}
