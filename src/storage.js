let database;

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('lecture-desk', 3);
    request.onupgradeneeded = ({ oldVersion }) => {
      if (!oldVersion) {
        request.result.createObjectStore('books', { keyPath: 'id' });
        request.result.createObjectStore('state');
      }
      if (oldVersion < 2) request.result.createObjectStore('records', { keyPath: 'id' });
      if (oldVersion < 3) request.result.createObjectStore('notes', { keyPath: 'id' });
    };
    // Another tab still holding the old version blocks this upgrade; surface it
    // instead of leaving every storage call hanging forever.
    request.onblocked = () => reject(new Error('本地存储被其他标签页占用，请关闭其他讲课台页面后刷新。'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function run(store, method, args, mode = 'readonly') {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = transaction.objectStore(store)[method](...args);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error('本地存储已中断'));
  });
}

export const listBooks = () => run('books', 'getAll', []);
export const getBook = (id) => run('books', 'get', [id]);
export const saveBook = (book) => run('books', 'put', [book], 'readwrite');
export const removeBook = (id) => run('books', 'delete', [id], 'readwrite');
export const readState = (key) => run('state', 'get', [key]);
export const saveState = (key, value) => run('state', 'put', [value, key], 'readwrite');
export const listRecords = () => run('records', 'getAll', []);
export const saveRecord = (record) => run('records', 'put', [record], 'readwrite');
export const listNotes = () => run('notes', 'getAll', []);
export const getNote = (id) => run('notes', 'get', [id]);
export const saveNote = (note) => run('notes', 'put', [note], 'readwrite');
export const removeNote = (id) => run('notes', 'delete', [id], 'readwrite');

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
