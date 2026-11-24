import './styles.css';
import { version } from '../package.json';
import changelog from '../CHANGELOG.md?raw';
import { Reader } from './reader.js';
import { listBooks, listRecords, newId, readState, removeBook, saveBook, saveRecord, saveState } from './storage.js';
import { getConfiguration, getConnections, saveConnections, sendPdfToFeishu, sendToFeishu, streamAnswer, suggestBookTitle } from './api.js';
import { formatDate, groupRecords, sourceLabel } from './records.js';
import { loadDeepSeekKey, rememberDeepSeekKey } from './credential-store.js';
import { installScrollThumb } from './scroll-thumb.js';
import { installDividers } from './layout.js';
import { installPenShortcuts } from './pen-shortcuts.js';
import { installWhiteboard } from './whiteboard.js';
import { installTheme } from './theme.js';
import { installVoice } from './voice.js';
import { nativeApp } from './platform.js';
import { CHAT_BUDGET, MAX_REFERENCES, currentReferences } from './excerpts.js';
import { bookFormat, formats } from './book-format.js';

const $ = (id) => document.getElementById(id);
const sample = { id: 'sample', title: '函数与图像', sample: true };
const state = { book: sample, records: [], references: [], exports: [], config: {}, failed: null };
const drafts = new Map();
const bookTitles = new Map([[sample.id, sample.title]]);
let openBooks = [];
let renamedBooks = new Map();
let rename;
const voice = installVoice({
  canSend: () => !state.stream && !changingBook,
  send: (text) => ask(text, state.references, { preserveDraft: true }),
});
let reader;
let toastTimeout;
let changingBook;
let importingBooks = false;
let exportBusy = false;
let savedKey;
let credentialError = '';
let teachingPreferences = { profile: '', mode: 'default', style: '' };
const preferencesReady = readState('teachingPreferences').then((saved) => {
  if (saved) teachingPreferences = saved;
}).catch(() => {});
const credentialsReady = loadDeepSeekKey().then((key) => {
  savedKey = key;
  saveConnections({ ...getConnections(), deepseek: key });
}).catch((error) => {
  credentialError = error.message;
});

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, callback, className) {
  const node = element('button', label, className);
  node.type = 'button';
  node.onclick = callback;
  return node;
}

function feedback(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = !message;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 3800);
}

function failure(error) {
  feedback(error.message || '操作失败，请重试。');
}

function status(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function showPanel(panel) {
  $('workspace').dataset.panel = panel;
  for (const target of document.querySelectorAll('.mobile-tabs button')) {
    target.setAttribute('aria-pressed', String(target.dataset.panel === panel));
  }
}

function setBookFullscreen(enabled) {
  const button = $('book-fullscreen');
  const workspace = $('workspace');
  if (workspace.hasAttribute('data-book-fullscreen') === enabled) return;
  workspace.toggleAttribute('data-book-fullscreen', enabled);
  const tools = enabled ? $('pdf-tools') : $('book-title').closest('.book-bar');
  tools.append($('book-actions'));
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = enabled ? '退出全屏' : '全屏';
  button.title = enabled ? '恢复左侧书名和标签栏' : '展开左侧课本';
}

function displayExcerpts() {
  $('excerpts').replaceChildren(...state.references.map((ref) => {
    const container = element('div', null, 'excerpt-chip');
    const detail = referenceDetails(ref);
    const remove = button('×', () => {
      state.references = state.references.filter((item) => item !== ref);
      displayExcerpts();
    });
    remove.setAttribute('aria-label', '移除此引用');
    container.append(detail, remove);
    return container;
  }));
}

function addExcerpt(reference) {
  if (state.references.some((ref) => ref.bookId === reference.bookId && ref.page === reference.page &&
      ref.image === reference.image && ref.text === reference.text)) {
    feedback('这张截图已经加入本次提问。');
    return;
  }
  if (state.references.length >= MAX_REFERENCES) {
    throw new Error(`单次提问最多附上 ${MAX_REFERENCES} 张截图，请先移除一张。`);
  }
  state.references.push(reference);
  displayExcerpts();
  feedback(`已添加截图，本次提问已附 ${state.references.length} 项资料。`);
}

function referenceDetails(reference) {
  const detail = element('details', null, 'citation');
  detail.append(element('summary', sourceLabel(reference)));
  if (reference.image) {
    const image = element('img', null, 'excerpt-image');
    image.alt = sourceLabel(reference);
    image.src = reference.image;
    image.loading = 'lazy';
    detail.append(image);
  } else detail.append(element('blockquote', reference.text));
  return detail;
}

function userCard({ question, references, bookId }) {
  const item = element('li', null, 'message user');
  item.append(element('span', '你', 'message-label'), element('p', question), ...currentReferences(references, bookId, bookTitles).map(referenceDetails));
  return item;
}

function assistantCard() {
  const item = element('li', null, 'message assistant');
  const content = element('div', '正在准备讲解…', 'pending');
  item.append(element('span', '讲解师', 'message-label'), content);
  return { item, content };
}

async function renderAnswer(target, answer) {
  target.textContent = answer;
  try {
    const { formatAnswer } = await import('./format-answer.js');
    formatAnswer(target, answer);
  } catch {
    target.className = 'pending';
  }
}

function liveAnswer(target, scroll) {
  const formatter = import('./format-answer.js').catch(() => null);
  let latest = '';
  let lastRendered;
  let timer;
  let closed = false;
  const paint = (module, text) => {
    const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    try {
      if (module) module.formatAnswer(target, text);
      else target.textContent = text;
    } catch { target.textContent = text; }
    lastRendered = text;
    if (follow) scrollToEnd();
  };
  return {
    update(text) {
      latest = text;
      if (timer || closed) return;
      timer = setTimeout(async () => {
        const module = await formatter;
        timer = null;
        if (!closed && latest !== lastRendered) paint(module, latest);
      }, Math.min(1200, 65 + Math.floor(text.length / 400)));
    },
    async finish(text) {
      closed = true;
      clearTimeout(timer);
      if (text !== lastRendered) paint(await formatter, text);
    },
  };
}

function scrollToEnd() {
  $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight;
}

function displayThread() {
  $('messages').replaceChildren();
  const records = state.records.filter((record) => record.bookId === state.book.id);
  $('welcome').hidden = Boolean(records.length);
  for (const record of records) {
    const { item, content } = assistantCard();
    $('messages').append(userCard(record), item);
    renderAnswer(content, record.answer);
  }
  scrollToEnd();
}

function syncChat() {
  const busy = Boolean(state.stream);
  $('send').disabled = busy || Boolean(changingBook);
  $('stop').hidden = !busy;
  $('teach-page').disabled = busy || !reader?.rendered || Boolean(changingBook);
  $('teach-next').disabled = $('teach-page').disabled || reader.page >= reader.documentSource.numPages;
  $('connection-state').textContent = state.config.unavailable ? 'DeepSeek · 服务不可用' :
    state.config.requiresCode && !state.config.authorized ? 'DeepSeek · 请输入访问口令' :
      state.config.deepseek || getConnections().deepseek ? 'DeepSeek Flash · 已配置' : 'DeepSeek · 待配置';
}

async function refreshConfiguration() {
  try { state.config = await getConfiguration(); }
  catch { state.config = { unavailable: true }; }
  syncChat();
}

async function activateBook(book) {
  if (changingBook) return false;
  book.title = renamedBooks.get(book.id) || book.title;
  if (state.stream) {
    feedback('请先结束当前讲解，再切换课本。');
    return false;
  }
  const previous = state.book.id;
  voice.cancel();
  drafts.set(previous, { text: $('question').value, references: state.references, failed: state.failed });
  changingBook = book.id;
  syncChat();
  try {
    if (!await reader.open(book)) return false;
    state.book = book;
    bookTitles.set(book.id, book.title);
    if (!openBooks.some(({ id }) => id === book.id)) openBooks.push(book);
    const draft = drafts.get(book.id);
    state.references = draft?.references || [];
    state.failed = draft?.failed || null;
    $('question').value = draft?.text || '';
    displayExcerpts();
    displayThread();
    status('chat-status');
    renderBookTabs();
    saveState('activeBook', book.id).catch(() => {});
    return true;
  } finally {
    if (changingBook === book.id) changingBook = null;
    syncChat();
  }
}

function renderBookTabs() {
  const nav = $('book-tabs');
  const left = nav.scrollLeft;
  const focus = nav.contains(document.activeElement);
  let active;
  const remaining = new Map([...nav.children].map((child) => [child.dataset.id, child]));
  for (const book of openBooks) {
    const selected = book.id === state.book.id;
    let item = remaining.get(book.id);
    if (!item) {
      item = element('div', null, 'book-tab');
      item.dataset.id = book.id;
      const pick = button(book.title, () => {
        showPanel('book');
        if (book.id !== state.book.id) activateBook(book).catch(failure);
      });
      pick.ondblclick = () => openBookRename(book);
      pick.onkeydown = (event) => {
        if (event.key !== 'F2') return;
        event.preventDefault();
        openBookRename(book);
      };
      const close = button('×', () => closeBookTab(book.id).catch(failure));
      item.append(pick, close);
      nav.append(item);
    }
    remaining.delete(book.id);
    const [pick, close] = item.children;
    item.dataset.selected = String(selected);
    if (pick.textContent !== book.title) pick.textContent = book.title;
    pick.title = `${book.title}（双击或按 F2 重命名）`;
    pick.setAttribute('aria-current', String(selected));
    close.setAttribute('aria-label', `关闭《${book.title}》标签页`);
    if (selected) active = pick;
  }
  for (const item of remaining.values()) item.remove();
  nav.scrollLeft = left;
  if (focus) active?.focus({ preventScroll: true });
  if (active) {
    const bounds = nav.getBoundingClientRect();
    const item = active.parentElement.getBoundingClientRect();
    if (item.left < bounds.left) nav.scrollLeft += item.left - bounds.left;
    if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
  }
  saveState('openBooks', openBooks.map(({ id }) => id)).catch(() => {});
}

function openBookRename(book) {
  if ($('book-rename').open || rename?.saving) return;
  if (state.stream) {
    feedback('请先结束当前讲解，再重命名课本。');
    return;
  }
  rename = { book };
  $('book-rename-title').value = book.title;
  $('book-rename-save').disabled = $('book-ai-title').disabled = false;
  status('book-rename-status');
  $('book-rename').showModal();
  $('book-rename-title').select();
}

$('book-title').ondblclick = () => openBookRename(state.book);
$('book-rename').onclose = () => {
  if ($('book-rename').open) return;
  rename?.controller?.abort();
  if (!rename?.saving) rename = null;
};
$('book-rename-form').onsubmit = async (event) => {
  event.preventDefault();
  const edit = rename;
  const title = $('book-rename-title').value.trim();
  if (!edit || !title || edit.saving) return;
  edit.controller?.abort();
  edit.saving = true;
  $('book-rename-save').disabled = $('book-ai-title').disabled = true;
  try {
    const id = edit.book.id;
    const names = new Map(renamedBooks).set(id, title);
    await saveState('renamedBooks', [...names]);
    renamedBooks = names;
    edit.book.title = title;
    const tab = openBooks.find((book) => book.id === id);
    if (tab) tab.title = title;
    bookTitles.set(id, title);
    if (state.book.id === id) {
      state.book.title = title;
      reader.sync();
      displayThread();
    }
    state.references = currentReferences(state.references, state.book.id, bookTitles);
    displayExcerpts();
    renderBookTabs();
    if (rename === edit) $('book-rename').close();
  } catch (error) {
    if (rename === edit) status('book-rename-status', error.message || '名称未能保存。');
  } finally {
    if (rename === edit) $('book-rename-save').disabled = $('book-ai-title').disabled = false;
    edit.saving = false;
    if (rename === edit && !$('book-rename').open) rename = null;
  }
};

$('book-ai-title').onclick = async () => {
  const edit = rename;
  if (!edit || edit.controller || edit.saving) return;
  const controller = new AbortController();
  edit.controller = controller;
  $('book-ai-title').disabled = true;
  try {
    await credentialsReady;
    controller.signal.throwIfAborted();
    if (!state.config.deepseek && !getConnections().deepseek) {
      throw new Error('请先在设置中配置 DeepSeek API Key。');
    }
    if (changingBook) throw new Error('请等课本打开后再点「AI 总结命名」。');
    if (state.book.id !== edit.book.id && !await activateBook(edit.book)) throw new Error('无法打开课本。');
    controller.signal.throwIfAborted();
    if (!reader.documentSource) throw new Error('请先打开课本。');
    status('book-rename-status', 'DeepSeek 正在阅读课本页面并建议名称…');
    const count = reader.documentSource.numPages;
    const pages = [...new Set([1, reader.page > 1 ? reader.page : Math.min(2, count)])];
    const captures = [];
    for (const page of pages) {
      captures.push(await reader.capturePage(page));
      controller.signal.throwIfAborted();
    }
    const answer = await suggestBookTitle(captures, controller.signal);
    controller.signal.throwIfAborted();
    const title = answer.trim().split(/\r?\n/)[0].replace(/^[\s#*「『《“"']+|[\s*」』》”"']+$/g, '').slice(0, 100);
    if (!title) throw new Error('DeepSeek 未返回有效名称，请重试。');
    $('book-rename-title').value = title;
    status('book-rename-status', '已填入建议，可继续修改，点「保存名称」应用。');
  } catch (error) {
    if (!controller.signal.aborted) status('book-rename-status', error.message);
  } finally {
    edit.controller = null;
    if (rename === edit && !edit.saving) $('book-ai-title').disabled = false;
  }
};

async function closeBookTab(id) {
  if (changingBook) return;
  const index = openBooks.findIndex((book) => book.id === id);
  if (index < 0) return;
  if (id === state.book.id) {
    const next = openBooks[index + 1] || openBooks[index - 1];
    if (!next && id === sample.id) return;
    if (!await activateBook(next || sample)) return;
  }
  openBooks = openBooks.filter((book) => book.id !== id);
  drafts.delete(id);
  reader.discardHistory(id);
  renderBookTabs();
}

async function importBooks(files) {
  if (!files.length || importingBooks) return;
  importingBooks = true;
  $('pdf-open').disabled = $('library-import').disabled = true;
  try {
    await bookReady;
    if (state.stream || changingBook) {
      feedback('请等当前讲解或课本打开后再导入。');
      return;
    }
    const books = [];
    for (const file of files) {
      const extension = bookFormat(file);
      if (!extension) continue;
      const title = file.name.replace(new RegExp(`\\.${extension}$`, 'i'), '').slice(0, 290) || '未命名课件';
      books.push({ id: newId(), title, file, extension, imported: Date.now() });
    }
    if (!books.length) {
      feedback('请选择 PDF、Word（.docx、.doc）或 PPT（.pptx、.ppt）文件。');
      return;
    }
    showPanel('book');
    if (books.length > 1) feedback(`正在导入 ${books.length} 份课件…`);
    let opened = false;
    let saved = 0;
    let temporary = 0;
    let rejected = files.length - books.length;
    let openError;
    for (const book of books) {
      let activated = false;
      if (!opened && !changingBook && !state.stream) {
        try { activated = await activateBook(book); }
        catch (error) {
          openError = error;
          rejected++;
          continue;
        }
        opened = activated;
      }
      try {
        await saveBook(book);
        saved++;
      } catch { temporary++; }
      if (!activated) {
        bookTitles.set(book.id, book.title);
        openBooks.push(book);
      }
    }
    renderBookTabs();
    if (!saved && !temporary && openError) throw openError;
    const result = [`已保存 ${saved} 份课件`];
    if (temporary) result.push(`${temporary} 份未能保存，仅本次可用`);
    if (rejected) result.push(`已跳过 ${rejected} 份无法导入的文件`);
    feedback(result.join('，') + '。');
  } finally {
    importingBooks = false;
    $('pdf-open').disabled = $('library-import').disabled = false;
  }
}

async function openLibrary() {
  const books = await listBooks().catch(() => []);
  const rows = [sample, ...books.sort((a, b) => b.imported - a.imported)].map((book) => {
    book.title = renamedBooks.get(book.id) || book.title;
    const row = element('div', null, 'book-row');
    const pick = button(book.title + (book.sample ? ' · 示例课' : ''), async () => {
      $('library').close();
      showPanel('book');
      if (book.id !== state.book.id) await activateBook(book).catch(failure);
    });
    pick.title = book.title;
    row.append(pick, button('重命名', () => {
      $('library').close();
      openBookRename(book);
    }, 'quiet'));
    if (!book.sample) row.append(element('small', formats[book.extension] || 'PDF'));
    if (!book.sample && book.id !== state.book.id) {
      row.append(button('移除', async () => {
        if (!confirm(`从本机书架移除《${book.title}》？`)) return;
        try {
          await removeBook(book.id);
          openBooks = openBooks.filter(({ id }) => id !== book.id);
          drafts.delete(book.id);
          reader.discardHistory(book.id);
          renderBookTabs();
          await openLibrary();
        } catch (error) { failure(error); }
      }, 'quiet'));
    }
    return row;
  });
  $('book-list').replaceChildren(...rows);
  if (!$('library').open) $('library').showModal();
}

async function openSettings(section) {
  await Promise.all([credentialsReady, preferencesReady, fingerInkReady]);
  const settings = getConnections();
  $('pass-label').hidden = !state.config.requiresCode;
  $('credential-fields').hidden = !state.config.canSupplyCredentials;
  $('feishu-fields').hidden = !state.config.canSupplyCredentials;
  $('feishu-browser-help').hidden = !state.config.canSupplyCredentials;
  $('feishu-local-help').hidden = Boolean(state.config.canSupplyCredentials);
  $('configuration-hint').textContent = nativeApp ?
    'DeepSeek API Key 加密保存在本机，重启后自动读取。清空密钥并应用设置即可移除。飞书凭据在本次打开期间使用。' :
    state.config.canSupplyCredentials ?
      'DeepSeek API Key 加密保存在当前浏览器。清空密钥并应用设置即可移除。飞书凭据和访问口令在本次会话期间使用。' :
      '局域网 HTTP 由电脑端的 .env 提供 API 凭据。平板上的课本和批注保存在平板。';
  $('access-code').value = settings.access;
  $('deepseek-key').value = settings.deepseek;
  status('credential-status', credentialError);
  $('feishu-id').value = settings.feishu.appId || '';
  $('feishu-secret').value = settings.feishu.secret || '';
  $('feishu-folder').value = settings.feishu.folder || '';
  $('finger-ink').checked = Boolean(reader.fingerInk);
  $('learner-profile').value = teachingPreferences.profile;
  $('teacher-style-mode').value = teachingPreferences.mode;
  $('teacher-style-field').hidden = teachingPreferences.mode !== 'custom';
  $('teacher-style').value = teachingPreferences.style;
  if (section === 'feishu') {
    $('feishu-settings').open = true;
    $('feishu-guide').open = true;
  }
  if (!$('settings').open) $('settings').showModal();
}

function precedingTurns(question, references, preferences) {
  const candidates = state.records.filter((record) => record.bookId === state.book.id).slice(-8).reverse();
  const turns = [];
  const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  let room = CHAT_BUDGET - 10000 - size({ question, references, preferences });
  for (const record of candidates) {
    if (record.answer.length > 950000) break;
    const turn = { question: record.question, answer: record.answer,
      references: currentReferences(record.references, record.bookId, bookTitles) };
    room -= size(turn);
    if (room < 0) break;
    turns.unshift(turn);
  }
  return turns;
}

async function ask(question, references = state.references, { preserveDraft = false } = {}) {
  await Promise.all([credentialsReady, preferencesReady]);
  if (state.stream || changingBook) return;
  references = currentReferences(references, state.book.id, bookTitles);
  question = question.trim() || (references.length ? '请结合所附课本内容讲解。' : '');
  if (!question) {
    status('chat-status', '请输入问题，或先添加课本截图。');
    return;
  }
  showPanel('chat');
  if (!state.config.deepseek && !getConnections().deepseek) {
    $('question').value = question;
    state.references = [...references];
    displayExcerpts();
    status('chat-status', '请先在设置中配置 DeepSeek。');
    openSettings();
    return;
  }

  const record = { id: newId(), bookId: state.book.id, bookTitle: state.book.title,
    date: new Date().toISOString(), question, references: [...references] };
  const controller = new AbortController();
  state.stream = controller;
  state.failed?.forEach((node) => node.remove());
  state.failed = null;
  state.references = [];
  if (!preserveDraft) $('question').value = '';
  displayExcerpts();
  status('chat-status');
  const user = userCard(record);
  const { item, content } = assistantCard();
  $('welcome').hidden = true;
  $('messages').append(user, item);
  scrollToEnd();
  syncChat();
  const live = liveAnswer(content, $('chat-scroll'));
  let answer = '';
  try {
    const preferences = { profile: teachingPreferences.profile,
      style: teachingPreferences.mode === 'custom' ? teachingPreferences.style : '' };
    const history = precedingTurns(question, references, preferences);
    answer = await streamAnswer({ question, references, history, preferences }, (text) => {
      answer = text;
      live.update(text);
    }, controller.signal);
    record.answer = answer;
    state.records.push(record);
    $('record-count').textContent = state.records.length;
    await live.finish(answer);
    await saveRecord(record).catch(() => feedback('问答暂存在内存，可以立即导出问答录。'));
  } catch (error) {
    const stopped = error.name === 'AbortError';
    const note = stopped ? '本次讲解已停止。' : error.message;
    status('chat-status', note);
    await live.finish(answer);
    content.append(element('p', answer ? `${note} 这条讲解未收入问答录。` : note));
    state.failed = [user, item];
    if (!$('question').value.trim()) $('question').value = question;
    if (!state.references.length) {
      state.references = [...references];
      displayExcerpts();
    }
  } finally {
    state.stream = null;
    syncChat();
  }
}

async function teach(question, next = false) {
  if (state.stream || changingBook || !reader.rendered) return;
  voice.cancel();
  $('teach-page').disabled = true;
  $('teach-next').disabled = true;
  try {
    if (state.references.length >= MAX_REFERENCES) throw new Error('本次提问的截图已满，请先移除一张。');
    if (next) await reader.setPage(reader.page + 1);
    const ref = await reader.quotePage();
    if (state.references.length >= MAX_REFERENCES) throw new Error('本次提问的截图已满，请先移除一张。');
    await ask(question, [...state.references, ref]);
  } catch (error) {
    failure(error);
  } finally {
    syncChat();
  }
}

function selectedRecords() {
  const ids = new Set([...$('record-list').querySelectorAll('input:checked')].map((input) => input.value));
  return state.records.filter((record) => ids.has(record.id)).map((record) => ({
    ...record, bookTitle: bookTitles.get(record.bookId) || record.bookTitle,
    references: currentReferences(record.references, record.bookId, bookTitles),
  }));
}

function updateRecordSelection() {
  const count = selectedRecords().length;
  $('record-selection').textContent = `已选 ${count} 条`;
  $('export-docx').disabled = $('export-feishu').disabled = exportBusy || count === 0;
}

function exportOptions() {
  const title = $('record-title').value.trim();
  const records = selectedRecords();
  if (!records.length) throw new Error('请勾选至少一条问答。');
  if (!title) throw new Error('请填写问答录标题。');
  return { title, records };
}

function showFeishu(url) {
  const link = $('feishu-link');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.feishu\.cn$/i.test(parsed.hostname)) throw new Error();
    link.href = parsed.href;
    link.hidden = false;
  } catch {
    link.hidden = true;
    link.removeAttribute('href');
  }
}

function openRecords() {
  const groups = groupRecords([...state.records].reverse(), bookTitles);
  const active = groups.find(({ id }) => id === state.book.id) || groups[0];
  const titleFor = (group) => !group ? '讲课问答录' : `${group.title.slice(0, 105)}问答录`;
  $('record-title').value = titleFor(active);
  const selection = new Set((active?.records || []).map(({ id }) => id));
  function recordRow(record) {
    const row = element('li', null, 'record-entry');
    const label = element('label', null, 'checkbox');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.value = record.id;
    check.checked = selection.has(record.id);
    label.append(check, element('span', `选中问答 ${record.question}`, 'sr-only'));
    const detail = element('details');
    const summary = element('summary', record.question);
    summary.append(element('small', formatDate(record.date)));
    const body = element('div', null, 'record-answer');
    detail.append(summary, body);
    detail.addEventListener('toggle', () => {
      if (!detail.open || body.childNodes.length) return;
      const answer = element('div');
      body.append(...currentReferences(record.references, record.bookId, bookTitles).map(referenceDetails), answer);
      renderAnswer(answer, record.answer);
    });
    row.append(label, detail);
    return row;
  }
  $('record-list').replaceChildren(...groups.map((group) => {
    const row = element('li');
    const detail = element('details', null, 'record-book');
    detail.open = group === active;
    const summary = element('summary', group.title);
    summary.append(element('small', `${group.records.length} 条`));
    const select = button('仅选本书', () => {
      const ids = new Set(group.records.map(({ id }) => id));
      for (const checkbox of $('record-list').querySelectorAll('input')) checkbox.checked = ids.has(checkbox.value);
      $('record-title').value = titleFor(group);
      resetExportDisplay();
    }, 'outline');
    const entries = element('ol', null, 'record-entries');
    entries.append(...group.records.map(recordRow));
    detail.append(summary, select, entries);
    row.append(detail);
    return row;
  }));
  if (!state.records.length) $('record-list').append(element('li', '完成一次提问后，问题、引用和讲解会自动收入这里。'));
  resetExportDisplay();
  $('records').showModal();
}

function resetExportDisplay() {
  updateRecordSelection();
  showFeishu('');
  status('export-status');
  $('export-feishu').textContent = '保存到飞书';
}

async function exportWord() {
  if (exportBusy) return;
  exportBusy = true;
  updateRecordSelection();
  try {
    const { title, records } = exportOptions();
    const { downloadWord } = await import('./word.js');
    const saved = await downloadWord(title, records);
    status('export-status', saved ? (nativeApp ? 'Word 已保存。' : 'Word 下载已发起。') : '');
  } catch (error) { status('export-status', error.message); }
  finally { exportBusy = false; updateRecordSelection(); }
}

async function exportFeishu() {
  const action = $('export-feishu');
  if (exportBusy) return;
  exportBusy = true;
  updateRecordSelection();
  try {
    const { title, records } = exportOptions();
    const destination = getConnections().feishu.folder || 'server';
    const signature = JSON.stringify([title, destination, records.map((record) => renamedBooks.has(record.bookId)
      ? [record.id, record.bookTitle, ...record.references.map((ref) => ref.book)] : record.id)]);
    const prior = state.exports.find((item) => item.signature === signature);
    if (prior?.complete) {
      showFeishu(prior.url);
      status('export-status', '这批问答已保存。');
      return;
    }
    if (!state.config.feishu && !getConnections().feishu.appId) {
      $('records').close();
      openSettings('feishu');
      feedback('请配置飞书应用和目标文件夹后再保存。');
      return;
    }
    status('export-status', '正在写入飞书云文档…');
    try {
      const { url } = await sendToFeishu({ title, records, resume: prior?.resume });
      rememberExport({ signature, url, complete: true });
      showFeishu(url);
      status('export-status', '问答录已保存到飞书云文档。');
    } catch (error) {
      if (error.details?.resume) {
        const { url, resume } = error.details;
        rememberExport({ signature, url, resume });
        showFeishu(url);
        action.textContent = '继续保存';
      }
      throw error;
    }
  } catch (error) { status('export-status', error.message); }
  finally { exportBusy = false; updateRecordSelection(); }
}

function rememberExport(item) {
  state.exports = [item, ...state.exports.filter((prior) => prior.signature !== item.signature)].slice(0, 40);
  saveState('feishuExports', state.exports).catch(() => {});
}

async function exportPdf(cloud) {
  const localButton = $('pdf-save-local');
  const cloudButton = $('pdf-save-cloud');
  const output = $('pdf-save-status');
  const link = $('pdf-cloud-link');
  localButton.disabled = cloudButton.disabled = true;
  output.textContent = '正在合成带批注的 PDF…';
  link.hidden = true;
  try {
    const { annotatedFilename, buildAnnotatedPdf, savePdfOnDevice } = await import('./pdf-export.js');
    const filename = annotatedFilename(reader.book.title);
    const blob = await buildAnnotatedPdf(reader, (page, total) => {
      output.textContent = `正在合成带批注的 PDF · ${page} / ${total} 页`;
    });
    if (cloud) {
      output.textContent = '正在上传 PDF 到飞书…';
      const result = await sendPdfToFeishu(filename, blob);
      link.href = result.url;
      link.hidden = false;
      output.textContent = '批注 PDF 已上传到设置中的飞书文件夹。';
    } else {
      const saved = await savePdfOnDevice(blob, filename);
      output.textContent = saved ? '已保存批注 PDF。' : '';
    }
  } catch (error) {
    output.textContent = error.message;
  } finally {
    localButton.disabled = cloudButton.disabled = false;
  }
}

for (const target of document.querySelectorAll('.mobile-tabs button')) target.onclick = () => showPanel(target.dataset.panel);
for (const target of document.querySelectorAll('[data-close]')) target.onclick = () => target.closest('dialog').close();
$('pdf-open').onclick = () => $('pdf-file').click();
$('book-fullscreen').onclick = () => setBookFullscreen(!$('workspace').hasAttribute('data-book-fullscreen'));
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (!$('class-board').hidden) $('board-close').click();
  else setBookFullscreen(false);
});
$('library-open').onclick = () => openLibrary().catch(failure);
$('book-tab-add').onclick = () => openLibrary().catch(failure);
$('library-import').onclick = () => { $('library').close(); $('pdf-file').click(); };
$('pdf-file').onchange = (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  importBooks(files).catch(failure);
};
$('settings-open').onclick = openSettings;
$('finger-ink').onchange = (event) => {
  reader.fingerInk = event.target.checked;
  saveState('fingerInk', reader.fingerInk).catch(() => feedback('手指书写设置仅在本次打开期间生效。'));
};
$('app-version').textContent = '当前版本 v' + version;
$('settings-changelog').addEventListener('toggle', () => {
  const section = $('settings-changelog-content');
  if ($('settings-changelog').open && !section.hasChildNodes()) {
    renderAnswer(section, changelog.replace(/^# 更新日志\s*/, ''));
  }
});
if (import.meta.env.MODE === 'android') {
  $('check-update').hidden = false;
  $('pen-input-test').hidden = false;
  const penButton = $('pen-test-start');
  const bindButton = $('pen-test-bind');
  const penStatus = $('pen-test-status');
  const penResult = $('pen-test-result');
  let penTest;
  let penTimer;
  let penGeneration = 0;
  const endPenTest = (cancelled = true) => {
    penGeneration++;
    clearTimeout(penTimer);
    if (cancelled) penTest?.stop();
    penTest = undefined;
    penButton.disabled = false;
    bindButton.hidden = true;
    penStatus.textContent = '';
  };
  $('settings').addEventListener('close', () => endPenTest());
  $('pen-input-test').addEventListener('toggle', () => {
    if (!$('pen-input-test').open) endPenTest();
  });
  penButton.onclick = async () => {
    const generation = ++penGeneration;
    penButton.disabled = true;
    penResult.hidden = true;
    bindButton.hidden = true;
    penStatus.textContent = '准备开始…';
    try {
      const { androidPenTest } = await import('./harmony.js');
      const test = await androidPenTest();
      if (generation !== penGeneration || !$('settings').open || !$('pen-input-test').open) return;
      penTest = test;
      penTest.start();
      penTimer = setTimeout(() => {
        endPenTest();
        penStatus.textContent = '测试超时，可以再试一次。';
      }, 16000);
    } catch (error) {
      if (generation !== penGeneration) return;
      endPenTest();
      penStatus.textContent = error.message;
    }
  };
  window.addEventListener('lecture-desk-native', (event) => {
    const detail = event.detail;
    if (detail?.kind === 'pen-test-binding' && $('settings').open && $('pen-input-test').open) {
      bindButton.hidden = true;
      penStatus.textContent = detail.value;
    }
    if (!penTest) return;
    if (detail?.kind === 'pen-test-step') {
      const step = Number(detail.value);
      penStatus.textContent = step === 0
        ? '把笔尖悬停在屏幕附近，轻轻移动，先不要捏笔身。'
        : `第 ${step} / 3 次。保持笔尖悬停，现在轻捏笔身一下。`;
    }
    if (detail?.kind === 'pen-test-result') {
      endPenTest(false);
      const result = JSON.parse(detail.value);
      bindButton.hidden = !result.canBind;
      penStatus.textContent = result.direct ? '检测到标准笔身按键。关闭设置后轻捏试用。'
        : result.canBind ? '检测到随提示重复出现的轻捏信号。绑定后可关闭设置试用。'
          : '未找到可绑定的轻捏信号。可以重试，或把下方的分段结果发给我。';
      penResult.textContent = result.log;
      penResult.hidden = false;
    }
  });
  bindButton.onclick = async () => {
    bindButton.hidden = true;
    try {
      const { androidPenTest } = await import('./harmony.js');
      const test = await androidPenTest();
      if ($('settings').open && $('pen-input-test').open) test.bind();
    } catch (error) { penStatus.textContent = error.message; }
  };
  $('pen-test-clear').onclick = async () => {
    endPenTest();
    penResult.hidden = true;
    try {
      const { androidPenTest } = await import('./harmony.js');
      const test = await androidPenTest();
      if ($('settings').open && $('pen-input-test').open) test.clear();
    } catch (error) { penStatus.textContent = error.message; }
  };
  $('check-update').onclick = async () => {
    try {
      const { checkAndroidUpdate } = await import('./harmony.js');
      await checkAndroidUpdate();
    } catch (error) { failure(error); }
  };
}
$('pdf-export').onclick = () => {
  $('pdf-save-status').textContent = '';
  $('pdf-cloud-link').hidden = true;
  $('pdf-save-dialog').showModal();
};
$('pdf-save-close').onclick = () => $('pdf-save-dialog').close();
$('pdf-save-local').onclick = () => exportPdf(false);
$('pdf-save-cloud').onclick = () => exportPdf(true);
$('pdf-cloud-setup').onclick = () => {
  $('pdf-save-dialog').close();
  openSettings('feishu');
};
$('teacher-style-mode').onchange = (event) => {
  $('teacher-style-field').hidden = event.target.value !== 'custom';
};
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  const trim = (id) => $(id).value.trim();
  const feishu = { appId: trim('feishu-id'), secret: trim('feishu-secret'), folder: trim('feishu-folder') };
  const parts = Object.values(feishu).filter(Boolean).length;
  if (parts && parts !== 3) {
    feedback('飞书 App ID、App Secret 和文件夹链接都需要填写。');
    return;
  }
  const deepseek = trim('deepseek-key');
  if (deepseek !== savedKey) {
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      await rememberDeepSeekKey(deepseek);
      savedKey = deepseek;
      credentialError = '';
    } catch {
      credentialError = 'DeepSeek API Key 无法保存到本机，本次打开期间仍可使用。';
    } finally { if (submit) submit.disabled = false; }
  }
  saveConnections({ access: trim('access-code'), deepseek, feishu });
  teachingPreferences = { profile: trim('learner-profile'), mode: $('teacher-style-mode').value,
    style: trim('teacher-style') };
  const preferencesSaved = await saveState('teachingPreferences', teachingPreferences).then(() => true).catch(() => false);
  $('settings').close();
  await refreshConfiguration();
  feedback(state.config.requiresCode && !state.config.authorized ? '局域网口令不正确。' :
    credentialError || (preferencesSaved ? '设置已应用。' : '本机未能保存用户画像与回复风格，本次打开期间仍可使用。'));
};
$('records-open').onclick = openRecords;
$('record-list').onchange = resetExportDisplay;
$('record-title').oninput = resetExportDisplay;
$('export-docx').onclick = exportWord;
$('export-feishu').onclick = exportFeishu;
$('stop').onclick = () => state.stream?.abort();
$('ask').onsubmit = (event) => {
  event.preventDefault();
  voice.cancel();
  ask($('question').value).catch(failure);
};
$('question').onkeydown = (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('ask').requestSubmit();
};
$('teach-page').onclick = () => teach('请按课堂节奏讲解当前页，先梳理重点再给出例子。');
$('teach-next').onclick = () => teach('请接着上一页，讲解当前页的新内容。', true);
for (const target of document.querySelectorAll('[data-suggest]')) target.onclick = () => teach(target.dataset.suggest);

reader = new Reader({ quote: addExcerpt, notify: feedback, change: syncChat, error: failure });
const fingerInkReady = readState('fingerInk').catch(() => false).then((value) => { reader.fingerInk = value; });
installDividers();
installScrollThumb($('reader'));
installScrollThumb($('chat-scroll'));
installTheme();
const whiteboard = installWhiteboard({ notify: feedback, allowFingerInk: () => reader.fingerInk });
installPenShortcuts({ reader, whiteboard, showBook: () => showPanel('book') });
if (nativeApp) $('export-docx').textContent = '保存 Word';
async function initialize() {
  await credentialsReady;
  refreshConfiguration();
  const [bookId, records, exports, tabIds, books, names] = await Promise.all([
    readState('activeBook').catch(() => null),
    listRecords().catch(() => []),
    readState('feishuExports').catch(() => []),
    readState('openBooks').catch(() => []),
    listBooks().catch(() => []),
    readState('renamedBooks').catch(() => []),
  ]);
  state.exports = exports || [];
  state.records = records.sort((a, b) => a.date.localeCompare(b.date));
  $('record-count').textContent = state.records.length;
  renamedBooks = new Map(names || []);
  for (const [id, title] of renamedBooks) bookTitles.set(id, title);
  const available = new Map([sample, ...books].map((item) => {
    item.title = renamedBooks.get(item.id) || item.title;
    return [item.id, item];
  }));
  for (const { id, title } of available.values()) bookTitles.set(id, title);
  openBooks = Array.isArray(tabIds) ? [...new Set(tabIds)].map((id) => available.get(id)).filter(Boolean) : [];
  const book = available.get(bookId) || openBooks[0] || sample;
  try { await activateBook(book || sample); }
  catch (error) {
    failure(error);
    if (book && book.id !== sample.id) await activateBook(sample).catch(failure);
  }
}
const bookReady = initialize().catch(failure);
