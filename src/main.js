import './styles.css';
import { Reader } from './reader.js';
import { listBooks, listRecords, newId, readState, removeBook, saveBook, saveRecord, saveState } from './storage.js';
import { getConfiguration, getConnections, saveConnections, sendPdfToFeishu, sendToFeishu, streamAnswer } from './api.js';
import { formatDate, sourceLabel } from './records.js';
import { installDividers } from './layout.js';
import { installWhiteboard } from './whiteboard.js';
import { installTheme } from './theme.js';
import { installVoice } from './voice.js';
import { nativeApp } from './platform.js';
import { bookFormat, formats } from './book-format.js';

const $ = (id) => document.getElementById(id);
const sample = { id: 'sample', title: '函数与图像', sample: true };
const state = { book: sample, records: [], references: [], exports: [], config: {}, failed: null };
const drafts = new Map();
let openBooks = [];
const voice = installVoice();
let reader;
let toastTimeout;
let changingBook;

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
    const detail = element('details');
    detail.append(element('summary', sourceLabel(ref)), element('p', ref.text));
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
  if (reference.text.length > 24000) {
    throw new Error('摘录超过 24,000 字，请分段框选。');
  }
  if (state.references.some((ref) => ref.book === reference.book && ref.page === reference.page && ref.text === reference.text)) {
    feedback('这段文字已经加入本次提问。');
    return;
  }
  if (state.references.length >= 8) throw new Error('单次提问最多包含 8 段摘录，请先移除一段。');
  state.references.push(reference);
  displayExcerpts();
  feedback('已引用，可以在右侧提问。');
  showPanel('chat');
}

function referenceDetails(reference) {
  const detail = element('details', null, 'citation');
  detail.append(element('summary', sourceLabel(reference)), element('blockquote', reference.text));
  return detail;
}

function userCard({ question, references }) {
  const item = element('li', null, 'message user');
  item.append(element('span', '你', 'message-label'), element('p', question), ...references.map(referenceDetails));
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
  nav.replaceChildren(...openBooks.map((book) => {
    const selected = book.id === state.book.id;
    const item = element('div', null, 'book-tab');
    item.dataset.selected = String(selected);
    const pick = button(book.title, () => {
      showPanel('book');
      if (!selected) activateBook(book).catch(failure);
    });
    pick.title = book.title;
    pick.setAttribute('aria-current', String(selected));
    if (selected) active = pick;
    const close = button('×', () => closeBookTab(book.id).catch(failure));
    close.setAttribute('aria-label', `关闭《${book.title}》标签页`);
    item.append(pick, close);
    return item;
  }));
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

async function importBook(file) {
  if (!file) return;
  if (state.stream) {
    feedback('请先结束当前讲解，再导入课本。');
    return;
  }
  const extension = bookFormat(file);
  if (!extension) {
    feedback('请选择 PDF、Word（.docx、.doc）或 PPT（.pptx、.ppt）文件。');
    return;
  }
  const title = file.name.replace(new RegExp(`\\.${extension}$`, 'i'), '').slice(0, 290) || '未命名课件';
  const book = { id: newId(), title, file, extension, imported: Date.now() };
  showPanel('book');
  if (!await activateBook(book)) return;
  try {
    await saveBook(book);
    if (state.book.id === book.id) await saveState('activeBook', book.id);
    feedback('课本已保存到本机书架。');
  } catch {
    feedback('本机存储空间不足，当前课本仅在本次页面中可用。');
  }
}

async function openLibrary() {
  const books = await listBooks().catch(() => []);
  const rows = [sample, ...books.sort((a, b) => b.imported - a.imported)].map((book) => {
    const row = element('div', null, 'book-row');
    const pick = button(book.title + (book.sample ? ' · 示例课' : ''), async () => {
      $('library').close();
      showPanel('book');
      if (book.id !== state.book.id) await activateBook(book).catch(failure);
    });
    pick.title = book.title;
    row.append(pick);
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

function openSettings(section) {
  const settings = getConnections();
  $('pass-label').hidden = !state.config.requiresCode;
  $('credential-fields').hidden = !state.config.canSupplyCredentials;
  $('feishu-fields').hidden = !state.config.canSupplyCredentials;
  $('feishu-browser-help').hidden = !state.config.canSupplyCredentials;
  $('feishu-local-help').hidden = Boolean(state.config.canSupplyCredentials);
  $('configuration-hint').textContent = nativeApp ?
    '凭据只在本次打开应用期间使用。课本和批注保存在平板，提问时只发送问题和引用。' :
    state.config.canSupplyCredentials ?
      '凭据只在这次页面会话中使用。课件和批注保存在当前设备，提问时只发送问题和引用。' :
      '局域网 HTTP 由电脑端的 .env 提供 API 凭据。平板上的课本和批注保存在平板。';
  $('access-code').value = settings.access;
  $('deepseek-key').value = settings.deepseek;
  $('feishu-id').value = settings.feishu.appId || '';
  $('feishu-secret').value = settings.feishu.secret || '';
  $('feishu-folder').value = settings.feishu.folder || '';
  $('finger-ink').checked = Boolean(reader.fingerInk);
  if (section === 'feishu') {
    $('feishu-settings').open = true;
    $('feishu-guide').open = true;
  }
  if (!$('settings').open) $('settings').showModal();
}

function precedingTurns(question, references) {
  const candidates = state.records.filter((record) => record.bookId === state.book.id).slice(-8).reverse();
  const turns = [];
  const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  let room = 900000 - size({ question, references });
  for (const record of candidates) {
    const turn = { question: record.question, answer: record.answer, references: record.references };
    room -= size(turn);
    if (room < 0) break;
    turns.unshift(turn);
  }
  return turns;
}

async function ask(question, references = state.references) {
  if (state.stream || changingBook) return;
  question = question.trim() || (references.length ? '请讲解这段课本内容。' : '');
  if (!question) {
    status('chat-status', '请输入问题，或先引用一段课本。');
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

  const record = { id: newId(), bookId: state.book.id, date: new Date().toISOString(), question, references: [...references] };
  const controller = new AbortController();
  state.stream = controller;
  state.failed?.forEach((node) => node.remove());
  state.failed = null;
  state.references = [];
  $('question').value = '';
  displayExcerpts();
  status('chat-status');
  const user = userCard(record);
  const { item, content } = assistantCard();
  $('welcome').hidden = true;
  $('messages').append(user, item);
  scrollToEnd();
  syncChat();
  let answer = '';
  try {
    const history = precedingTurns(question, references);
    answer = await streamAnswer({ question, references, history }, (text) => {
      answer = text;
      const scroll = $('chat-scroll');
      const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
      content.textContent = text;
      if (wasNearBottom) scrollToEnd();
    }, controller.signal);
    record.answer = answer;
    state.records.push(record);
    $('record-count').textContent = state.records.length;
    await renderAnswer(content, answer);
    await saveRecord(record).catch(() => feedback('问答暂存在内存，可以立即导出问答录。'));
  } catch (error) {
    const stopped = error.name === 'AbortError';
    const note = stopped ? '本次讲解已停止。' : error.message;
    status('chat-status', note);
    content.textContent = answer ? `${answer}\n\n${note} 这条讲解未收入问答录。` : note;
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
  $('teach-page').disabled = true;
  $('teach-next').disabled = true;
  try {
    if (next) await reader.setPage(reader.page + 1);
    const ref = await reader.quotePage();
    if (ref.text.length > 24000) throw new Error('本页文字过多，请分段引用后提问。');
    await ask(question, [ref]);
  } catch (error) {
    failure(error);
  } finally {
    syncChat();
  }
}

function selectedRecords() {
  const ids = new Set([...$('record-list').querySelectorAll('input:checked')].map((input) => input.value));
  return state.records.filter((record) => ids.has(record.id));
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
  $('record-title').value = state.book.sample ? '讲课问答录' : `${state.book.title.slice(0, 105)}问答录`;
  $('record-list').replaceChildren(...state.records.map((record) => {
    const row = element('li');
    const label = element('label', null, 'checkbox');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.value = record.id;
    check.checked = record.bookId === state.book.id;
    label.append(check, element('strong', record.question));
    const sources = record.references.map(({ book, page }) => `${book} 第 ${page} 页`).join('、');
    row.append(label, element('small', [formatDate(record.date), sources].filter(Boolean).join(' · ')),
      element('p', record.answer.length > 170 ? record.answer.slice(0, 170) + '…' : record.answer));
    return row;
  }));
  if (!state.records.length) $('record-list').append(element('li', '完成一次提问后，问题、引用和讲解会自动收入这里。'));
  $('export-docx').disabled = $('export-feishu').disabled = !state.records.length;
  resetExportDisplay();
  $('records').showModal();
}

function resetExportDisplay() {
  showFeishu('');
  status('export-status');
  $('export-feishu').textContent = '保存到飞书';
}

async function exportWord() {
  const action = $('export-docx');
  action.disabled = true;
  try {
    const { title, records } = exportOptions();
    const { downloadWord } = await import('./word.js');
    const saved = await downloadWord(title, records);
    status('export-status', saved ? (nativeApp ? 'Word 已保存。' : 'Word 下载已发起。') : '');
  } catch (error) { status('export-status', error.message); }
  finally { action.disabled = !state.records.length; }
}

async function exportFeishu() {
  const action = $('export-feishu');
  action.disabled = true;
  try {
    const { title, records } = exportOptions();
    const destination = getConnections().feishu.folder || 'server';
    const signature = JSON.stringify([title, destination, records.map((record) => record.id)]);
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
  finally { action.disabled = !state.records.length; }
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
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setBookFullscreen(false);
});
$('library-open').onclick = () => openLibrary().catch(failure);
$('book-tab-add').onclick = () => openLibrary().catch(failure);
$('library-import').onclick = () => { $('library').close(); $('pdf-file').click(); };
$('pdf-file').onchange = (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  importBook(file).catch(failure);
};
$('settings-open').onclick = openSettings;
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
$('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  const trim = (id) => $(id).value.trim();
  const feishu = { appId: trim('feishu-id'), secret: trim('feishu-secret'), folder: trim('feishu-folder') };
  const parts = Object.values(feishu).filter(Boolean).length;
  if (parts && parts !== 3) {
    feedback('飞书 App ID、App Secret 和文件夹链接都需要填写。');
    return;
  }
  saveConnections({ access: trim('access-code'), deepseek: trim('deepseek-key'), feishu });
  reader.fingerInk = $('finger-ink').checked;
  saveState('fingerInk', reader.fingerInk).catch(() => {});
  $('settings').close();
  await refreshConfiguration();
  feedback(state.config.requiresCode && !state.config.authorized ? '局域网口令不正确。' : '设置已应用。');
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
installDividers();
installTheme();
installWhiteboard({ notify: feedback });
if (nativeApp) $('export-docx').textContent = '保存 Word';
async function initialize() {
  refreshConfiguration();
  const [bookId, records, fingerInk, exports, tabIds, books] = await Promise.all([
    readState('activeBook').catch(() => null),
    listRecords().catch(() => []),
    readState('fingerInk').catch(() => false),
    readState('feishuExports').catch(() => []),
    readState('openBooks').catch(() => []),
    listBooks().catch(() => []),
  ]);
  reader.fingerInk = fingerInk;
  state.exports = exports || [];
  state.records = records.sort((a, b) => a.date.localeCompare(b.date));
  $('record-count').textContent = state.records.length;
  const available = new Map([sample, ...books].map((item) => [item.id, item]));
  openBooks = Array.isArray(tabIds) ? [...new Set(tabIds)].map((id) => available.get(id)).filter(Boolean) : [];
  const book = available.get(bookId) || openBooks[0] || sample;
  try { await activateBook(book || sample); }
  catch (error) {
    failure(error);
    if (book && book.id !== sample.id) await activateBook(sample).catch(failure);
  }
}
initialize().catch(failure);
