let database;

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('lecture-desk', 2);
    request.onupgradeneeded = ({ oldVersion }) => {
      if (!oldVersion) {
        request.result.createObjectStore('books', { keyPath: 'id' });
        request.result.createObjectStore('state');
      }
      if (oldVersion < 2) request.result.createObjectStore('records', { keyPath: 'id' });
    };
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

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
